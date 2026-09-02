'use strict';

// A conversation with a lock: connect, agree a key, then exchange framed
// commands on the data characteristic.
//
// The subscription is opened once and held, because a lock reports changes
// nobody asked for — the outcome of a command once its motor has run, and a
// state change when someone uses the keypad. Frames are routed to whichever
// request is waiting for them; anything unclaimed is a push.

const { EventEmitter } = require('events');

const { canonUuid } = require('./probe');
const { establishKey, timeout } = require('./keyexchange');
const protocol = require('./protocol');

const CHAR_DATA = '7201';
const RESPONSE_TIMEOUT_MS = 15000;

// noble normalises Bluetooth-SIG base UUIDs to their short form.
const SERVICE_LOCK_SHORT = '7200';
// The data channel plus the three key-agreement variants; nothing else is read.
const WANTED_CHARACTERISTICS = ['7201', '7220', '7221', '7223'];

function envDebug(...args) {
  if (process.env.UTEC_DEBUG) console.error('[utec]', ...args);
}

function commandName(code) {
  return Object.keys(protocol.COMMANDS).find((k) => protocol.COMMANDS[k] === code) || code;
}

const STATUS_RESPONSE = protocol.COMMAND_RESPONSE[protocol.COMMANDS.LOCK_STATUS];

class LockSession extends EventEmitter {
  constructor(peripheral, credential, { debug } = {}) {
    super();
    this.peripheral = peripheral;
    this.credential = credential;
    // Under Homebridge the trace has to reach its logger to be seen at all.
    this.debug = debug || envDebug;
    this.key = null;
    this.keyKind = null;
    this.data = null;
    this.state = null;
    this.open = false;

    this._stream = null;
    this._pending = [];
    this._onData = (chunk) => {
      try {
        for (const frame of this._stream.push(chunk)) this._dispatch(frame);
      } catch (err) {
        this.emit('error', err);
      }
    };
    this._onDisconnect = () => {
      this.open = false;
      this._failPending(new Error('Lock disconnected.'));
      this.emit('disconnect');
    };
  }

  async connect() {
    // noble hands back the same peripheral object every scan, so it can arrive
    // still holding state from a previous attempt. Connecting on top of that
    // gives a link that reports up and then immediately fails, so settle it
    // first.
    const before = this.peripheral.state;
    if (before && before !== 'disconnected') {
      this.debug(`peripheral was "${before}"; settling it first`);
      await this.peripheral.disconnectAsync().catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
    }

    await this.peripheral.connectAsync();
    this.peripheral.once('disconnect', this._onDisconnect);
    this.debug(`link up to ${this.peripheral.id} (was "${before || 'unknown'}")`);

    // Setup steps wait on the lock answering, and each has its own timeout. If
    // the link dies underneath them they would otherwise sit out that full
    // timeout — 15s of nothing before a retry — so race every step against the
    // link going away and fail as soon as it does.
    const dropped = new Promise((_, reject) => {
      this.once('disconnect', () => reject(new Error('Lock dropped the link during setup.')));
    });
    dropped.catch(() => {}); // never an unhandled rejection when setup wins

    // Ask only for the lock service and the four characteristics that matter.
    // Enumerating everything means a round trip per characteristic — fourteen
    // on a U-Bolt Pro — and a lock that expects the key exchange to start
    // promptly will drop the link before that finishes.
    const started = Date.now();
    const characteristics = await Promise.race([this._discover(), dropped]);
    const byUuid = new Map(characteristics.map((c) => [canonUuid(c.uuid), c]));
    this.debug(`services discovered in ${Date.now() - started}ms (${characteristics.length} characteristics)`);

    this.data = byUuid.get(CHAR_DATA);
    if (!this.data) throw new Error('Lock has no data characteristic (7201).');

    const { kind, key } = await Promise.race([establishKey(byUuid), dropped]);
    this.key = key;
    this.keyKind = kind;
    this._stream = new protocol.FrameStream(key);
    this.debug(`key agreed via ${kind}`);

    this.data.on('data', this._onData);
    await Promise.race([this.data.subscribeAsync(), dropped]);
    this.open = true;
  }

  // Targeted discovery, falling back to a full enumeration if the lock does not
  // answer the narrow query — some firmware only supports the broad form.
  async _discover() {
    try {
      const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [SERVICE_LOCK_SHORT],
        WANTED_CHARACTERISTICS
      );
      if (characteristics && characteristics.length) return characteristics;
      this.debug('targeted discovery found nothing; enumerating everything');
    } catch (err) {
      this.debug(`targeted discovery failed (${err.message}); enumerating everything`);
    }

    const { characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    return characteristics;
  }

