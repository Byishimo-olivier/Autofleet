// Simple tracking simulator for device API updates.
// Usage:
//   node scripts/track-sim.js
//
// Env vars:
//   BACKEND_URL=http://localhost:5000
//   VEHICLE_ID=12
//   BOOKING_ID=34            (optional)
//   DEVICE_KEY=trk_...       (optional if you provide AUTH_TOKEN)
//   AUTH_TOKEN=eyJ...        (optional; used to register a device key)
//   LABEL=Demo Device        (optional)
//
// If DEVICE_KEY is missing and AUTH_TOKEN is provided, the script will
// register a device key via /api/tracking/device/register.

const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/+$/, "");
const VEHICLE_ID = process.env.VEHICLE_ID;
const BOOKING_ID = process.env.BOOKING_ID;
const DEVICE_KEY = process.env.DEVICE_KEY;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const LABEL = process.env.LABEL || "Demo Device";

if (!VEHICLE_ID) {
  console.error("Missing VEHICLE_ID env var.");
  process.exit(1);
}

const jsonHeaders = {
  "Content-Type": "application/json",
};

async function registerDevice() {
  if (!AUTH_TOKEN) return null;
  const res = await fetch(`${BACKEND_URL}/api/tracking/device/register`, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ vehicle_id: Number(VEHICLE_ID), label: LABEL }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.message || `Device register failed (${res.status})`);
  }
  return data?.data?.api_key || data?.api_key || null;
}

function randomOffset() {
  return (Math.random() - 0.5) * 0.002; // ~200m jitter
}

async function sendUpdate(deviceKey, lat, lng, step) {
  const payload = {
    latitude: lat,
    longitude: lng,
    speed: Math.round(30 + Math.random() * 20),
    fuel_level: Math.round(40 + Math.random() * 50),
    mileage: 1000 + step * 2,
    status: "online",
  };
  if (BOOKING_ID) payload.booking_id = Number(BOOKING_ID);

  const res = await fetch(`${BACKEND_URL}/api/tracking/device/update`, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      "x-device-key": deviceKey,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.message || `Tracking update failed (${res.status})`);
  }
  return data;
}

async function main() {
  let key = DEVICE_KEY;
  if (!key) {
    console.log("No DEVICE_KEY provided. Registering a new device key...");
    key = await registerDevice();
    if (!key) {
      console.error("Failed to register a device key. Provide AUTH_TOKEN or DEVICE_KEY.");
      process.exit(1);
    }
    console.log("Device key registered:", key);
  }

  // Start around Kigali as default
  let lat = -1.9441;
  let lng = 30.0619;

  console.log("Sending tracking updates to", `${BACKEND_URL}/api/tracking/device/update`);
  let step = 0;
  setInterval(async () => {
    try {
      lat += randomOffset();
      lng += randomOffset();
      const data = await sendUpdate(key, lat, lng, step);
      console.log(`Update ${step + 1} OK`, data?.message || "");
      step += 1;
    } catch (err) {
      console.error("Update failed:", err.message || err);
    }
  }, 5000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
