#!/usr/bin/env node
'use strict';

// Watches Ultraloq advertisements and prints their payload whenever it changes.
//
//   node ble-watch.js [seconds]
//
// The point is to find out whether a lock broadcasts its state. If it does,
// state can be tracked passively — no connection, no battery cost, and without
// blocking the phone app, which matters because these locks accept only one
// connection at a time.
//
// Run it, then lock and unlock the door by hand and watch for bytes that change
// in step. Bytes that change every advertisement (counters, nonces) are noise;
// look for a field that flips with the bolt and stays put otherwise.

const noble = require('@stoprocent/noble');

const LOCK_SERVICE = '7200';
const seconds = Number(process.argv.find((a) => /^\d+$/.test(a))) || 120;

const BASE_SUFFIX = '00001000800000805f9b34fb';
function canonUuid(uuid) {
  let flat = String(uuid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (flat.length === 32 && flat.endsWith(BASE_SUFFIX)) flat = flat.slice(0, 8);
  return flat.replace(/^0+/, '') || '0';
}

function hex(buf) {
  return buf ? buf.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
}

// Mark which byte positions differ from the previous payload.
function diffMarks(prev, next) {
  if (!prev || !next || prev.length !== next.length) return null;
  let marks = '';
  for (let i = 0; i < next.length; i++) marks += prev[i] === next[i] ? '   ' : ' ^^';
  return marks.trimEnd() ? marks : null;
}

const last = new Map();
const counts = new Map();

function label(p) {
  const addr = p.address && p.address !== 'unknown' ? p.address.toUpperCase() : p.id.slice(0, 12);
  return addr;
}

noble.on('discover', (p) => {
  const ad = p.advertisement || {};
  const services = (ad.serviceUuids || []).map(canonUuid);
  const isLock = services.includes(LOCK_SERVICE) || /ultraloq|u-?bolt|utec/i.test(ad.localName || '');
  if (!isLock) return;

  const key = label(p);
  counts.set(key, (counts.get(key) || 0) + 1);

  // Everything an advertisement can carry that might hold state.
  const payload = Buffer.concat([
    ad.manufacturerData || Buffer.alloc(0),
    ...(ad.serviceData || []).map((s) => s.data || Buffer.alloc(0)),
  ]);

  const previous = last.get(key);
  if (previous && previous.equals(payload)) return;

  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(`${stamp}  ${key}  ${String(p.rssi).padStart(4)} dBm  (advert #${counts.get(key)})`);
  if (ad.manufacturerData) console.log(`   manufacturer: ${hex(ad.manufacturerData)}`);
  for (const s of ad.serviceData || []) {
    console.log(`   service ${canonUuid(s.uuid)}: ${hex(s.data)}`);
  }
  if (!payload.length) console.log('   (no manufacturer or service data in this advertisement)');

  const marks = diffMarks(previous, payload);
  if (marks) console.log(`   changed:      ${marks}`);

  last.set(key, payload);
  console.log();
});

(async () => {
  if (noble.state !== 'poweredOn') await noble.waitForPoweredOnAsync(10000);

  console.log(`Watching Ultraloq advertisements for ${seconds}s.`);
  console.log('Lock and unlock the door by hand; changed bytes are marked ^^.\n');

  // allowDuplicates: every advertisement, not just first sighting.
  await noble.startScanningAsync([], true);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await noble.stopScanningAsync();

  console.log('--- summary ---');
  if (!counts.size) console.log('No locks seen at all.');
  for (const [key, n] of counts) {
    console.log(`${key}: ${n} advertisements, payload ${last.get(key)?.length || 0} bytes`);
  }
  console.log(
    '\nIf the payload never changed while you operated the lock, state is not\n' +
      'broadcast and has to be read over a connection.'
  );
  process.exit(0);
})().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
