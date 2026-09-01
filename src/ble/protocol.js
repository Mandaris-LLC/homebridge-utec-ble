'use strict';

// Framing for the lock's data channel (characteristic 7201).
//
// A request is: 0x7F | length (2, LE) | command | [uid][password] | [data] | CRC8
// then encrypted in 16-byte blocks. Every block is encrypted with a fresh
// AES-128-CBC context and a zero IV, so the chaining never carries between
// blocks — the effect is ECB, and it is reproduced here exactly because the
// lock's firmware expects it.

const crypto = require('crypto');

const START = 0x7f;
const BLOCK = 16;
// CRC-8/Maxim: reflected, polynomial 0x8C, zero init.
const CRC8_POLY = 0x8c;

const COMMANDS = {
  LOCK_STATUS: 80,
  GET_LOCK_STATUS: 81,
  GET_BATTERY: 67,
  GET_SN: 94,
  GET_MUTE: 83,
  UNLOCK: 85,
  BOLT_LOCK: 86,
  SET_LOCK_STATUS: 82,
  REBOOT: 23,
  GET_AUTOLOCK: 90,
  SET_AUTOLOCK: 89,
  SET_WORK_MODE: 160,
  ADMIN_LOGIN: 32,
};

const RESPONSES = {
  208: 'LOCK_STATUS',
  209: 'GET_LOCK_STATUS',
  195: 'GET_BATTERY',
  213: 'UNLOCK',
  214: 'BOLT_LOCK',
  210: 'SET_LOCK_STATUS',
  222: 'GET_SN',
  211: 'GET_MUTE',
  245: 'DOORSENSOR',
  217: 'SET_AUTOLOCK',
  218: 'GET_AUTOLOCK',
  32: 'SET_WORK_MODE',
  160: 'ADMIN_LOGIN',
};

// LOCK_STATUS reports the lock's own state in its first payload byte, on this
// scale. Confirmed against a U-Bolt Pro: 2 while locked, 3 after the bolt
// failed to throw.
const LOCK_STATE = {
  0: 'Unavailable',
  1: 'Unlocked',
  2: 'Locked',
  3: 'Jammed',
  255: 'Unknown',
};

// Which response code answers each command.
const COMMAND_RESPONSE = {
  80: 208, 81: 209, 67: 195, 94: 222, 83: 211, 85: 213, 86: 214,
  82: 210, 90: 218, 89: 217, 160: 32, 32: 160,
};

// A separate, coarser bolt sensor, reported by GET_LOCK_STATUS. U-Bolt Pro
// units answer 255 here, meaning they do not expose one.
const BOLT_STATUS = { 0: 'Unlocked', 1: 'Locked', 255: 'Not reported' };
const LOCK_MODE = { 0: 'Normal', 1: 'Passage', 2: 'Lockout' };
// The lock reports battery on a coarse 0-3 scale.
const BATTERY_LEVEL = { '-1': 'Depleted', 0: 'Replace', 1: 'Low', 2: 'Medium', 3: 'High' };

const CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x01 ? ((crc >> 1) ^ CRC8_POLY) & 0xff : (crc >> 1) & 0xff;
    }
    table[i] = crc;
  }
  return table;
})();

function crc8(buf) {
  let crc = 0;
  for (const byte of buf) crc = CRC8_TABLE[(crc ^ byte) & 0xff];
  return crc;
}

// The admin password is packed into 4 bytes with its digit count in the top
// nibble of the last byte.
function encodeAuth(uid, password) {
  const parts = [];
  if (uid) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(Number(uid) >>> 0, 0);
    parts.push(buf);
  }
  if (password) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(Number(password) >>> 0, 0);
    buf[3] = ((String(password).length << 4) | buf[3]) & 0xff;
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

