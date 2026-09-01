#!/usr/bin/env node
'use strict';

// Standalone BLE discovery for Ultraloq locks. Depends only on noble, so it can
// be copied to a Pi on its own:
//
//   npm install @stoprocent/noble
//   sudo setcap cap_net_raw+eip "$(eval readlink -f "$(which node)")"
//   node ble-discover.js [seconds] [--all]
//
// Unlike macOS, Linux reports each peripheral's real MAC address, so the output
// can be matched directly against the addresses the U-tec app API returns.

const noble = require('@stoprocent/noble');

const LOCK_SERVICE = '7200';
const seconds = Number(process.argv.find((a) => /^\d+$/.test(a))) || 20;
const showAll = process.argv.includes('--all');

// A service uuid may arrive short ("7200") or as the full 128-bit form.
const BASE_SUFFIX = '00001000800000805f9b34fb';
function canonUuid(uuid) {
  let flat = String(uuid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (flat.length === 32 && flat.endsWith(BASE_SUFFIX)) flat = flat.slice(0, 8);
  return flat.replace(/^0+/, '') || '0';
}

const found = new Map();

noble.on('discover', (p) => {
  const ad = p.advertisement || {};
  const services = (ad.serviceUuids || []).map(canonUuid);
  found.set(p.id, {
    id: p.id,
    address: p.address && p.address !== 'unknown' ? p.address.toUpperCase() : null,
    name: ad.localName || null,
    rssi: p.rssi,
    services,
    isLock: services.includes(LOCK_SERVICE) || /ultraloq|u-?bolt|utec|latch/i.test(ad.localName || ''),
  });
});

(async () => {
  if (noble.state !== 'poweredOn') await noble.waitForPoweredOnAsync(10000);

  console.log(`Scanning ${seconds}s for Ultraloq locks...\n`);
  await noble.startScanningAsync([], true);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await noble.stopScanningAsync();

  const all = [...found.values()].sort((a, b) => b.rssi - a.rssi);
  const locks = all.filter((d) => d.isLock);

  for (const d of showAll ? all : locks) {
    console.log(`${d.isLock ? 'LOCK' : '    '}  ${(d.name || '(no name)').padEnd(22)} ${String(d.rssi).padStart(4)} dBm`);
    console.log(`        address: ${d.address || '(hidden by this platform)'}`);
    console.log(`        id     : ${d.id}`);
    if (d.services.length) console.log(`        services: ${d.services.join(', ')}`);
    console.log();
  }

  console.log(`${locks.length} lock(s) of ${all.length} device(s).`);
  if (!locks.length) {
    console.log(
      '\nNothing matched. Locks sleep to save battery and only advertise when\n' +
        'woken — touch a keypad and rerun. If no devices appear at all, the\n' +
        'adapter lacks permission (see the setcap line above) or is off.'
    );
  }
  // noble holds the event loop open.
  process.exit(0);
})().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
