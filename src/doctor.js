'use strict';

// Environment checks for the things that actually stop this working, none of
// which are visible from inside the process: another owner of the Bluetooth
// adapter, stale links, a second Homebridge process, or keys cached under the
// wrong account.

const { execFileSync } = require('child_process');
const os = require('os');

const config = require('./config');

function run(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    // A non-zero exit is often the answer itself (`is-active` on a dead unit).
    const out = (err.stdout || '').trim();
    return out || null;
  }
}

function has(cmd) {
  return Boolean(run('sh', ['-c', `command -v ${cmd}`]));
}

const OK = 'ok';
const WARN = 'warn';
const BAD = 'problem';

function checkKeys() {
  const locks = config.read().bleLocks;
  if (!locks || !locks.length) {
    return {
      status: BAD,
      title: 'Cached lock keys',
      detail: `None found in ${config.CONFIG_FILE}`,
      fix: 'Run `utec link` as the same user Homebridge runs as (use sudo -H -u <user>).',
    };
  }
  return {
    status: OK,
    title: 'Cached lock keys',
    detail: `${locks.length} lock(s) in ${config.CONFIG_FILE}: ${locks.map((l) => l.name).join(', ')}`,
  };
}

// Running is the right state: bluetoothd configures the adapter (LE parameters,
// connection defaults) that noble then uses, and stopping it powers the adapter
// down, since that is what brings it up. It is reported only because it can
// contend for the adapter, and is worth ruling out if links come up and die.
function checkBluetoothd() {
  if (os.platform() !== 'linux' || !has('systemctl')) {
    return { status: OK, title: 'bluetoothd', detail: 'not applicable on this platform' };
  }
  const active = run('systemctl', ['is-active', 'bluetooth']);
  if (active === 'active') {
    return { status: OK, title: 'bluetoothd', detail: 'running (normal — it configures the adapter)' };
  }
  return {
    status: WARN,
    title: 'bluetoothd',
    detail: `not running (${active || 'inactive'}) — it normally configures the adapter`,
    fix:
      'Unless it was stopped deliberately, start it: sudo systemctl start bluetooth\n' +
      '      A bare `hciconfig hci0 up` is not equivalent — the LE parameters differ.',
  };
}

function checkStaleLinks() {
  if (!has('hcitool')) {
    return { status: OK, title: 'Open Bluetooth links', detail: 'hcitool not installed; skipped' };
  }
  const out = run('hcitool', ['con']) || '';
  const links = out.split('\n').filter((l) => /handle/i.test(l));
  if (!links.length) return { status: OK, title: 'Open Bluetooth links', detail: 'none' };

  return {
    status: WARN,
    title: 'Open Bluetooth links',
    detail: `${links.length} already open:\n      ${links.map((l) => l.trim()).join('\n      ')}`,
    fix:
      'If the plugin is not connected, these are stale and will block it:\n' +
      '      sudo hciconfig hci0 down && sudo hciconfig hci0 up',
  };
}

// The adapter queue inside this plugin is process-local, so a second process
// using Bluetooth cannot be coordinated with at all.
function checkProcesses() {
  if (!has('pgrep')) {
    return { status: OK, title: 'Homebridge processes', detail: 'pgrep not available; skipped' };
  }
  const out = run('pgrep', ['-af', 'homebridge']) || '';
  const lines = out
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/pgrep/.test(l))
    // This process is usually run from the plugin directory, so it matches its
    // own search. Counting it would report a phantom extra Homebridge.
    .filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid);
  const children = lines.filter((l) => /child-bridge|childBridge/i.test(l));

  if (children.length > 1) {
    return {
      status: BAD,
      title: 'Homebridge processes',
      detail: `${children.length} child-bridge processes — orphans compete for the adapter`,
      fix: 'sudo systemctl restart homebridge, then re-check; kill survivors by pid.',
    };
  }

  // Homebridge running this plugin holds a raw HCI socket and retries
  // connections on a timer. The kernel then refuses anyone else's connect —
  // BlueZ reports "Busy" (mgmt status 0x0a) and noble's calls hang or fail with
  // 0x0C / 0x02 / 0x3E. Any CLI test taken while it runs measures the
  // contention, not the lock, so say so before that wastes an afternoon.
  if (lines.length) {
    return {
      status: WARN,
      title: 'Homebridge processes',
      detail:
        `${lines.length} running — it holds the Bluetooth adapter, so CLI tests ` +
        'will contend with it and fail misleadingly',
      fix:
        'Before testing from the CLI:\n' +
        '      sudo systemctl stop homebridge && pgrep -af homebridge\n' +
        '      (the second command should print nothing)',
    };
  }

  return { status: OK, title: 'Homebridge processes', detail: 'none running' };
}

