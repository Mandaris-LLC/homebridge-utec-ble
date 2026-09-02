#!/usr/bin/env node
'use strict';

// Minimal connection test using nothing but noble. No project code is involved,
// so a failure here is noble or the adapter, not this plugin.
//
//   node ble-connect.js C4:D3:6A:86:A3:39
//   HCI_CHANNEL_USER=1 node ble-connect.js C4:D3:6A:86:A3:39
//
// It tries both routes noble offers — connect straight to the address, then
// scan and connect to the discovered object — and reports where each stops.
// Small enough to hand upstream as a reproduction if noble is at fault.

const noble = require('@stoprocent/noble');

const address = (process.argv[2] || '').trim();
if (!address) {
  console.error('Usage: node ble-connect.js <address>   e.g. C4:D3:6A:86:A3:39');
  process.exit(1);
}

const flat = (v) => String(v || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const want = flat(address);

const log = (...a) => console.log(...a);
const since = Date.now();
const stamp = () => `+${((Date.now() - since) / 1000).toFixed(1)}s`;

noble.on('stateChange', (s) => log(`${stamp()} [state] ${s}`));
noble.on('warning', (w) => log(`${stamp()} [warning] ${w}`));

function deadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

// Connect, enumerate, hang up — the whole point is whether this completes.
async function inspect(peripheral, how) {
  log(`${stamp()} ${how}: connected, id=${peripheral.id} state=${peripheral.state}`);

  const { services, characteristics } = await deadline(
    peripheral.discoverAllServicesAndCharacteristicsAsync(),
    20000,
    'discovery'
  );
  log(`${stamp()} ${how}: ${services.length} services, ${characteristics.length} characteristics`);
  log(`${stamp()} ${how}: ${characteristics.map((c) => c.uuid).join(', ')}`);

  await peripheral.disconnectAsync().catch(() => {});
  log(`${stamp()} ${how}: disconnected cleanly`);
}

function scanFor(target, ms) {
  return new Promise((resolve, reject) => {
    const onDiscover = (p) => {
      if (flat(p.address) !== target && flat(p.id) !== target) return;
      cleanup();
      log(`${stamp()} scan: found ${p.address || p.id} at ${p.rssi} dBm`);
      resolve(p);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`not seen in ${ms / 1000}s`));
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
    };

    noble.on('discover', onDiscover);
    noble.startScanningAsync([], true).catch((err) => (cleanup(), reject(err)));
  });
}

(async () => {
  log(`node:      ${process.execPath}`);
  log(`exclusive: ${process.env.HCI_CHANNEL_USER ? 'yes (HCI_CHANNEL_USER set)' : 'no'}`);
  log(`target:    ${address}\n`);

  log(`${stamp()} waiting for the adapter...`);
  await deadline(noble.waitForPoweredOnAsync(), 15000, 'adapter power-on');
  log(`${stamp()} adapter ready\n`);

  log('--- 1. direct connect by address ---');
  try {
    const peripheral = await deadline(noble.connectAsync(address), 25000, 'direct connect');
    await inspect(peripheral, 'direct');
    log('\nDirect connect works.');
    return;
  } catch (err) {
    log(`${stamp()} direct connect failed: ${err.message}\n`);
  }

  await new Promise((r) => setTimeout(r, 2000));

  log('--- 2. scan, then connect to the discovered peripheral ---');
  try {
    const peripheral = await scanFor(want, 20000);
    await noble.stopScanningAsync().catch(() => {});
    await deadline(peripheral.connectAsync(), 25000, 'scan connect');
    await inspect(peripheral, 'scan');
    log('\nScan-then-connect works.');
  } catch (err) {
    log(`${stamp()} scan connect failed: ${err.message}`);
    log('\nNeither route completed. The adapter can advertise-scan but not');
    log('establish a connection — check `dmesg` for Bluetooth errors, and note');
    log('that scanning working does not imply connecting will.');
    process.exitCode = 1;
  }
})()
  .catch((err) => {
    log(`\n${stamp()} error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // noble's socket keeps the loop alive.
    setTimeout(() => {
      try {
        noble.stop();
      } catch {
        /* nothing to release */
      }
      process.exit(process.exitCode || 0);
    }, 250);
  });
