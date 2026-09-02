'use strict';

// Keeps one lock reachable and its state current.
//
// The connection is held open so the lock can push changes — the outcome of a
// command once the motor has run, and keypad or manual operation that nothing
// asked about. That is the only way to learn about a change promptly, but it
// costs battery and, because these locks accept a single connection, it keeps
// the phone app out while held. `release()` exists so callers can hand the lock
// back deliberately.
//
// Everything here is serialised: BLE gives one connection, one command at a
// time, so commands queue rather than interleave.

const { EventEmitter } = require('events');

const ble = require('./ble/lock');
const locks = require('./locks');
const { withAdapter } = require('./ble/adapter');
const { explainHciError } = require('./ble/probe');

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const SCAN_TIMEOUT_MS = 15000;
// A slow safety net: pushes are the point, this only catches what they miss.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

class LockController extends EventEmitter {
  constructor(credential, { log = console, refreshIntervalMs = REFRESH_INTERVAL_MS } = {}) {
    super();
    this.credential = credential;
    this.name = credential.name;
    this.log = log;
    this.refreshIntervalMs = refreshIntervalMs;

    this.session = null;
    this.state = null;
    this.connected = false;

    this._stopped = true;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._refreshTimer = null;
    this._connecting = null;
    this._commandDepth = 0;
    this._connectedAt = null;
    this._establishing = null;
    this._queue = Promise.resolve();
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect().catch(() => {});
  }

