'use strict';

// One HomeKit LockMechanism backed by a LockController.
//
// HomeKit separates LockCurrentState (what the bolt is doing) from
// LockTargetState (what was asked for). Keeping them distinct is what makes a
// jam visible: the target stays Secured while the current state reports JAMMED,
// so Home shows the failure rather than a lie.

const JAMMED_CLEAR_MS = 30000;

class LockAccessory {
  constructor(platform, accessory, controller) {
    this.platform = platform;
    this.accessory = accessory;
    this.controller = controller;
    this.log = platform.log;

    const { Service, Characteristic } = platform.api.hap;
    this.Characteristic = Characteristic;

    const lock = controller.credential;
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'U-tec')
      .setCharacteristic(Characteristic.Model, lock.model || 'Ultraloq')
      .setCharacteristic(Characteristic.SerialNumber, lock.serial || lock.address || lock.name);

    this.service =
      accessory.getService(Service.LockMechanism) ||
      accessory.addService(Service.LockMechanism, lock.name);

    this.service
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => this.currentState());

    this.service
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => this.targetState())
      .onSet((value) => this.setTarget(value));

    // Battery is reported on a 0-3 scale, so surface low-battery rather than
    // inventing a percentage the lock never gave us.
    this.battery =
      accessory.getService(Service.Battery) || accessory.addService(Service.Battery, `${lock.name} Battery`);
    this.battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.lowBattery());

    this._target = null;
    this._jammedTimer = null;

    controller.on('state', (state) => this.onState(state));
    controller.on('unreachable', () => this.onUnreachable());
  }

  // HomeKit's LockCurrentState: 0 unsecured, 1 secured, 2 jammed, 3 unknown.
  currentState() {
    const C = this.Characteristic.LockCurrentState;
    switch (this.controller.state?.state) {
      case 'Locked':
        return C.SECURED;
      case 'Unlocked':
        return C.UNSECURED;
      case 'Jammed':
        return C.JAMMED;
      default:
        return C.UNKNOWN;
    }
  }

  targetState() {
    const C = this.Characteristic.LockTargetState;
    if (this._target !== null) return this._target;
    return this.controller.state?.state === 'Unlocked' ? C.UNSECURED : C.SECURED;
  }

  lowBattery() {
    const C = this.Characteristic.StatusLowBattery;
    const level = this.controller.state?.battery;
    if (level === undefined) return C.BATTERY_LEVEL_NORMAL;
    return level <= 1 ? C.BATTERY_LEVEL_LOW : C.BATTERY_LEVEL_NORMAL;
  }

  onState(state) {
    const C = this.Characteristic;
    this.service.updateCharacteristic(C.LockCurrentState, this.currentState());
    this.battery.updateCharacteristic(C.StatusLowBattery, this.lowBattery());

    // Someone used the keypad: follow the lock rather than fighting it.
    if (state.state === 'Locked' || state.state === 'Unlocked') {
      this._target = state.state === 'Locked' ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED;
      this.service.updateCharacteristic(C.LockTargetState, this._target);
      clearTimeout(this._jammedTimer);
      this._jammedTimer = null;
    }

    if (state.state === 'Jammed') this.holdJammed();
  }

  // HomeKit clears JAMMED on its own once a new state arrives; if none does,
  // stop asserting a stale jam.
  holdJammed() {
    clearTimeout(this._jammedTimer);
    this._jammedTimer = setTimeout(() => {
      this._jammedTimer = null;
      this.controller.read().catch(() => {});
    }, JAMMED_CLEAR_MS);
  }

  onUnreachable() {
    this.service.updateCharacteristic(this.Characteristic.LockCurrentState, this.currentState());
  }

  async setTarget(value) {
    const C = this.Characteristic;
    const wantLocked = value === C.LockTargetState.SECURED;
    this._target = value;

    try {
      const result = await this.controller.set(wantLocked);
      const reached = result.state?.state === (wantLocked ? 'Locked' : 'Unlocked');

      if (reached) {
        this.log.info(`${this.controller.name}: ${wantLocked ? 'locked' : 'unlocked'}`);
      } else if (result.state?.state === 'Jammed') {
        this.log.error(
          `${this.controller.name}: JAMMED — accepted the command but the bolt did not move. ` +
            'Check door alignment and battery.'
        );
      } else {
        this.log.warn(
          `${this.controller.name}: could not confirm ${wantLocked ? 'lock' : 'unlock'}; ` +
            `state reads ${result.state?.state || 'unknown'}`
        );
      }

      this.service.updateCharacteristic(C.LockCurrentState, this.currentState());

      // Report the failure to HomeKit rather than leaving the target asserted.
      if (!reached) {
        this._target = null;
        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
        );
      }
    } catch (err) {
      this._target = null;
      if (err instanceof this.platform.api.hap.HapStatusError) throw err;

      this.log.error(`${this.controller.name}: ${wantLocked ? 'lock' : 'unlock'} failed — ${err.message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
      );
    }
  }
}

module.exports = { LockAccessory };
