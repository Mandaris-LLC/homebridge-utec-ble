# homebridge-utec-ble

HomeKit support for Ultraloq smart locks over Bluetooth — including locks behind
a Bridge adapter, which the U-tec cloud API cannot reach at all. Ships with a
`utec` CLI for setup and diagnostics.

Node 18+ and [@stoprocent/noble](https://www.npmjs.com/package/@stoprocent/noble).

## Homebridge

Run `utec link` first, as the **same user Homebridge runs as** — the plugin reads
the keys that caches and never signs in to U-tec itself. Then add the platform:

```json
{
  "platforms": [
    {
      "platform": "UtecBLE",
      "name": "Ultraloq BLE",
      "_bridge": { "username": "0E:12:34:56:78:90", "port": 51900 }
    }
  ]
}
```

`_bridge` runs it as a **child bridge**, which is strongly recommended: each lock
holds an open Bluetooth connection, and that work should not sit in Homebridge's
main process where a stall would affect every other accessory.

Optional settings: `locks` (an array of names — use it when one host cannot reach
every door) and `refreshMinutes` (the safety-net poll, default 15).

Each lock becomes a `LockMechanism` with a battery service. HomeKit's current and
target states are kept separate, so a jam shows up as a jammed lock rather than a
silent failure, and the command reports an error back to Home instead of
pretending it worked.

### State arrives by push

The connection to each lock is held open, so the lock reports changes as they
happen — including **keypad and manual use**, which appears in Home within
seconds without polling. Two consequences worth knowing:

- **These locks accept one connection at a time.** While the plugin holds it, the
  U-tec phone app cannot connect. Stopping Homebridge releases them.
- It costs lock battery. `refreshMinutes` only catches what pushes miss, so
  leave it infrequent.

## Why Bluetooth and not the cloud

U-tec publishes a [cloud OpenAPI](https://doc.api.u-tec.com), but it only exposes
locks whose connectivity is built into the lock. A lock that reaches the network
through the **Ultraloq Bridge** WiFi adapter never appears in its device
discovery, and no cloud command can reach it.

Bluetooth lives on the lock itself rather than the Bridge, so it works
regardless. The cost is range: the machine running this has to be near the door.

## Setup

```sh
npm install
npm link          # or run: node src/cli.js <command>

utec link         # sign in once, cache the locks' Bluetooth keys
utec status
```

On **Linux** that is all you need: the adapter reports each lock's real MAC
address, which is matched against what `link` cached.

On **macOS** CoreBluetooth withholds MAC addresses and substitutes a per-machine
UUID, so a lock cannot be recognised by address there. Run `utec pair` once — it
connects to each lock, reads its serial number, and records the local peripheral
id. Only needed on macOS, and only once per machine.

`utec link` talks to U-tec's **private** phone-app API, presenting itself as the
iOS app, because that is the only source for a lock's Bluetooth keys. Your
account password is used for that one exchange and is never written to disk; the
keys it returns are static, so this is a one-time step. Being an unofficial
interface, it can break without notice.

On macOS the terminal needs Bluetooth permission: System Settings → Privacy &
Security → Bluetooth. Without it every scan silently finds nothing.

## Use

```sh
utec status              # bolt state, mode, battery
utec unlock Front Door
utec lock Front Door
```

With one lock the name is optional; otherwise pass any part of it. Locks sleep to
save battery — if one is not found, touch its keypad and retry immediately.
`UTEC_DEBUG=1` traces every command and response frame.

### Diagnostics

```sh
utec scan [seconds]   # every nearby Bluetooth device
utec probe            # find the locks, report their key exchange
utec dump [lock]      # raw decrypted response frames (read-only)
utec forget           # discard the cached keys
```

## How it works

A lock is recognised by its MAC address where the platform reports one (Linux
does, and uses it as the peripheral id) or by the peripheral id `utec pair`
recorded. macOS reveals no MAC — CoreBluetooth substitutes a per-machine UUID —
which is why pairing by serial number exists at all. When nothing specific is
being looked for, locks are found by the service UUID they advertise (`7200`),
which works everywhere.

### Running on a Raspberry Pi

Bluetooth needs raw socket access. For a Homebridge service, grant it to the
service rather than the binary, since Homebridge replaces its bundled Node on
update and would silently drop a `setcap`:

```sh
sudo mkdir -p /etc/systemd/system/homebridge.service.d
sudo tee /etc/systemd/system/homebridge.service.d/bluetooth.conf <<'EOF'
[Service]
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN
EOF
sudo systemctl daemon-reload && sudo systemctl restart homebridge
```

To run by hand, `sudo setcap cap_net_raw+eip "$(readlink -f "$(which node)")"`.
noble's bindings are native, so install with the same npm as the Node that will
load them — `/opt/homebridge/bin/npm` on a packaged Homebridge — or expect
`NODE_MODULE_VERSION` errors. `libudev-dev` is required to build them.

[tools/ble-discover.js](tools/ble-discover.js) is a standalone scanner that
depends only on noble, for checking reachability before installing anything.

Commands go to characteristic `7201`, framed as:

```
0x7F | length (2, LE) | command | [uid][password] | [data] | CRC8
```

then encrypted in 16-byte blocks, each with a fresh AES-128-CBC context and a
zero IV — so chaining never carries between blocks, which is ECB in effect. The
CRC is CRC-8/Maxim (reflected, polynomial `0x8C`). A packet's total length is the
length field plus 3, with the CRC last.

Locks agree the AES key one of three ways depending on firmware — a static
characteristic, an MD5 derivation, or ECDH over SECP128r1. All three are
implemented; `utec probe` reports which a lock uses.

### Actuating commands must carry credentials

Reads (`LOCK_STATUS`, `GET_BATTERY`, `GET_SN`, …) are accepted unauthenticated,
but a U-Bolt Pro rejects an `UNLOCK` or `BOLT_LOCK` that carries no uid and
password — status byte `1` — **even after a successful `ADMIN_LOGIN`**. A
logged-in session is not enough; the credentials go in the actuating packet
itself.

This is worth spelling out because utecio cannot do it: its `UtecBleRequest`
takes an `auth_required` flag that no caller ever sets, so it sends every
command unauthenticated. Confirmed against real hardware: identical uid and
password bytes are accepted in an `ADMIN_LOGIN` and required again in the
`UNLOCK`.

`utec unlock` only reports success when a follow-up status read shows the bolt
actually moved; anything else prints both attempts with their status bytes and
exits non-zero.

### Response layout

A `LOCK_STATUS` (208) payload, as observed on a U-Bolt Pro:

| Offset | Meaning |
| --- | --- |
| 0 | lock state — `1` unlocked, `2` locked, `3` jammed |
| 1 | door sensor; `0` on units without one |
| 2 | battery, `0`–`3` |
| 3 | working mode — normal / passage / lockout |
| 4 | mute |
| 9.. | ASCII serial number |

The lock's state is byte 0 on that scale — *not* byte 1, which is a door-sensor
field these locks leave at `0` and would read as "unlocked" on every reading.
`GET_LOCK_STATUS` (209) returns `[mode, bolt sensor]` instead, and answers `255`
for the sensor on hardware that has none.

### One notification can hold several frames

A lock answers an actuating command twice: an immediate acknowledgement, then a
`LOCK_STATUS` with the real outcome once the motor has run — and both can arrive
concatenated inside a single 16-byte notification:

```
7f0300d600f2              BOLT_LOCK  accepted
7f0700d00003000200dd      LOCK_STATUS  state 3 = jammed
```

So responses are split on frame boundaries rather than assumed one-per-packet,
and the frame matching the command's own response code is the answer. A jam
reported by either the deferred frame or a follow-up read is surfaced as
`JAMMED`, since it means the bolt did not move and the door is not secured.

SECP128r1 is not in Node's crypto, so [src/ble/secp128r1.js](src/ble/secp128r1.js)
implements the group arithmetic over BigInt. It is interoperability code, not a
general-purpose crypto library, and is not constant-time. It is checked against
python-ecdsa across scalar multiplication, full ECDH, and invalid-point
rejection; the framing, CRC table and AES layer are checked byte-for-byte
against [utecio](https://github.com/maeneak/utecio), and the MD5 derivation
against its Python original.

## Layout

- [index.js](index.js) — Homebridge entry point
- [src/homebridge/platform.js](src/homebridge/platform.js) — dynamic platform, one accessory per lock
- [src/homebridge/accessory.js](src/homebridge/accessory.js) — the HomeKit LockMechanism
- [src/controller.js](src/controller.js) — holds a lock's connection open, reconnects, serialises commands
- [src/locks.js](src/locks.js) — lock identity and discovery, shared by the CLI and the platform
- [src/cli.js](src/cli.js) — commands and output
- [src/ble/cloud.js](src/ble/cloud.js) — the phone-app API, for fetching lock keys
- [src/ble/probe.js](src/ble/probe.js) — scanning and identification
- [src/ble/keyexchange.js](src/ble/keyexchange.js) — the three key-agreement schemes
- [src/ble/secp128r1.js](src/ble/secp128r1.js) — ECDH over the curve Node lacks
- [src/ble/protocol.js](src/ble/protocol.js) — framing, CRC, AES
- [src/ble/lock.js](src/ble/lock.js) — a session with a lock
- [src/config.js](src/config.js) — `~/.u-tec/config.json`, mode `0600`

## Credits

The Bluetooth protocol is derived from [utecio](https://github.com/maeneak/utecio)
by maeneak, whose reverse-engineering made this possible.
