'use strict';

// ECDH over SECP128r1, which the lock uses to agree an AES key. Node's crypto
// does not carry this curve (it is small and long out of fashion), so the group
// arithmetic is done here with BigInt. The numbers are tiny by EC standards, so
// plain affine coordinates are quick enough.
//
// This is interoperability code for a lock we own, not a general-purpose crypto
// library: it is not constant-time and should not be reused as one. Verified
// against python-ecdsa, the implementation utecio uses.

const crypto = require('crypto');

// SEC 2 domain parameters for secp128r1.
const P = 0xfffffffdffffffffffffffffffffffffn;
const A = 0xfffffffdfffffffffffffffffffffffcn; // == -3 mod P
const B = 0xe87579c11079f43dd824993c2cee5ed3n;
const N = 0xfffffffe0000000075a30d1b9038a115n;
const G = {
  x: 0x161ff7528b899b2d0c28607ca52c5b86n,
  y: 0xcf5ac8395bafeb13c02da292dded7a83n,
};

const BYTES = 16;

function mod(a, m = P) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

// Modular inverse by the extended Euclidean algorithm.
function invert(a, m = P) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];

  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('Value is not invertible.');
  return mod(old_s, m);
}

// The point at infinity is represented as null.
function isOnCurve(point) {
  if (!point) return true;
  const { x, y } = point;
  if (x < 0n || x >= P || y < 0n || y >= P) return false;
  return mod(y * y - (x * x * x + A * x + B)) === 0n;
}

function double(point) {
  if (!point || point.y === 0n) return null;
  const { x, y } = point;
  const lambda = mod((3n * x * x + A) * invert(2n * y));
  const rx = mod(lambda * lambda - 2n * x);
  return { x: rx, y: mod(lambda * (x - rx) - y) };
}

function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.x === q.x) return p.y === q.y ? double(p) : null;

  const lambda = mod((q.y - p.y) * invert(q.x - p.x));
  const rx = mod(lambda * lambda - p.x - q.x);
  return { x: rx, y: mod(lambda * (p.x - rx) - p.y) };
}

function multiply(k, point) {
  let scalar = mod(k, N);
  if (scalar === 0n || !point) return null;

  let result = null;
  let addend = point;
  while (scalar > 0n) {
    if (scalar & 1n) result = add(result, addend);
    addend = double(addend);
    scalar >>= 1n;
  }
  return result;
}

// The lock exchanges coordinates as 16-byte little-endian integers.
function toLE(value) {
  const buf = Buffer.alloc(BYTES);
  let v = value;
  for (let i = 0; i < BYTES; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function fromLE(buf) {
  let v = 0n;
  for (let i = buf.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[i]);
  return v;
}

function generatePrivateKey() {
  // Rejection sampling keeps the scalar uniform over [1, N-1].
  for (;;) {
    const candidate = fromLE(crypto.randomBytes(BYTES));
    if (candidate >= 1n && candidate < N) return candidate;
  }
}

function publicKey(privateKey) {
  return multiply(privateKey, G);
}

// The shared AES key is the x coordinate of privateKey * theirPoint.
function sharedSecret(privateKey, theirPoint) {
  if (!isOnCurve(theirPoint)) {
    throw new Error('Lock sent a public key that is not on the curve.');
  }
  if (!theirPoint) throw new Error('Lock sent the point at infinity.');

  const shared = multiply(privateKey, theirPoint);
  if (!shared) throw new Error('Key agreement produced the point at infinity.');
  return toLE(shared.x);
}

module.exports = {
  P, A, B, N, G, BYTES,
  mod, invert, isOnCurve, add, double, multiply,
  toLE, fromLE, generatePrivateKey, publicKey, sharedSecret,
};