function buildRequest(command, { uid, password, data = Buffer.alloc(0), auth = false } = {}) {
  const body = Buffer.concat([
    auth ? encodeAuth(uid, password) : Buffer.alloc(0),
    Buffer.from(data),
  ]);

  const packet = Buffer.alloc(4 + body.length + 1);
  packet[0] = START;
  packet[3] = command;
  body.copy(packet, 4);

  // Length covers everything from the command byte onward, excluding the CRC.
  const length = 4 + body.length - 2;
  packet.writeUInt16LE(length, 1);
  packet[packet.length - 1] = crc8(packet.subarray(3, packet.length - 1));

  return packet;
}

function encrypt(packet, key) {
  const blocks = Math.ceil(packet.length / BLOCK) || 1;
  const padded = Buffer.alloc(blocks * BLOCK);
  packet.copy(padded);

  const out = Buffer.alloc(padded.length);
  for (let i = 0; i < blocks; i++) {
    // A fresh zero-IV context per block, matching the firmware.
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
    cipher.setAutoPadding(false);
    const block = padded.subarray(i * BLOCK, (i + 1) * BLOCK);
    Buffer.concat([cipher.update(block), cipher.final()]).copy(out, i * BLOCK);
  }
  return out;
}

// Decrypted per block, mirroring encrypt(). utecio instead runs one CBC context
// across the whole notification, which only agrees with the encrypt side while
// a notification is a single block — true at the usual BLE MTU, but it silently
// corrupts every block after the first on a larger one.
function decrypt(chunk, key) {
  const blocks = Math.floor(chunk.length / BLOCK);
  if (blocks === 0) return Buffer.alloc(0);

  const out = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < blocks; i++) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    const block = chunk.subarray(i * BLOCK, (i + 1) * BLOCK);
    Buffer.concat([decipher.update(block), decipher.final()]).copy(out, i * BLOCK);
  }
  return out;
}

// One decoded frame. A notification can hold more than one — a lock answers an
// actuating command with its acknowledgement and then, once the motor has run,
// a LOCK_STATUS carrying the real outcome, both inside the same 16-byte block.
function makeFrame(raw) {
  const dataLength = raw.readUInt16LE(1);
  const crcIndex = dataLength + 2;
  return {
    raw,
    buffer: raw,
    command: raw[3],
    commandName: RESPONSES[raw[3]] || `UNKNOWN(${raw[3]})`,
    statusByte: raw[4],
    success: raw[4] === 0,
    dataLength,
    data: raw.subarray(5, crcIndex),
    crcValid: crc8(raw.subarray(3, crcIndex)) === raw[crcIndex],
  };
}

// Walk a buffer of concatenated frames, stopping at padding or a partial tail.
function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 5 <= buffer.length && buffer[offset] === START) {
    const dataLength = buffer.readUInt16LE(offset + 1);
    const total = dataLength + 3;
    if (dataLength < 1 || offset + total > buffer.length) break;
    frames.push(makeFrame(buffer.subarray(offset, offset + total)));
    offset += total;
  }
  return frames;
}

// A frame can never legitimately be this long; anything claiming to be is
// corruption, and the buffer is dropped rather than stalling forever.
const MAX_FRAME = 2048;

// Decodes a continuous notification stream into frames. Used when the
// connection is held open: one subscription, frames arriving at any time —
// whether answering a command or reporting a change nobody asked about.
class FrameStream {
  constructor(key) {
    this.key = key;
    this.buffer = Buffer.alloc(0);
  }

  // Returns every complete frame the chunk completed, in order.
  push(chunk) {
    const plain = decrypt(Buffer.from(chunk), this.key);
    if (!plain.length) return [];

    this.buffer = Buffer.concat([this.buffer, plain]);
    const frames = [];

    while (this.buffer.length >= 5 && this.buffer[0] === START) {
      const dataLength = this.buffer.readUInt16LE(1);
      if (dataLength < 1 || dataLength > MAX_FRAME) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      const total = dataLength + 3;
      if (this.buffer.length < total) break; // still arriving

      frames.push(makeFrame(Buffer.from(this.buffer.subarray(0, total))));
      this.buffer = Buffer.from(this.buffer.subarray(total));
    }

    // Writes start on a block boundary, so a remainder that cannot begin a
    // frame is the zero padding of the last one.
    if (this.buffer.length && this.buffer[0] !== START) this.buffer = Buffer.alloc(0);
    return frames;
  }
}

