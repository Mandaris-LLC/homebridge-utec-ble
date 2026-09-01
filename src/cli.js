#!/usr/bin/env node
'use strict';

const readline = require('readline');

const cloud = require('./ble/cloud');
const config = require('./config');

const USAGE = `
utec — lock and unlock Ultraloq locks over Bluetooth

Usage:
  utec link                Sign in once and cache your locks' Bluetooth keys
  utec pair                Identify each lock by serial number and remember it
  utec status [lock]       Read bolt state, mode and battery
  utec lock [lock]         Lock it
  utec unlock [lock]       Unlock it

Diagnostics:
  utec scan [seconds]      List every nearby Bluetooth device
  utec probe               Find the locks and report their key exchange
  utec dump [lock]         Print raw decrypted response frames (read-only)
  utec forget              Discard the cached Bluetooth keys

[lock] is a lock name, or any part of one. Omit it when you have one lock.
Set UTEC_DEBUG=1 to trace every command and response frame.

Locks are driven locally over Bluetooth, so the machine running this has to be
within range (roughly 15-30 ft). Locks sleep to save battery — if one is not
found, touch its keypad and retry immediately.
`.trim();

const NO_LOCKS_FOUND =
  'No lock advertised itself. They sleep to save battery — touch the keypad or\n' +
  'fingerprint reader, then run this again immediately.';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

// Same as prompt(), with the typed characters suppressed.
function promptSecret(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = new Promise((resolve) =>
    rl.question(question, (a) => (rl.close(), process.stdout.write('\n'), resolve(a)))
  );
  rl._writeToOutput = (chunk) => {
    if (chunk.includes(question)) rl.output.write(question);
  };
  return answer;
}

function cachedLocks() {
  const locks = config.read().bleLocks;
  if (!locks || !locks.length) throw new Error('No cached Bluetooth keys. Run `utec link` first.');
  return locks;
}

// Accept `utec lock Front Door` unquoted as well as quoted.
function deviceHint(args) {
  return args.filter((a) => !a.startsWith('-')).join(' ');
}

// A lock can be recognised by its MAC (Linux reports it) or by the peripheral
// id that `pair` recorded (needed on macOS, which hides MACs).
function identifiersFor(lock) {
  return [lock.address, lock.peripheralId].filter(Boolean);
}

// Narrow the cached locks to the ones the user means.
function selectLocks(args, { single = false } = {}) {
  const locks = cachedLocks();
  const hint = deviceHint(args).toLowerCase();

  const chosen = hint ? locks.filter((l) => l.name.toLowerCase().includes(hint)) : locks;
  if (!chosen.length) throw new Error(`No cached lock matching "${hint}".`);

  if (single && chosen.length > 1) {
    throw new Error(`Name one lock:\n${chosen.map((l) => `  ${l.name}`).join('\n')}`);
  }

  const unidentifiable = chosen.filter((l) => !identifiersFor(l).length);
  if (unidentifiable.length) {
    throw new Error(
      `${unidentifiable.map((l) => l.name).join(', ')} has no address or paired id.\n` +
        'Run `utec link` again, then `utec pair`.'
    );
  }
  return chosen;
}

// Resolve each chosen lock to a live peripheral, matching on either identifier.
async function connectTo(locks) {
  const { findPeripherals, identifiersOf, normalize } = require('./ble/probe');
  const peripherals = await findPeripherals({ ids: locks.flatMap(identifiersFor) });

  const byLock = new Map();
  for (const lock of locks) {
    const wanted = new Set(identifiersFor(lock).map(normalize));
    const match = peripherals.find((p) => identifiersOf(p).some((id) => wanted.has(id)));
    if (match) byLock.set(lock.name, match);
  }
  return byLock;
}

// Explains a miss differently depending on whether the platform can see MACs.
function notFoundHint(lock) {
  return lock.peripheralId
    ? 'not in range (or asleep — touch the keypad).'
    : 'not found. If this machine hides MAC addresses (macOS), run `utec pair` first;\n' +
      '  otherwise it is out of range or asleep — touch the keypad.';
}

function describeState(state) {
  if (!state) return 'state unavailable';
  const parts = [state.state];
  if (state.lockModeLabel) parts.push(`mode ${state.lockModeLabel}`);
  if (state.batteryLabel) parts.push(`battery ${state.batteryLabel}`);
  return parts.join(', ');
}

