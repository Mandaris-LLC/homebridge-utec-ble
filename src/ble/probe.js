'use strict';

// Reconnaissance step. Locks negotiate their AES key in one of three ways
// depending on firmware, and which one this lock uses decides how the rest of
// the client is written — so find out before building on a guess.
//
// STATIC and MD5 are straightforward. ECC is ECDH over SECP128r1, a curve
// Node's crypto does not carry, so it needs a userspace EC implementation.

const KEY_KINDS = {
  7220: { name: 'STATIC', note: 'key is "Anviz.ut" + the characteristic value' },
  7223: { name: 'MD5', note: 'key derived by XOR + MD5 over a 16-byte secret' },
  7221: { name: 'ECC', note: 'ECDH over SECP128r1 — needs a userspace EC library' },
};

const SERVICE_LOCK = '00007200-0000-1000-8000-00805f9b34fb';
const SERVICE_DATA = '00007201-0000-1000-8000-00805f9b34fb';

// Where adapter-level events are reported. Set by whoever owns the logging.
let adapterLog = null;

function setAdapterLogger(fn) {
  adapterLog = fn;
}

let instrumented = false;

// noble discards its entire peripheral registry whenever the adapter leaves the
// poweredOn state, and pending connects then never resolve — the call simply
// hangs, or warns "unknown peripheral <id>". An adapter that resets underneath
// us therefore looks like a dozen unrelated faults, so make the resets visible.
function instrument(noble) {
  if (instrumented) return;
  instrumented = true;

  noble.on('stateChange', (state) => {
    adapterLog?.(
      state === 'poweredOn'
        ? 'adapter powered on'
        : `adapter left poweredOn (now "${state}") — in-flight work is invalidated`
    );
  });
  noble.on('warning', (message) => adapterLog?.(`noble warning: ${message}`));
}

function loadNoble() {
  let noble;
  try {
    noble = require('@stoprocent/noble');
  } catch {
    throw new Error(
      'Bluetooth support needs the noble package:\n\n' +
        '  npm install @stoprocent/noble\n\n' +
        'On macOS the terminal also needs Bluetooth permission:\n' +
        'System Settings -> Privacy & Security -> Bluetooth.'
    );
  }
  instrument(noble);
  return noble;
}

