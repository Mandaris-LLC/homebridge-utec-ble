'use strict';

// Dynamic platform: one accessory per cached lock, each with a LockController
// holding its Bluetooth connection open.
//
// Locks come from `utec link`, which caches their Bluetooth keys in
// ~/.u-tec/config.json. The platform does not sign in to U-tec itself — the
// account password is only ever used by that one-off CLI step and is never
// stored, so there is nothing here for the plugin to hold.

const { LockController } = require('../controller');
const { LockAccessory } = require('./accessory');
const config = require('../config');
const locksModule = require('../locks');

const PLUGIN_NAME = 'homebridge-utec-ble';
const PLATFORM_NAME = 'UtecBLE';

class UtecPlatform {
  constructor(log, platformConfig, api) {
    this.log = log;
    this.config = platformConfig || {};
    this.api = api;
    this.accessories = new Map();
    this.controllers = [];

    // A Raspberry Pi's built-in radio shares its antenna with WiFi, and that
    // contention shows up as connections that fail to establish (HCI 0x3E)
    // while scanning still works. A USB dongle avoids it — this selects which
    // adapter noble binds to. It must be set before noble is first required,
    // which is why it happens here rather than at connect time.
    const adapter = this.config.adapter;
    if (Number.isInteger(adapter) && adapter >= 0 && process.platform === 'linux') {
      process.env.NOBLE_HCI_DEVICE_ID = String(adapter);
      this.log.info(`Using Bluetooth adapter hci${adapter}`);
    }

    api.on('didFinishLaunching', () => this.discover());
    api.on('shutdown', () => this.shutdown());
  }

  // Homebridge restores cached accessories before launching.
  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  loadLocks() {
    let locks;
    try {
      locks = locksModule.loadLocks();
    } catch (err) {
      this.log.error(
        `${err.message}\n` +
          `Run \`utec link\` as the user Homebridge runs as, so the keys land in that ` +
          `account's ~/.u-tec/config.json (${config.CONFIG_FILE} for this process).`
      );
      return [];
    }

    // `only` lets a second host take just some of the locks, which is useful
    // when one Pi cannot reach every door.
    const only = this.config.locks;
    if (Array.isArray(only) && only.length) {
      const wanted = new Set(only.map((n) => String(n).toLowerCase()));
      const filtered = locks.filter((l) => wanted.has(l.name.toLowerCase()));
      for (const name of wanted) {
        if (!locks.some((l) => l.name.toLowerCase() === name)) {
          this.log.warn(`Configured lock "${name}" is not in the cached keys; ignoring.`);
        }
      }
      return filtered;
    }
    return locks;
  }

  discover() {
    const locks = this.loadLocks();
    if (!locks.length) {
      this.log.warn('No locks to set up.');
      return;
    }

    const seen = new Set();
    const refreshIntervalMs = Number(this.config.refreshMinutes) > 0
      ? Number(this.config.refreshMinutes) * 60000
      : undefined;

    for (const lock of locks) {
      // Serial is stable across hosts; address is the fallback identity.
      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${lock.serial || lock.address}`);
      seen.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(lock.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info(`Added ${lock.name}`);
      }
      accessory.context.lock = { name: lock.name, serial: lock.serial, address: lock.address };

      const controller = new LockController(lock, {
        log: this.log,
        ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
      });
      new LockAccessory(this, accessory, controller);
      this.controllers.push(controller);
      controller.start();
    }

    // Drop accessories for locks no longer cached.
    for (const [uuid, accessory] of this.accessories) {
      if (seen.has(uuid)) continue;
      this.log.info(`Removing ${accessory.displayName}, no longer in the cached keys`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
    }
  }

  // Let go of the locks on the way out, so a phone can reach them again, then
  // release noble itself.
  //
  // noble's HCI socket keeps the event loop alive, so without that release the
  // child bridge never exits on SIGTERM and Homebridge kills it a few seconds
  // later — and a killed process leaves half-open links behind that stop the
  // next one connecting. The hard kill was causing the very failure it then
  // had to recover from.
  shutdown() {
    const stopping = this.controllers.map((c) => c.stop().catch(() => {}));

    Promise.allSettled(stopping).then(() => {
      try {
        require('@stoprocent/noble').stop();
        this.log.debug('Bluetooth released');
      } catch {
        // Nothing to release if noble never loaded.
      }
    });
  }
}

module.exports = { UtecPlatform, PLUGIN_NAME, PLATFORM_NAME };
