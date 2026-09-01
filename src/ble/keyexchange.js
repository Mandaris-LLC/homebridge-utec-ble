'use strict';

// Three ways a lock agrees the AES key, picked by which characteristic its
// firmware exposes. Ultraloq U-Bolt Pro units use ECC.

const crypto = require('crypto');
const ec = require('./secp128r1');

const CHAR_STATIC = '7220';
const CHAR_MD5 = '7223';
const CHAR_ECC = '7221';

const KEY_TIMEOUT_MS = 15000;

function timeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

// The key is a fixed prefix plus whatever the characteristic holds.
async function staticKey(characteristic) {
  const value = await characteristic.readAsync();
  return Buffer.concat([Buffer.from('Anviz.ut'), value]);
}

// Derived by folding a 16-byte secret against the ASCII of "ULtraloq".
function deriveMd5Key(secret) {
  if (secret.length !== 16) throw new Error('Expected a 16-byte MD5 secret.');

  const part1 = secret.readBigUInt64LE(0);
  const part2 = secret.readBigUInt64LE(8);

  const xor1 = part1 ^ 0x716f6c6172744c55n;

  // The second half mixes the two words byte by byte against the same constant.
  const CONST = [0x71, 0x6f, 0x6c, 0x61, 0x72, 0x74, 0x4c, 0x55];
  let xor2 = 0n;
  for (let i = 0; i < 8; i++) {
    const shift = BigInt(56 - i * 8);
    const byte =
      ((part2 >> shift) & 0xffn) ^ ((part1 >> shift) & 0xffn) ^ BigInt(CONST[i]);
    xor2 |= byte << shift;
  }

  const packed = Buffer.alloc(16);
  packed.writeBigUInt64LE(BigInt.asUintN(64, xor1), 0);
  packed.writeBigUInt64LE(BigInt.asUintN(64, xor2), 8);

  let result = crypto.createHash('md5').update(packed).digest();
  // An odd low byte means hash it a second time.
  if ((Number(part1 & 0xffn) ^ 0x55) & 1) {
    result = crypto.createHash('md5').update(result).digest();
  }
  return result;
}

async function md5Key(characteristic) {
  return deriveMd5Key(await characteristic.readAsync());
}

// ECDH: send our public point as two 16-byte little-endian writes, receive
// theirs as two notifications, then multiply.
async function eccKey(characteristic) {
  const privateKey = ec.generatePrivateKey();
  const publicKey = ec.publicKey(privateKey);

  const received = [];
  let resolveBoth;
  const bothReceived = new Promise((resolve) => (resolveBoth = resolve));

  const onData = (data) => {
    received.push(Buffer.from(data));
    if (received.length === 2) resolveBoth();
  };

  characteristic.on('data', onData);
  try {
    await characteristic.subscribeAsync();
    await characteristic.writeAsync(ec.toLE(publicKey.x), false);
    await characteristic.writeAsync(ec.toLE(publicKey.y), false);

    await timeout(bothReceived, KEY_TIMEOUT_MS, 'Lock did not return its public key in time.');

    const theirPoint = { x: ec.fromLE(received[0]), y: ec.fromLE(received[1]) };
    return ec.sharedSecret(privateKey, theirPoint);
  } finally {
    characteristic.removeListener('data', onData);
    await characteristic.unsubscribeAsync().catch(() => {});
  }
}

// Preference order matches the firmware's own: static, then MD5, then ECC.
async function establishKey(characteristics) {
  const byUuid = (uuid) => characteristics.get(uuid);

  if (byUuid(CHAR_STATIC)) return { kind: 'STATIC', key: await staticKey(byUuid(CHAR_STATIC)) };
  if (byUuid(CHAR_MD5)) return { kind: 'MD5', key: await md5Key(byUuid(CHAR_MD5)) };
  if (byUuid(CHAR_ECC)) return { kind: 'ECC', key: await eccKey(byUuid(CHAR_ECC)) };

  throw new Error('Lock exposes no key-exchange characteristic this client understands.');
}

module.exports = {
  CHAR_STATIC, CHAR_MD5, CHAR_ECC,
  staticKey, md5Key, deriveMd5Key, eccKey, establishKey, timeout,
};
