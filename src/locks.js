'use strict';

// Lock identity and discovery, independent of any interface. Both the CLI and
// the Homebridge platform build on this.

const config = require('./config');
const { findPeripherals, identifiersOf, normalize, connectByAddress } = require('./ble/probe');

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

// Reach one lock, preferring a direct connect to its known address.
//
// Scanning and then connecting to the discovered object is fragile on noble's
// Linux binding: the peripheral can be absent from noble's registry by the time
// the connection completes, and it warns "unknown peripheral <id>" and never
// resolves — the call hangs. Connecting by address avoids that, and needs no
// scan at all. Scanning stays the fallback, and is the only route where no
// address is known, as on macOS.
async function reachLock(lock, { debug } = {}) {
  if (lock.address) {
    try {
      const peripheral = await connectByAddress(lock.address);
      debug?.(`connected directly to ${lock.address}`);
      return { peripheral, connected: true };
    } catch (err) {
      debug?.(`direct connect failed (${err.message}); scanning instead`);
    }
  }

  const found = await findLocks([lock]);
  const peripheral = found.get(lock.name);
  if (!peripheral) throw new Error(notFoundHint(lock));
  return { peripheral, connected: false };
}

// Why a lock might not have turned up, phrased for the platform in use.
function notFoundHint(lock) {
  return lock.peripheralId
    ? 'not in range (or asleep — touch the keypad)'
    : 'not found; if this machine hides MAC addresses (macOS) run `utec pair` first, ' +
      'otherwise it is out of range or asleep';
}

module.exports = {
  loadLocks, selectLocks, findLocks, reachLock, matches, identifiersFor, notFoundHint,
};