  // Must return promptly. Homebridge does not await its shutdown hook and kills
  // the child bridge a few seconds later, and a connection killed rather than
  // released leaves a stale link on the adapter that stops the next process
  // reaching the lock. So tear down now; an in-flight attempt is not waited on,
  // it checks `_stopped` at each step and closes anything it opened.
  async stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._refreshTimer);
    this._reconnectTimer = this._refreshTimer = null;
    await this._teardown();
  }

  // Hand the lock back so a phone can talk to it; reconnects afterwards.
  async release(quietMs = 30000) {
    await this._teardown();
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect().catch(() => {}), quietMs);
  }

  async _teardown() {
    // `_establishing` matters as much as `session`: setup only assigns
    // `session` at the very end, so a connect still in progress would
    // otherwise be left holding a link nothing closes.
    const sessions = new Set([this.session, this._establishing].filter(Boolean));
    this.session = null;
    this._establishing = null;
    this._connectedAt = null;

    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
    for (const session of sessions) await session.close().catch(() => {});
  }

  // Guarded so overlapping callers share one attempt. Without this, a command
  // arriving while the first connect is still in flight would open a second
  // connection to the same lock and the two would corrupt each other.
  _connect() {
    if (this._stopped) return Promise.resolve();
    if (this.session && this.session.open) return Promise.resolve();
    if (this._connecting) return this._connecting;

    this._connecting = this._doConnect().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _doConnect() {
    if (this._stopped || (this.session && this.session.open)) return;

    try {
      // Scanning is a global adapter mode and overlapping connects are rejected
      // by the HCI layer, so only one lock may be set up at a time. Established
      // connections coexist fine — it is only the setup that must not overlap.
      await withAdapter(() => this._establish());
    } catch (err) {
      await this._teardown();
      this._scheduleReconnect(err);
    }
  }

  // Prefer connecting straight to the known address: it needs no scan, so it
  // avoids the adapter's scan/connect mode switching and the Linux binding's
  // habit of losing track of a scanned peripheral ("unknown peripheral <id>",
  // after which the connect never resolves). Scanning stays as the fallback,
  // and is the only option where no address is known — macOS hides them.
  _reach() {
    return locks.reachLock(this.credential, {
      debug: (msg) => this.log.debug?.(`${this.name}: ${msg}`),
    });
  }

  async _establish() {
    // Checked at each step so a shutdown mid-connect abandons the attempt and
    // closes whatever it opened, rather than leaving a link on the adapter.
    let opened = null;
    const abandoned = async () => {
      if (!this._stopped) return false;
      if (opened) await opened.close().catch(() => {});
      return true;
    };

    if (await abandoned()) return;

    const { peripheral, connected } = await this._reach();
    if (await abandoned()) return;

    const session = new ble.LockSession(peripheral, this.credential, {
      debug: (msg) => this.log.debug?.(`${this.name}: ${msg}`),
    });
    session.on('state', (state) => {
      const previous = this.state;
      this.state = state;

      // A change with no command of ours in flight came from the lock itself:
      // the keypad, a fingerprint, or the thumbturn. Worth a log line, since
      // it is the one event nothing else here would record.
      if (previous && previous.state !== state.state && !this._commandDepth) {
        this.log.info?.(`${this.name}: ${state.state.toLowerCase()} at the lock`);
      }
      this.emit('state', state);
    });
    session.on('disconnect', () => this._onDropped());
    session.on('error', (err) => this.log.debug?.(`${this.name}: ${err.message}`));

    // Tracked from construction, not after connect(): a failure part-way
    // through connect() still has to be closed. noble hands back the same
    // peripheral object every scan, so a session left open keeps its listener
    // attached and its link half-established, and the next attempt inherits
    // both — which is how one failure turns into a run of them.
    opened = session;
    this._establishing = session;

    try {
      await session.connect({ connected });
      // Stamped the moment the link exists, so a drop during login still
      // reports how long it survived.
      this._connectedAt = Date.now();
      if (await abandoned()) return;

      this.log.debug?.(`${this.name}: logging in`);
      await session.login();
      if (await abandoned()) return;

      this.session = session;
      this.connected = true;
      this._attempt = 0;

      // Establish state immediately; pushes carry it from here.
      const state = await ble.readStatus(session);
      this.state = state;
      this.emit('state', state);
      this.emit('connected');
      this.log.info?.(`${this.name}: connected, ${state.state.toLowerCase()}`);

      clearInterval(this._refreshTimer);
      this._refreshTimer = setInterval(() => this._refresh(), this.refreshIntervalMs);
    } catch (err) {
      // Release the link and drop the listener before anyone retries.
      await session.close().catch(() => {});
      if (this.session === session) this.session = null;
      throw err;
    } finally {
      if (this._establishing === session) this._establishing = null;
    }
  }

  _onDropped() {
    if (this._stopped) return;
    this.session = null;

    // How long the link survived is the thing worth knowing. A few seconds
    // every time means the lock is closing idle connections to save battery,
    // and holding one open is the wrong design for this hardware. Minutes or
    // hours means ordinary radio flakiness.
    const held = this._connectedAt ? Math.round((Date.now() - this._connectedAt) / 1000) : null;
    this._connectedAt = null;

    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
    clearInterval(this._refreshTimer);
    this._scheduleReconnect(
      new Error(held === null ? 'connection dropped' : `connection dropped after ${held}s`)
    );
  }

  // Exponential backoff, capped — a lock that is asleep or out of range should
  // not be hammered, and each attempt costs its battery.
  _scheduleReconnect(rawError) {
    if (this._stopped || this._reconnectTimer) return;

    const err = explainHciError(rawError);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._attempt, RECONNECT_MAX_MS);
    this._attempt += 1;
    this.log.debug?.(`${this.name}: ${err.message}; retrying in ${Math.round(delay / 1000)}s`);
    this.emit('unreachable', err);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch(() => {});
    }, delay);
  }

  async _refresh() {
    try {
      await this.read();
    } catch (err) {
      this.log.debug?.(`${this.name}: refresh failed (${err.message})`);
    }
  }

  // Serialise work: one BLE connection means one command at a time.
  _enqueue(job) {
    const run = this._queue.then(job, job);
    // Keep the chain alive regardless of individual failures.
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _withSession(fn) {
    if (!this.session || !this.session.open) {
      // Try once, now, rather than waiting for the backoff timer.
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      await this._connect();
    }
    if (!this.session || !this.session.open) {
      throw new Error(`${this.name} is not reachable`);
    }
    return fn(this.session);
  }

  read() {
    return this._enqueue(() =>
      this._withSession(async (session) => {
        const state = await ble.readStatus(session);
        this.state = state;
        this.emit('state', state);
        return state;
      })
    );
  }

  set(locked) {
    return this._enqueue(() =>
      this._withSession(async (session) => {
        // Marks our own changes, so they are not reported as keypad use.
        this._commandDepth += 1;
        try {
          const result = await ble.setBolt(session, locked);
          if (result.state) {
            this.state = result.state;
            this.emit('state', result.state);
          }
          return result;
        } finally {
          this._commandDepth -= 1;
        }
      })
    );
  }

  lock() {
    return this.set(true);
  }

  unlock() {
    return this.set(false);
  }
}

module.exports = { LockController, REFRESH_INTERVAL_MS };