async function boltAction(args, locked) {
  const chosen = selectLocks(args, { single: true });
  const ble = require('./ble/lock');
  const byLock = await connectTo(chosen);

  for (const lock of chosen) {
    const peripheral = byLock.get(lock.name);
    if (!peripheral) {
      console.log(`${lock.name}: ${notFoundHint(lock)}`);
      process.exitCode = 1;
      continue;
    }

    process.stdout.write(`${locked ? 'Locking' : 'Unlocking'} ${lock.name}... `);
    const result = await ble.withSession(peripheral, lock, (s) => ble.setBolt(s, locked));

    const expected = locked ? 'Locked' : 'Unlocked';
    if (result.state && result.state.state === expected) {
      console.log('done.');
      continue;
    }

    // A jam is mechanical, not a protocol failure — the lock accepted the
    // command and the bolt physically could not move. Say so plainly, because
    // it means the door is not secured. Trust a jam reported from either the
    // deferred outcome or the current state; some locks retract after jamming,
    // so the two can disagree.
    const jammed = [result.state, result.deferred].some((s) => s && s.state === 'Jammed');
    if (jammed) {
      const battery = (result.state || result.deferred || {}).batteryLabel;
      console.log('JAMMED.');
      console.log(
        `  The lock accepted the command but the bolt could not ${locked ? 'throw' : 'retract'}.\n` +
          `  The door is NOT ${locked ? 'secured' : 'open'}. It now reads: ${describeState(result.state)}.\n` +
          '  Usually door/frame alignment against the strike plate, or a battery\n' +
          `  too low for the motor to push through. Battery reads ${battery || 'unknown'}.`
      );
      process.exitCode = 1;
      continue;
    }

    // Never report success we cannot see reflected in the lock's own state.
    console.log('could not confirm.');
    console.log(`  state now reads: ${describeState(result.state)}`);
    if (result.stateError) console.log(`  status read failed: ${result.stateError}`);
    for (const a of result.attempts) {
      console.log(`  ${a.auth ? 'with' : 'without'} credentials: status byte ${a.status}  ${a.raw}`);
    }
    process.exitCode = 1;
  }
}

