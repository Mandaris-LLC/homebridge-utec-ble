'use strict';

// One BLE conversation with a lock: connect, agree a key, then exchange
// framed commands on the data characteristic.

const { canonUuid } = require('./probe');
const { establishKey, timeout } = require('./keyexchange');
const protocol = require('./protocol');

const CHAR_DATA = '7201';
const RESPONSE_TIMEOUT_MS = 15000;

function debug(...args) {
  if (process.env.UTEC_DEBUG) console.error('[utec]', ...args);
}

class LockSession {
  constructor(peripheral, credential) {
    this.peripheral = peripheral;
    this.credential = credential;
    this.key = null;
    this.keyKind = null;
    this.data = null;
  }

  async open() {
    await this.peripheral.connectAsync();
    debug(`connected to ${this.peripheral.id}`);

    const { characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    const byUuid = new Map(characteristics.map((c) => [canonUuid(c.uuid), c]));

    this.data = byUuid.get(CHAR_DATA);
    if (!this.data) throw new Error('Lock has no data characteristic (7201).');

    const { kind, key } = await establishKey(byUuid);
    this.key = key;
    this.keyKind = kind;
    debug(`key agreed via ${kind}`);
  }

  // Writes one command and waits for the matching framed response.
  async request(command, { auth = false, data } = {}) {
    const assembler = new protocol.ResponseAssembler(this.key);

    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    const onData = (chunk) => {
      if (assembler.append(chunk)) resolveDone();
    };

    this.data.on('data', onData);
    try {
      await this.data.subscribeAsync();

      const packet = protocol.buildRequest(command, {
        uid: this.credential.uid,
        password: this.credential.password,
        auth,
        data,
      });
      debug(`-> ${commandName(command)} ${packet.toString('hex')}`);
      await this.data.writeAsync(protocol.encrypt(packet, this.key), false);

      await timeout(done, RESPONSE_TIMEOUT_MS, `Lock did not answer ${commandName(command)}.`);

      // A notification can carry the acknowledgement plus a deferred status
      // report, so pick out the frame that actually answers this command.
      const frames = assembler.frames();
      const expected = protocol.COMMAND_RESPONSE[command];
      const answer = frames.find((f) => f.command === expected) || frames[0] || assembler;

      for (const f of frames) debug(`<- ${f.commandName} status=${f.statusByte} ${f.raw.toString('hex')}`);
      return Object.assign(answer, { frames });
    } finally {
      this.data.removeListener('data', onData);
      await this.data.unsubscribeAsync().catch(() => {});
    }
  }

  async close() {
    await this.peripheral.disconnectAsync().catch(() => {});
  }
}

function commandName(code) {
  return Object.keys(protocol.COMMANDS).find((k) => protocol.COMMANDS[k] === code) || code;
}

// Every operation logs in first, matching the app's own sequence.
async function withSession(peripheral, credential, fn) {
  const session = new LockSession(peripheral, credential);
  try {
    await session.open();
    await session.request(protocol.COMMANDS.ADMIN_LOGIN, { auth: true });
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function readStatus(session) {
  const res = await session.request(protocol.COMMANDS.LOCK_STATUS);
  return protocol.parseLockStatus(res);
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
// follow-up status read is the ground truth, and a disagreement is surfaced.
async function setBolt(session, locked, { authModes = BOLT_AUTH_MODES } = {}) {
  const command = locked ? protocol.COMMANDS.BOLT_LOCK : protocol.COMMANDS.UNLOCK;

  const attempts = [];
  let acknowledged = false;
  let deferred = null;

  for (const auth of authModes) {
    const res = await session.request(command, { auth });
    attempts.push({ auth, status: res.statusByte, raw: res.raw.toString('hex') });

    // The lock often appends the real outcome once the motor has run.
    const report = (res.frames || []).find((f) => f.command === protocol.COMMAND_RESPONSE[protocol.COMMANDS.LOCK_STATUS]);
    if (report) deferred = protocol.parseLockStatus(report);

    if (res.success) {
      acknowledged = true;
      break;
    }
  }

  let state = deferred;
  let stateError = null;
  try {
    // Re-read regardless: a jam can settle differently once the motor stops.
    state = await readStatus(session);
  } catch (err) {
    stateError = err.message;
  }
  return { acknowledged, attempts, deferred, raw: attempts[attempts.length - 1].raw, state, stateError };
}

async function readSerial(session) {
  const res = await session.request(protocol.COMMANDS.GET_SN);
  return res.data.toString('latin1').replace(/\0.*$/, '');
}

// Read-only sweep used to decode response layouts against a lock whose physical
// state is known. Every field is reported raw, with nothing inferred.
const DUMP_COMMANDS = ['LOCK_STATUS', 'GET_LOCK_STATUS', 'GET_BATTERY', 'GET_MUTE', 'GET_SN'];

async function dumpReads(session) {
  const frames = [];
  for (const name of DUMP_COMMANDS) {
    try {
      const res = await session.request(protocol.COMMANDS[name]);
      frames.push({
        command: name,
        raw: res.buffer.toString('hex'),
        replyName: res.commandName,
        replyCode: res.command,
        dataLength: res.dataLength,
        crcValid: res.crcValid,
        statusByte: res.buffer[4],
        payload: res.data.toString('hex'),
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
