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
  // Child bridges are not reliably identifiable from their command line, so
  // report the count without claiming to have classified them.
  return {
    status: OK,
    title: 'Homebridge processes',
    detail:
      `${lines.length} process(es)` +
      (children.length ? `, ${children.length} identifiable as child bridges` : '') +
      (lines.length > 2 ? ' — expected if other plugins also run as child bridges' : ''),
  };
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
  return down
    ? {
        status: BAD,
        title: 'Bluetooth adapter',
        detail: `${name} is DOWN`,
        fix: `sudo hciconfig ${name} up`,
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
    return { status: OK, title: 'Raw socket capability', detail: 'not applicable on this platform' };
  }
  if (process.getuid && process.getuid() === 0) {
    return { status: OK, title: 'Raw socket capability', detail: 'running as root' };
  }
  if (!has('getcap')) {
    return { status: OK, title: 'Raw socket capability', detail: 'getcap not installed; skipped' };
  }

  const out = run('getcap', [process.execPath]) || '';
  if (/cap_net_raw/i.test(out)) {
    return { status: OK, title: 'Raw socket capability', detail: out };
  }
  return {
    status: WARN,
    title: 'Raw socket capability',
    detail: `${process.execPath} has no cap_net_raw`,
    fix:
      'Needed to run this CLI by hand (the Homebridge service gets it from its\n' +
      '      systemd drop-in instead):\n' +
      `      sudo setcap cap_net_raw+eip ${process.execPath}`,
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