// Responses arrive across several BLE notifications, so accumulate until the
// declared length is satisfied.
class ResponseAssembler {
  constructor(key) {
    this.key = key;
    this.buffer = Buffer.alloc(0);
  }

  append(chunk) {
    const plain = decrypt(Buffer.from(chunk), this.key);
    // Ignore anything before the start byte, in case a stale notification lands.
    if (this.buffer.length === 0 && plain[0] !== START) return false;
    this.buffer = Buffer.concat([this.buffer, plain]);
    return this.isComplete();
  }

  get dataLength() {
    return this.buffer.length > 3 ? this.buffer.readUInt16LE(1) : 0;
  }

  // Verified against the request framing: total = length field + 3, with the
  // CRC as the final byte. (utecio uses +4, which overshoots by one and only
  // works because notifications are padded to a 16-byte block.)
  get packetLength() {
    return this.buffer.length > 3 ? this.dataLength + 3 : 0;
  }

  isComplete() {
    return this.buffer.length > 3 && this.buffer.length >= this.packetLength;
  }

  // Checked and reported rather than enforced: the padding makes a false
  // negative harmless, but rejecting a good frame would break the lock.
  get crcValid() {
    if (!this.isComplete()) return false;
    const crcIndex = this.dataLength + 2;
    return crc8(this.buffer.subarray(3, crcIndex)) === this.buffer[crcIndex];
  }

  get command() {
    return this.isComplete() ? this.buffer[3] : null;
  }

  get commandName() {
    return RESPONSES[this.command] || `UNKNOWN(${this.command})`;
  }

  get success() {
    return this.isComplete() && this.buffer[4] === 0;
  }

  // Payload sits between the status byte and the CRC.
  get data() {
    return this.isComplete() ? this.buffer.subarray(5, this.dataLength + 2) : Buffer.alloc(0);
  }

  // Every frame received so far, including any the lock appended after the
  // acknowledgement.
  frames() {
    return parseFrames(this.buffer);
  }
}

// Payload layout of a LOCK_STATUS (208) reply, as observed on a U-Bolt Pro:
//
//   [0] lock state   (LOCK_STATE)
//   [1] secondary status — 0 on units without a door sensor
//   [2] battery      (BATTERY_LEVEL)
//   [3] working mode (LOCK_MODE)
//   [4] mute
//   [9..] ASCII serial number
//
// Longer replies carry the trailing fields; short ones stop after the state.
function parseLockStatus(assembler) {
  const data = assembler.data;
  const state = {
    stateCode: data[0],
    state: LOCK_STATE[data[0]] ?? `Unknown(${data[0]})`,
    secondaryCode: data[1],
  };

  if (data.length >= 5) {
    state.battery = data[2];
    state.batteryLabel = BATTERY_LEVEL[data[2]] ?? `Unknown(${data[2]})`;
    state.lockMode = data[3];
    state.lockModeLabel = LOCK_MODE[data[3]] ?? `Unknown(${data[3]})`;
    state.mute = Boolean(data[4]);
  }
  return state;
}

// GET_LOCK_STATUS (209) reports [mode, bolt sensor] instead.
function parseGetLockStatus(assembler) {
  const data = assembler.data;
  return {
    lockMode: data[0],
    lockModeLabel: LOCK_MODE[data[0]] ?? `Unknown(${data[0]})`,
    boltCode: data[1],
    bolt: BOLT_STATUS[data[1]] ?? `Unknown(${data[1]})`,
  };
}

module.exports = {
  START, BLOCK, COMMANDS, RESPONSES, COMMAND_RESPONSE,
  LOCK_STATE, BOLT_STATUS, LOCK_MODE, BATTERY_LEVEL,
  CRC8_TABLE, crc8, encodeAuth, buildRequest, encrypt, decrypt,
  makeFrame, parseFrames, FrameStream, ResponseAssembler,
  parseLockStatus, parseGetLockStatus,
};
