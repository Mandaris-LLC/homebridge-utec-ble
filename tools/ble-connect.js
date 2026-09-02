#!/usr/bin/env node
'use strict';

// Minimal connection test using nothing but noble. No project code is involved,
// so a failure here is noble or the adapter, not this plugin.
//
//   node ble-connect.js C4:D3:6A:86:A3:39
//   HCI_CHANNEL_USER=1 node ble-connect.js C4:D3:6A:86:A3:39
//
// It tries connect-by-address first purely to demonstrate that it is broken —
// noble does not register a peripheral for an undiscovered address, so the
// controller connects, noble warns "unknown peripheral <id> connected!", and
// the promise never resolves while the link stays open and untracked. Then it
// does it properly: scan to register the peripheral, then connect.
//
// Small enough to hand upstream as a reproduction.

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
//
// The disconnect happens whatever the outcome. A lock that permits one
// connection is blocked by any link left behind, so leaking one turns a single
// failure into a run of them.
async function inspect(peripheral, how) {
  log(`${stamp()} ${how}: connected, id=${peripheral.id} state=${peripheral.state}`);

  try {
    const { services, characteristics } = await deadline(
      peripheral.discoverAllServicesAndCharacteristicsAsync(),
      20000,
      'discovery'
    );
    log(`${stamp()} ${how}: ${services.length} services, ${characteristics.length} characteristics`);
    log(`${stamp()} ${how}: ${characteristics.map((c) => c.uuid).join(', ')}`);
  } finally {
    await peripheral.disconnectAsync().catch(() => {});
    log(`${stamp()} ${how}: link released`);
  }
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

  // Only on request: noble's connectAsync(address) does not register a
  // peripheral for an address it has not discovered, so it connects at the
  // controller, warns "unknown peripheral <id> connected!", and leaves that
  // link open and untracked. On a one-connection-at-a-time lock, the leak then
  // makes the scan attempt below fail with `Disconnected 62` — the first test
  // breaks the second. It is off by default for exactly that reason.
  if (process.argv.includes('--also-direct')) {
    log('--- connect by address (known-broken in noble; leaks a link) ---');
    try {
      const peripheral = await deadline(noble.connectAsync(address), 25000, 'direct connect');
      await inspect(peripheral, 'direct');
    } catch (err) {
      log(`${stamp()} direct connect failed: ${err.message}`);
      log('  A leaked link probably remains, so the next attempt may fail too.\n');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  log('--- scan, then connect to the discovered peripheral ---');
  try {
    const peripheral = await scanFor(want, 20000);
    await noble.stopScanningAsync().catch(() => {});
    await deadline(peripheral.connectAsync(), 25000, 'connect');
    await inspect(peripheral, 'scan');
    log('\nWorks. This is the route the plugin uses.');
  } catch (err) {
    log(`${stamp()} failed: ${err.message}`);
    log('\nThe adapter scans but cannot hold a connection. Check that nothing');
    log('else owns the lock: `sudo btmon` should show no other "RAW Open", and');
    log('Homebridge must be stopped (`pgrep -af homebridge`). A link left open');
    log('by an earlier attempt blocks these locks, which take one at a time.');
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