// noble reports addresses lowercased and without separators on some platforms.
function normalize(address) {
  return String(address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

// The same characteristic can be reported as "7200", "00007200", or the full
// 128-bit form depending on platform. Reduce all three to one comparable value.
const BASE_UUID_SUFFIX = '00001000800000805f9b34fb';

function canonUuid(uuid) {
  let flat = normalize(uuid);
  if (flat.length === 32 && flat.endsWith(BASE_UUID_SUFFIX)) flat = flat.slice(0, 8);
  return flat.replace(/^0+/, '') || '0';
}

// Each unusable adapter state has a different cause, and the wrong advice here
// actively misleads — telling someone to power the adapter up is the opposite
// of what exclusive mode needs.
function adapterStateHint(state) {
  if (process.platform !== 'linux') return '';

  const exclusive = Boolean(process.env.HCI_CHANNEL_USER);

  if (state === 'unsupported') {
    // noble reports "unsupported" whenever its init throws, not only for a
    // genuine lack of BLE. In exclusive mode the usual cause is a missing
    // capability: binding the HCI user channel needs CAP_NET_ADMIN, which is
    // a separate check from the CAP_NET_RAW an ordinary socket needs.
    return exclusive
      ? '\n\nExclusive mode could not initialise the adapter. Binding the HCI user\n' +
          'channel needs CAP_NET_ADMIN as well as CAP_NET_RAW:\n' +
          `  sudo setcap cap_net_raw,cap_net_admin+eip ${process.execPath}\n` +
          'It also needs the kernel to have released the adapter:\n' +
          '  sudo systemctl stop bluetooth && sudo hciconfig hci0 down'
      : '\n\nnoble could not initialise the adapter. Check it exists (`hciconfig`)\n' +
          'and that this process may use it:\n' +
          `  sudo setcap cap_net_raw,cap_net_admin+eip ${process.execPath}`;
  }

  if (state === 'unauthorized') {
    return (
      '\n\nNo permission to use the Bluetooth adapter:\n' +
      `  sudo setcap cap_net_raw,cap_net_admin+eip ${process.execPath}`
    );
  }

  // "unknown" is noble's starting state: it never got as far as reporting
  // whether the adapter works. Almost always the HCI socket could not be
  // opened, and capabilities are granted per binary — so name the one in use,
  // since running a different node than the one that was granted them is the
  // usual cause.
  if (state === 'unknown') {
    return (
      '\n\nnoble never initialised the adapter, which usually means it could not\n' +
      'open the HCI socket. Capabilities are granted per binary, and this run is\n' +
      `using:\n  ${process.execPath}\n\n` +
      'Grant them to that exact binary:\n' +
      `  sudo setcap cap_net_raw,cap_net_admin+eip ${process.execPath}\n` +
      'Check with: getcap "$(which node)"'
    );
  }

  // poweredOff, and anything else.
  return exclusive
    ? '\n\nIn exclusive mode noble powers the adapter itself, so leave it down —\n' +
        'do not run `hciconfig hci0 up`. Check bluetoothd is not holding it:\n' +
        '  systemctl is-active bluetooth'
    : '\n\nThe adapter is not powered on. bluetoothd normally does that:\n' +
        '  sudo systemctl start bluetooth\n' +
        'Or, if it was stopped deliberately:\n' +
        '  sudo rfkill unblock bluetooth && sudo hciconfig hci0 up';
}

async function ensurePoweredOn(noble) {
  if (noble.state === 'poweredOn') return;
  await noble.waitForPoweredOnAsync(10000).catch(() => {
    throw new Error(
      `Bluetooth is not available (adapter state: ${noble.state}).${adapterStateHint(noble.state)}`
    );
  });
}

// The adapter takes one owner at a time. When something else holds it, the
// HCI layer rejects our commands with codes that say nothing useful on their
// own — so explain the situation rather than passing the code through.
const CONTENTION = /command disallowed|0xc\b|0x0c|0x0a|busy|EPERM|not permitted|already/i;

function explainAdapterError(err) {
  if (!CONTENTION.test(err.message)) return err;

  return new Error(
    `${err.message}\n\n` +
      'The Bluetooth adapter rejected the command, which means another process\n' +
      'owns it. Only one client can drive an adapter at a time:\n' +
      '  - Homebridge running this plugin keeps a raw HCI socket open and retries\n' +
      '    on a timer, which blocks everyone else. Stop it before testing:\n' +
      '      sudo systemctl stop homebridge && pgrep -af homebridge\n' +
      '  - Confirm nothing else holds it: sudo btmon  (look for "RAW Open")\n' +
      '  - Or the adapter is stuck with scanning left enabled:\n' +
      '      sudo hciconfig hci0 down && sudo hciconfig hci0 up'
  );
}

// noble surfaces link-layer failures as a bare HCI code, which says nothing on
// its own. These are the ones that actually come up driving a battery lock.
const HCI_REASONS = {
  8: 'connection timed out — the lock stopped responding',
  19: 'the lock closed the connection',
  22: 'connection terminated locally',
  34: 'link-layer response timed out',
  40: 'instant passed — timing between the radios slipped',
  62:
    'connection failed to be established — the lock never completed the ' +
    'handshake. Usually it is still holding an earlier session (power-cycle ' +
    'it), or the radio link is too contended to complete',
};

// Turns "Disconnected 62" into something that names the actual problem.
function explainHciError(err) {
  const match = /(?:disconnected|reason)\D{0,3}(\d{1,3})\b/i.exec(err.message || '');
  if (!match) return err;

  const code = Number(match[1]);
  const reason = HCI_REASONS[code];
  if (!reason) return err;

  return new Error(`${err.message} (0x${code.toString(16)}: ${reason})`);
}

// Every identifier a peripheral can be recognised by. Linux reports the real
// MAC address (and uses it as the id); macOS withholds it and substitutes a
// per-machine UUID, so both are checked and either is enough.
function identifiersOf(peripheral) {
  return [peripheral.id, peripheral.address].filter(Boolean).map(normalize);
}

// Locks are identified by the service they advertise when nothing specific is
// asked for, since that works on every platform.
async function findLocks(noble, { timeoutMs, ids }) {
  const wanted = ids && ids.length ? new Set(ids.map(normalize)) : null;
  const lockService = canonUuid(SERVICE_LOCK);
  const found = new Map();

  return new Promise((resolve, reject) => {
    const done = (err) => {
      noble.removeListener('discover', onDiscover);
      clearTimeout(timer);
      noble.stopScanningAsync().then(
        () => (err ? reject(err) : resolve(found)),
        () => (err ? reject(err) : resolve(found))
      );
    };

    const onDiscover = (peripheral) => {
      if (found.has(peripheral.id)) return;

      const advertised = (peripheral.advertisement?.serviceUuids || []).map(canonUuid);
      const isWanted = wanted
        ? identifiersOf(peripheral).some((id) => wanted.has(id))
        : advertised.includes(lockService);
      if (!isWanted) return;

      found.set(peripheral.id, peripheral);
      if (wanted && found.size === wanted.size) done();
    };

    const timer = setTimeout(() => done(), timeoutMs);
    noble.on('discover', onDiscover);
    noble.startScanningAsync([], true).catch(done);
  });
}

async function inspect(peripheral) {
  await peripheral.connectAsync();
  try {
    const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    const uuids = characteristics.map((c) => canonUuid(c.uuid));

    const keyKind = Object.entries(KEY_KINDS).find(([prefix]) => uuids.includes(canonUuid(prefix)));
    return {
      characteristics: uuids,
      hasData: uuids.includes(canonUuid(SERVICE_DATA)),
      keyKind: keyKind ? { uuid: keyKind[0], ...keyKind[1] } : null,
    };
  } finally {
    await peripheral.disconnectAsync().catch(() => {});
  }
}

async function probe({ ids = [], timeoutMs = 20000 } = {}) {
  const noble = loadNoble();
  await ensurePoweredOn(noble);

  const found = await findLocks(noble, { timeoutMs, ids }).catch((err) => {
    throw explainAdapterError(err);
  });

  const results = [];
  for (const peripheral of found.values()) {
    const base = {
      id: peripheral.id,
      name: peripheral.advertisement?.localName || null,
      rssi: peripheral.rssi,
    };
    try {
      results.push({ ...base, ...(await inspect(peripheral)) });
    } catch (err) {
      results.push({ ...base, error: err.message });
    }
  }
  return results;
}

// macOS (CoreBluetooth) refuses to hand out peripheral MAC addresses, so the
// addresses the app API gives us cannot be matched against a scan there. This
// dumps everything nearby instead, so we can find the locks by advertised
// service UUID or name and see whether Bluetooth is working at all.
async function scanAll({ timeoutMs = 15000 } = {}) {
  const noble = loadNoble();
  await ensurePoweredOn(noble);

  const seen = new Map();
  const onDiscover = (p) => {
    const ad = p.advertisement || {};
    seen.set(p.id, {
      id: p.id,
      address: p.address && p.address !== 'unknown' ? p.address : null,
      name: ad.localName || null,
      rssi: p.rssi,
      serviceUuids: (ad.serviceUuids || []).map(canonUuid),
      manufacturerData: ad.manufacturerData ? ad.manufacturerData.toString('hex') : null,
    });
  };

  noble.on('discover', onDiscover);
  try {
    await noble.startScanningAsync([], true);
  } catch (err) {
    noble.removeListener('discover', onDiscover);
    throw explainAdapterError(err);
  }
  await new Promise((r) => setTimeout(r, timeoutMs));
  noble.removeListener('discover', onDiscover);
  await noble.stopScanningAsync().catch(() => {});

  const lockService = canonUuid(SERVICE_LOCK);
  return [...seen.values()]
    .map((d) => ({
      ...d,
      // Either signal is good enough to shortlist a candidate.
      isLock:
        d.serviceUuids.includes(lockService) ||
        /ultraloq|u-?bolt|utec|latch|smartlock/i.test(d.name || ''),
    }))
    .sort((a, b) => b.rssi - a.rssi);
}

// Deliberately no connect-by-address helper here.
//
// noble's `connectAsync(address)` does not register a peripheral for an address
// it has not discovered. The controller connects anyway, noble's `_onConnect`
// finds nothing in its registry, warns "unknown peripheral <id> connected!",
// and never resolves — so the caller hangs while an untracked connection stays
// open. On a lock that permits one connection at a time, that leaked link
// blocks every subsequent attempt. Discover first; see locks.reachLock.

// Scan and hand back live peripheral objects, ready to connect.
async function findPeripherals({ ids = [], timeoutMs = 20000 } = {}) {
  const noble = loadNoble();
  await ensurePoweredOn(noble);
  const found = await findLocks(noble, { timeoutMs, ids }).catch((err) => {
    throw explainAdapterError(err);
  });
  return [...found.values()];
}

module.exports = {
  probe, scanAll, findPeripherals, identifiersOf, normalize,
  explainAdapterError, explainHciError, setAdapterLogger,
  KEY_KINDS, SERVICE_LOCK, canonUuid,
};