  // Any LOCK_STATUS is the freshest truth available, whoever prompted it.
  _dispatch(frame) {
    this.debug(`<- ${frame.commandName} status=${frame.statusByte} ${frame.raw.toString('hex')}`);

    if (frame.command === STATUS_RESPONSE) {
      const previous = this.state;
      this.state = protocol.parseLockStatus(frame);
      if (!previous || previous.state !== this.state.state) {
        this.emit('state', this.state, previous);
      }
    }

    const index = this._pending.findIndex((p) => p.expect === frame.command);
    if (index !== -1) {
      const waiter = this._pending.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    // Nobody asked for this one — a keypad entry, or a deferred outcome.
    this.emit('push', frame);
  }

  _discard(waiter) {
    const index = this._pending.indexOf(waiter);
    if (index !== -1) this._pending.splice(index, 1);
    clearTimeout(waiter.timer);
  }

  _failPending(err) {
    const waiting = this._pending.splice(0);
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  async request(command, { auth = false, data } = {}) {
    if (!this.open) throw new Error('Session is not open.');

    const expect = protocol.COMMAND_RESPONSE[command];
    let waiter;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._discard(waiter);
        reject(new Error(`Lock did not answer ${commandName(command)}.`));
      }, RESPONSE_TIMEOUT_MS);
      waiter = { expect, resolve, reject, timer };
      this._pending.push(waiter);
    });

    const packet = protocol.buildRequest(command, {
      uid: this.credential.uid,
      password: this.credential.password,
      auth,
      data,
    });
    this.debug(
      `-> ${commandName(command)} ` +
        protocol.redactedHex(packet, { uid: this.credential.uid, password: this.credential.password, auth })
    );

    try {
      await this.data.writeAsync(protocol.encrypt(packet, this.key), false);
    } catch (err) {
      // Drop the waiter, or its timer would later reject a promise nobody is
      // holding — an unhandled rejection, which would take Homebridge down.
      this._discard(waiter);
      answer.catch(() => {});
      throw err;
    }

    return answer;
  }

  async login() {
    return this.request(protocol.COMMANDS.ADMIN_LOGIN, { auth: true });
  }

  async close() {
    this.open = false;
    this._failPending(new Error('Session closed.'));
    this.peripheral.removeListener('disconnect', this._onDisconnect);
    if (this.data) {
      this.data.removeListener('data', this._onData);
      await this.data.unsubscribeAsync().catch(() => {});
    }
    await this.peripheral.disconnectAsync().catch(() => {});
  }
}

// One-shot use: open, log in, do the work, hang up.
async function withSession(peripheral, credential, fn) {
  const session = new LockSession(peripheral, credential);
  try {
    await session.connect();
    await session.login();
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function readStatus(session) {
  const frame = await session.request(protocol.COMMANDS.LOCK_STATUS);
  return protocol.parseLockStatus(frame);
}

// Read commands are accepted unauthenticated, but a U-Bolt Pro rejects an
// UNLOCK that carries no credentials (status byte 1) even after a successful
// ADMIN_LOGIN — so the uid and password go in the actuating packet itself.
// utecio never does this: its auth_required flag is never set by any caller.
//
// The unauthenticated form is kept as a fallback for firmware that wants it.
// A rejected command does nothing, so trying both is safe.
const BOLT_AUTH_MODES = [true, false];

// Reports what the lock actually said rather than asserting an outcome; the
// state read back afterwards is the ground truth.
async function setBolt(session, locked, { authModes = BOLT_AUTH_MODES } = {}) {
  const command = locked ? protocol.COMMANDS.BOLT_LOCK : protocol.COMMANDS.UNLOCK;

  const attempts = [];
  let acknowledged = false;

  for (const auth of authModes) {
    const frame = await session.request(command, { auth });
    attempts.push({ auth, status: frame.statusByte, raw: frame.raw.toString('hex') });
    if (frame.success) {
      acknowledged = true;
      break;
    }
  }

  // The lock usually pushes a LOCK_STATUS once the motor has run, which the
  // session records on its own. Read again anyway: a jam can settle after.
  const deferred = session.state;
  let state = deferred;
  let stateError = null;
  try {
    state = await readStatus(session);
  } catch (err) {
    stateError = err.message;
  }
  return { acknowledged, attempts, deferred, raw: attempts[attempts.length - 1].raw, state, stateError };
}

async function readSerial(session) {
  const frame = await session.request(protocol.COMMANDS.GET_SN);
  return frame.data.toString('latin1').replace(/\0.*$/, '');
}

// Read-only sweep used to decode response layouts against a lock whose physical
// state is known. Every field is reported raw, with nothing inferred.
const DUMP_COMMANDS = ['LOCK_STATUS', 'GET_LOCK_STATUS', 'GET_BATTERY', 'GET_MUTE', 'GET_SN'];

async function dumpReads(session) {
  const frames = [];
  for (const name of DUMP_COMMANDS) {
    try {
      const f = await session.request(protocol.COMMANDS[name]);
      frames.push({
        command: name,
        raw: f.raw.toString('hex'),
        replyName: f.commandName,
        replyCode: f.command,
        dataLength: f.dataLength,
        crcValid: f.crcValid,
        statusByte: f.statusByte,
        payload: f.data.toString('hex'),
      });
    } catch (err) {
      frames.push({ command: name, error: err.message });
    }
  }
  return frames;
}

module.exports = {
  LockSession, withSession, readStatus, setBolt, readSerial, dumpReads, CHAR_DATA,
};
