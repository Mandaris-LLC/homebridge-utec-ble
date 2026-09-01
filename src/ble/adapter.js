'use strict';

// There is one Bluetooth adapter, and noble is a singleton wrapping it.
// Scanning is a global mode, not a per-device operation: when one caller stops
// scanning it stops for everyone, and connect attempts issued while another is
// in progress are rejected by the HCI layer with codes like 0x02 (Unknown
// Connection Identifier) or 0x0C (Command Disallowed).
//
// So every scan-and-connect is serialised here. Established connections may
// coexist happily — an adapter handles several links at once — it is only the
// setup that must not overlap.

let chain = Promise.resolve();
let queued = 0;
let active = false;

function withAdapter(fn) {
  queued += 1;
  const run = chain.then(
    async () => {
      queued -= 1;
      active = true;
      try {
        return await fn();
      } finally {
        active = false;
      }
    },
    async () => {
      queued -= 1;
      active = true;
      try {
        return await fn();
      } finally {
        active = false;
      }
    }
  );

  // Keep the chain alive whatever an individual caller does.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function adapterBusy() {
  return active || queued > 0;
}

module.exports = { withAdapter, adapterBusy };
