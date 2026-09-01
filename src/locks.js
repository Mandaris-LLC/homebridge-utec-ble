'use strict';

// Lock identity and discovery, independent of any interface. Both the CLI and
// the Homebridge platform build on this.

const config = require('./config');
const { findPeripherals, identifiersOf, normalize } = require('./ble/probe');

// A lock is recognised by its MAC (Linux reports it, and uses it as the
// peripheral id) or by the peripheral id `pair` recorded — needed on macOS,
// which withholds MACs and substitutes a per-machine UUID.
function identifiersFor(lock) {
  return [lock.address, lock.peripheralId].filter(Boolean);
}

function loadLocks() {
  const locks = config.read().bleLocks;
  if (!locks || !locks.length) {
    throw new Error('No cached Bluetooth keys. Run `utec link` first.');
  }
  return locks;
}

// Narrow to the locks matching a name fragment, or all of them.
function selectLocks(hint, { locks = loadLocks() } = {}) {
  const needle = (hint || '').trim().toLowerCase();
  const chosen = needle ? locks.filter((l) => l.name.toLowerCase().includes(needle)) : locks;
  if (!chosen.length) throw new Error(`No cached lock matching "${hint}".`);

  const unidentifiable = chosen.filter((l) => !identifiersFor(l).length);
  if (unidentifiable.length) {
    throw new Error(
      `${unidentifiable.map((l) => l.name).join(', ')} has no address or paired id.\n` +
        'Run `utec link` again, then `utec pair`.'
    );
  }
  return chosen;
}

function matches(lock, peripheral) {
  const wanted = new Set(identifiersFor(lock).map(normalize));
  return identifiersOf(peripheral).some((id) => wanted.has(id));
}

// Resolve locks to live peripherals, keyed by lock name.
async function findLocks(locks, { timeoutMs } = {}) {
  const peripherals = await findPeripherals({
    ids: locks.flatMap(identifiersFor),
    ...(timeoutMs ? { timeoutMs } : {}),
  });

  const found = new Map();
  for (const lock of locks) {
    const match = peripherals.find((p) => matches(lock, p));
    if (match) found.set(lock.name, match);
  }
  return found;
}

// Why a lock might not have turned up, phrased for the platform in use.
function notFoundHint(lock) {
  return lock.peripheralId
    ? 'not in range (or asleep — touch the keypad)'
    : 'not found; if this machine hides MAC addresses (macOS) run `utec pair` first, ' +
      'otherwise it is out of range or asleep';
}

module.exports = {
  loadLocks, selectLocks, findLocks, matches, identifiersFor, notFoundHint,
};