function checkAdapter() {
  if (os.platform() !== 'linux') {
    return { status: OK, title: 'Bluetooth adapter', detail: `${os.platform()}; skipped` };
  }
  if (!has('hciconfig')) {
    return { status: OK, title: 'Bluetooth adapter', detail: 'hciconfig not installed; skipped' };
  }
  const out = run('hciconfig') || '';
  if (!out) {
    return {
      status: BAD,
      title: 'Bluetooth adapter',
      detail: 'no adapter reported',
      fix: 'Check the hardware is present and the kernel module is loaded.',
    };
  }
  const down = /\bDOWN\b/.test(out);
  const name = (out.match(/^(\w+):/m) || [, 'hci0'])[1];
  const exclusive = process.env.HCI_CHANNEL_USER;

  // In exclusive (user-channel) mode the kernel should NOT have the adapter up
  // — noble powers it itself — so the expected state is inverted.
  if (exclusive) {
    return down
      ? { status: OK, title: 'Bluetooth adapter', detail: `${name} is down, as exclusive mode needs` }
      : {
          status: WARN,
          title: 'Bluetooth adapter',
          detail: `${name} is up, but exclusive mode needs the kernel to release it`,
          fix: `sudo systemctl stop bluetooth && sudo hciconfig ${name} down`,
        };
  }

  return down
    ? {
        status: BAD,
        title: 'Bluetooth adapter',
        detail: `${name} is DOWN`,
        fix: `sudo hciconfig ${name} up  (or set HCI_CHANNEL_USER=1 for exclusive mode)`,
      }
    : { status: OK, title: 'Bluetooth adapter', detail: `${name} is up` };
}

// Native bindings must match the ABI of the Node that loads them.
function checkNoble() {
  try {
    require.resolve('@stoprocent/noble');
  } catch {
    return {
      status: BAD,
      title: 'noble',
      detail: 'not installed',
      fix: 'Install with the same npm as the Node that runs Homebridge.',
    };
  }
  try {
    require('@stoprocent/noble');
    return { status: OK, title: 'noble', detail: `loads under Node ${process.version}` };
  } catch (err) {
    return {
      status: BAD,
      title: 'noble',
      detail: `installed but will not load: ${err.message.split('\n')[0]}`,
      fix:
        'Usually an ABI mismatch. Reinstall with Homebridge\'s own npm:\n' +
        '      cd /var/lib/homebridge && sudo /opt/homebridge/bin/npm install <plugin>',
    };
  }
}

// Running the CLI by hand needs raw-socket capability on the node binary
// itself; the systemd drop-in only grants it to the Homebridge service.
function checkCapabilities() {
  if (os.platform() !== 'linux') {
    return { status: OK, title: 'Bluetooth capabilities', detail: 'not applicable on this platform' };
  }
  if (process.getuid && process.getuid() === 0) {
    return { status: OK, title: 'Bluetooth capabilities', detail: 'running as root' };
  }
  if (!has('getcap')) {
    return { status: OK, title: 'Bluetooth capabilities', detail: 'getcap not installed; skipped' };
  }

  const out = run('getcap', [process.execPath]) || '';
  const hasRaw = /cap_net_raw/i.test(out);
  // Exclusive (user-channel) mode binds the HCI user channel, which the kernel
  // gates on CAP_NET_ADMIN — a separate check from CAP_NET_RAW. Without it,
  // noble's init throws and it reports the adapter as "unsupported".
  const hasAdmin = /cap_net_admin/i.test(out);
  const exclusive = Boolean(process.env.HCI_CHANNEL_USER);
  const fix =
    'Needed to run this CLI by hand (the Homebridge service gets these from\n' +
    '      its systemd drop-in instead):\n' +
    `      sudo setcap cap_net_raw,cap_net_admin+eip ${process.execPath}`;

  if (hasRaw && (hasAdmin || !exclusive)) {
    return { status: OK, title: 'Bluetooth capabilities', detail: out || 'granted' };
  }
  if (hasRaw && !hasAdmin) {
    return {
      status: WARN,
      title: 'Bluetooth capabilities',
      detail: `${out} — exclusive mode also needs cap_net_admin`,
      fix,
    };
  }
  return {
    status: WARN,
    title: 'Bluetooth capabilities',
    detail: `${process.execPath} has no cap_net_raw`,
    fix,
  };
}

function diagnose() {
  return [
    checkKeys(),
    checkAdapter(),
    checkCapabilities(),
    checkNoble(),
    checkBluetoothd(),
    checkStaleLinks(),
    checkProcesses(),
  ];
}

module.exports = { diagnose, OK, WARN, BAD };
