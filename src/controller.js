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
    const session = this.session;
    this.session = null;
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
    if (session) await session.close().catch(() => {});
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

    const found = await locks.findLocks([this.credential], { timeoutMs: SCAN_TIMEOUT_MS });
    if (await abandoned()) return;

    const peripheral = found.get(this.name);
    if (!peripheral) throw new Error(locks.notFoundHint(this.credential));

    const session = new ble.LockSession(peripheral, this.credential);
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

    await session.connect();
    opened = session;
    if (await abandoned()) return;

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
  }

  _onDropped() {
    if (this._stopped) return;
    this.session = null;
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
    clearInterval(this._refreshTimer);
    this._scheduleReconnect(new Error('connection dropped'));
  }

  // Exponential backoff, capped — a lock that is asleep or out of range should
  // not be hammered, and each attempt costs its battery.
  _scheduleReconnect(err) {
    if (this._stopped || this._reconnectTimer) return;

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