const commands = {
  async link() {
    console.log(
      'This signs in to the U-tec phone app API to read your locks\' Bluetooth\n' +
        'keys. They are fetched once and cached; your password is not stored.\n'
    );
    const email = await prompt('U-tec account email: ');
    const password = await promptSecret('U-tec account password: ');
    if (!email || !password) throw new Error('Email and password are both required.');

    const locks = await cloud.fetchLockCredentials(email, password);
    if (!locks.length) throw new Error('That account has no devices.');

    // Keep any peripheral ids already learned by `pair`.
    const known = new Map((config.read().bleLocks || []).map((l) => [l.serial, l.peripheralId]));
    for (const lock of locks) {
      if (known.get(lock.serial)) lock.peripheralId = known.get(lock.serial);
    }

    config.update({ bleLocks: locks });
    console.log(`Cached Bluetooth credentials for ${locks.length} device(s):\n`);
    for (const lock of locks) {
      console.log(`  ${lock.name}  [${lock.model}]  ${lock.address}`);
    }
    console.log(`\nStored in ${config.CONFIG_FILE}. Next: utec pair`);
  },

  async forget() {
    config.update({ bleLocks: undefined });
    console.log('Cached Bluetooth keys discarded.');
  },

  async scan(args) {
    const seconds = Number(args.find((a) => /^\d+$/.test(a))) || 15;
    console.log(`Scanning all Bluetooth devices for ${seconds}s...\n`);
    const found = await require('./ble/probe').scanAll({ timeoutMs: seconds * 1000 });

    if (!found.length) {
      return console.log(
        'Nothing at all was found, which points at the adapter rather than the locks:\n' +
          '  - Grant Bluetooth permission: System Settings -> Privacy & Security ->\n' +
          '    Bluetooth -> enable your terminal, then restart it.\n' +
          '  - Confirm Bluetooth is on.'
      );
    }

    for (const d of found) {
      console.log(`${d.isLock ? '>>' : '  '} ${(d.name || '(no name)').padEnd(24)} ${String(d.rssi).padStart(4)} dBm  id=${d.id}`);
      if (d.serviceUuids.length) console.log(`      services: ${d.serviceUuids.join(', ')}`);
    }
    console.log(`\n${found.length} device(s); ${found.filter((d) => d.isLock).length} look like Ultraloq locks.`);
  },

  async probe() {
    console.log('Scanning for Ultraloq locks, up to 20s...\n');
    const results = await require('./ble/probe').probe();
    if (!results.length) return console.log(NO_LOCKS_FOUND);

    for (const r of results) {
      console.log(`${r.name || '(no name)'}  id=${r.id}  ${r.rssi} dBm`);
      if (r.error) {
        console.log(`  could not inspect: ${r.error}\n`);
        continue;
      }
      console.log(`  key exchange: ${r.keyKind ? `${r.keyKind.name} — ${r.keyKind.note}` : 'UNKNOWN'}`);
      console.log(`  data channel: ${r.hasData ? 'present' : 'MISSING'}`);
      console.log(`  characteristics: ${r.characteristics.join(', ')}\n`);
    }
  },

  // macOS gives no MAC address and both locks advertise the same name, so the
  // serial number each reports is the only trustworthy way to tell them apart.
  async pair() {
    const locks = cachedLocks();
    const { findPeripherals } = require('./ble/probe');
    const ble = require('./ble/lock');

    console.log('Scanning for locks, up to 20s...\n');
    const peripherals = await findPeripherals();
    if (!peripherals.length) throw new Error(NO_LOCKS_FOUND);

    const paired = [];
    for (const peripheral of peripherals) {
      process.stdout.write(`  ${peripheral.id}  ... `);
      try {
        const serial = await ble.withSession(peripheral, locks[0], (s) => ble.readSerial(s));
        const match = locks.find((l) => l.serial && l.serial === serial);
        if (match) {
          match.peripheralId = peripheral.id;
          paired.push(match);
          console.log(`${match.name}  (serial ${serial})`);
        } else {
          console.log(`serial ${serial} — no matching lock in the cache`);
        }
      } catch (err) {
        console.log(`failed: ${err.message}`);
      }
    }

    if (!paired.length) throw new Error('No lock could be identified.');
    config.update({ bleLocks: locks });
    console.log(`\nPaired ${paired.length} of ${locks.length} lock(s).`);
  },

  async status(args) {
    const chosen = selectLocks(args);
    const ble = require('./ble/lock');
    const byLock = await connectTo(chosen);

    for (const lock of chosen) {
      const peripheral = byLock.get(lock.name);
      if (!peripheral) {
        console.log(`${lock.name}: ${notFoundHint(lock)}`);
        continue;
      }
      const state = await ble.withSession(peripheral, lock, (s) => ble.readStatus(s));
      console.log(`${lock.name}: ${describeState(state)}`);
    }
  },

  // Read-only. Prints the raw decrypted frames so response layouts can be
  // decoded against a lock whose real state is known.
  async dump(args) {
    const chosen = selectLocks(args);
    const ble = require('./ble/lock');
    const byLock = await connectTo(chosen);

    for (const lock of chosen) {
      const peripheral = byLock.get(lock.name);
      if (!peripheral) {
        console.log(`${lock.name}: ${notFoundHint(lock)}\n`);
        continue;
      }
      console.log(`${lock.name}  [${lock.model}]  uid=${lock.uid}`);
      const frames = await ble.withSession(peripheral, lock, (s) => ble.dumpReads(s));
      for (const f of frames) {
        console.log(`  ${f.command.padEnd(16)} ${f.error ? `ERROR ${f.error}` : ''}`);
        if (f.error) continue;
        console.log(`    raw       ${f.raw}`);
        console.log(`    reply     ${f.replyName} (${f.replyCode})  len=${f.dataLength}  crcOk=${f.crcValid}`);
        console.log(`    byte[4]   ${f.statusByte}`);
        console.log(`    payload   ${f.payload}`);
      }
      console.log();
    }
  },

  lock: (args) => boltAction(args, true),
  unlock: (args) => boltAction(args, false),
};

// Earlier releases used ble- prefixes; keep them working.
for (const [alias, target] of Object.entries({
  'ble-link': 'link', 'ble-scan': 'scan', 'ble-probe': 'probe', 'ble-pair': 'pair',
  'ble-status': 'status', 'ble-lock': 'lock', 'ble-unlock': 'unlock', 'ble-dump': 'dump',
})) {
  commands[alias] = (args) => commands[target](args);
}

async function main() {
  const [name, ...args] = process.argv.slice(2);
  if (!name || name === '-h' || name === '--help') return console.log(USAGE);

  const command = commands[name];
  if (!command) {
    console.error(`Unknown command "${name}".\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  await command(args);
}

// The Bluetooth adapter keeps handles open, so the event loop never drains on
// its own — flush output, then leave deliberately.
function finish(code) {
  process.stdout.write('', () => process.exit(code));
}

main().then(
  () => finish(process.exitCode || 0),
  (err) => {
    console.error(`\nError: ${err.message}`);
    finish(1);
  }
);
