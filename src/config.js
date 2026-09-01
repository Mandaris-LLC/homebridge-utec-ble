'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.u-tec');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${CONFIG_FILE}: ${err.message}`);
  }
}

function write(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function update(patch) {
  const next = { ...read(), ...patch };
  write(next);
  return next;
}

module.exports = { CONFIG_FILE, read, write, update };
