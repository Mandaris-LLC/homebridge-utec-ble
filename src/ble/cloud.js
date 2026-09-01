'use strict';

// The public OpenAPI does not expose locks that reach the network through a
// Bridge adapter, so those locks have to be driven locally over Bluetooth.
// Doing that needs each lock's BLE credentials, which only the U-tec phone app
// API hands out. This module speaks that private API, which means impersonating
// the app: the appid/clientid below are the iOS app's own.
//
// These credentials are static per lock, so `utec ble-link` fetches them once
// and caches them. The account password is used for that single exchange and
// never stored.

const crypto = require('crypto');

const TOKEN_URL = 'https://uemc.u-tec.com/app/token';
const LOGIN_URL = 'https://cloud.u-tec.com/app/user/login';
const ADDRESS_URL = 'https://cloud.u-tec.com/app/address';
const ROOM_URL = 'https://cloud.u-tec.com/app/room';
const DEVICE_URL = 'https://cloud.u-tec.com/app/device/list';

const APP_ID = '13ca0de1e6054747c44665ae13e36c2c';
const CLIENT_ID = '1375ac0809878483ee236497d57f371f';
const VERSION = 'V3.2';

const HEADERS = {
  accept: '*/*',
  'content-type': 'application/x-www-form-urlencoded',
  'user-agent': 'U-tec/2.1.14 (iPhone; iOS 15.1; Scale/3.00)',
  'accept-language': 'en-US;q=1, it-US;q=0.9',
};

// The app identifies itself with a random 32-char device id.
function mobileUuid() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (const byte of crypto.randomBytes(32)) out += alphabet[byte % alphabet.length];
  return out;
}

function timestamp() {
  return String(Date.now() / 1000);
}

async function post(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: new URLSearchParams(form),
  });

  const text = await res.text();
  if (process.env.UTEC_DEBUG) console.error(`[utec] ${url} -> HTTP ${res.status}\n${text}\n`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return body;
}

// The lock's admin password arrives as a packed integer: the top nibble is the
// digit count, the rest is the value, which is then zero-padded back to that
// length. Ported from utecio's decode_password.
function decodePassword(packed) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(packed >>> 0, 0);

  let hex = '';
  for (let i = 3; i >= 0; i--) hex += bytes[i].toString(16).padStart(2, '0');

  // The nibble is a digit count, so anything above 9 means we misread the
  // field. utecio returns null here; fail loudly rather than hand the lock a
  // silently wrong password.
  const declaredLength = parseInt(hex[0], 16);
  if (declaredLength > 9) throw new Error(`Unexpected password encoding (0x${hex}).`);
  if (!declaredLength) return String(packed);

  const value = String(parseInt(hex.slice(1), 16));
  return value.padStart(declaredLength, '0');
}

class UtecAppClient {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.uuid = mobileUuid();
    this.token = null;
  }

  async connect() {
    const tokenRes = await post(TOKEN_URL, {
      appid: APP_ID,
      clientid: CLIENT_ID,
      timezone: String(-new Date().getTimezoneOffset() / 60),
      uuid: this.uuid,
      version: VERSION,
    });
    if (tokenRes.error || !tokenRes.data || !tokenRes.data.token) {
      throw new Error(`Could not obtain an app token: ${JSON.stringify(tokenRes).slice(0, 200)}`);
    }
    this.token = tokenRes.data.token;

    const loginRes = await this.call(LOGIN_URL, {
      email: this.email,
      password: this.password,
    });
    if (loginRes.error) {
      throw new Error(
        'U-tec rejected that email/password. Note this is your U-tec account ' +
          'password, and accounts created via Apple/Google sign-in have none.'
      );
    }
  }

  // Every authenticated call posts a JSON `data` blob alongside the token.
  call(url, body = {}) {
    return post(url, {
      data: JSON.stringify({ ...body, timestamp: timestamp() }),
      token: this.token,
    });
  }

  // Devices hang off rooms, which hang off addresses, so walk the whole tree.
  async fetchDevices() {
    const devices = [];
    const addresses = (await this.call(ADDRESS_URL)).data || [];

    for (const address of addresses) {
      const rooms = (await this.call(ROOM_URL, { id: address.id })).data || [];
      for (const room of rooms) {
        const found = (await this.call(DEVICE_URL, { room_id: room.id })).data || [];
        devices.push(...found);
      }
    }
    return devices;
  }
}

// Reduce the app's device JSON to just what BLE control needs.
function toLockCredential(device) {
  const params = device.params || {};
  return {
    name: device.name,
    model: device.model,
    address: device.uuid, // the lock's BLE address
    uid: String(device.user.uid),
    password: decodePassword(device.user.password),
    // Battery-powered locks sleep; a wake-up receiver is woken first.
    wakeupAddress: params.extend_ble || null,
    serial: params.serialnumber || null,
  };
}

async function fetchLockCredentials(email, password) {
  const client = new UtecAppClient(email, password);
  await client.connect();
  const devices = await client.fetchDevices();
  return devices.map(toLockCredential);
}

module.exports = { UtecAppClient, fetchLockCredentials, decodePassword, toLockCredential };
