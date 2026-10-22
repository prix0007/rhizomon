// Synthetic network for the static demo (GitHub Pages) and for ?demo. Everything here is invented:
// MACs, names, vendors and addresses belong to no real device or network.
//
// The model is pure (no timers, no DOM) so it can be tested; createDemo() wraps it in an
// EventSource-like object and a fetch replacement so the UI runs its normal code paths.
import { fakeSample } from './traffic.js';

const SUBNET = '192.168.50';
const GATEWAY_ID = 'd0:0d:00:00:00:01';
const SELF_ID = 'd0:0d:00:00:00:02';
const LATE_ID = '02:de:00:00:00:0f';

const NAME_MAX = 64;
const NOTES_MAX = 500;

// [id, last octet, kind, vendor, hostname, extras, baseline rtt ms]
const SEED = [
  [GATEWAY_ID, 1, 'gateway', 'Example Networks', 'demo-router', { is_gateway: true, friendly_name: 'Demo Router', manufacturer: 'Example Networks', model: 'ER-100' }, 1.2],
  [SELF_ID, 20, 'computer', 'Example Computers', 'demo-laptop', { is_self: true, os_hint: 'macOS-like' }, 0.3],
  ['d0:0d:00:00:00:03', 31, 'tv', 'Sample Electronics', '3c1d9a52-77be-4c0e-91aa', { friendly_name: 'Living Room TV', services: ['_googlecast', '_airplay'], ssdp_server: 'Linux/5.15, UPnP/1.0, DemoCast/1.0', model: 'DemoCast 4K' }, 6],
  ['02:de:00:00:00:04', 42, 'phone', null, 'demo-phone', { randomized_mac: true, os_hint: 'Android-like' }, 14],
  ['02:de:00:00:00:05', 43, 'phone', null, 'demo-pocket', { randomized_mac: true }, 18],
  ['d0:0d:00:00:00:06', 50, 'printer', 'Inkwell Imaging', 'demo-printer', { services: ['_ipp', '_printer'], friendly_name: 'Office Printer' }, 9],
  ['d0:0d:00:00:00:07', 60, 'nas', 'Silverbox', 'demo-nas', { services: ['_smb', '_afpovertcp'], friendly_name: 'Home NAS' }, 2.4],
  ['d0:0d:00:00:00:08', 71, 'iot', 'Plugly', null, {}, 22],
  ['d0:0d:00:00:00:09', 72, 'speaker', 'Sample Electronics', 'kitchen-speaker', { services: ['_googlecast'], friendly_name: 'Kitchen Speaker' }, 11],
  ['d0:0d:00:00:00:0a', 73, 'iot', 'Warmly', 'demo-thermostat', {}, 30],
  ['d0:0d:00:00:00:0b', 74, 'camera', 'Lumenview', null, { friendly_name: 'Garden Camera' }, 16],
  ['02:de:00:00:00:0c', 80, 'unknown', null, null, { randomized_mac: true }, 25],
  ['d0:0d:00:00:00:0d', 90, 'console', 'Playbox', 'demo-console', { offline: 7 * 3600 * 1000 }, 0],
  ['02:de:00:00:00:0e', 91, 'unknown', null, null, { randomized_mac: true, offline: 26 * 3600 * 1000 }, 0],
];

const LATE = [LATE_ID, 99, 'phone', null, 'guest-phone', { randomized_mac: true }, 20];

function make(row, now) {
  const [id, last, kind, vendor, hostname, x, rtt] = row;
  const offline = typeof x.offline === 'number';
  const { offline: _o, ...extra } = x;
  return {
    id, mac: id, ip: `${SUBNET}.${last}`, vendor, hostname, hostname_source: hostname ? 'mdns' : null, kind,
    services: [], ssdp_server: null, ssdp_types: [], ssdp_location: null,
    is_gateway: false, is_self: false, randomized_mac: false, shared_mac: false,
    online: !offline, first_seen: now - 3 * 86400000, last_seen: offline ? now - x.offline : now, is_new: false,
    rtt_ms: offline ? null : rtt, custom_name: null, notes: null, friendly_name: null, manufacturer: null, model: null,
    dns_name: null, netbios_name: null, os_hint: null,
    ...extra,
  };
}

/** Validate and apply a rename/notes update like the real endpoint: null clears, limits 64 / 500. Returns an error string or null. */
export function applyMeta(device, body) {
  if (!body || typeof body !== 'object') return 'bad request';
  const field = (v, max) => {
    if (v === null || v === undefined) return { ok: true, v: null };
    if (typeof v !== 'string') return { ok: false };
    const t = v.trim();
    if ([...t].length > max) return { ok: false };
    return { ok: true, v: t === '' ? null : t };
  };
  const n = field(body.custom_name, NAME_MAX);
  const t = field(body.notes, NOTES_MAX);
  if (!n.ok || !t.ok) return 'value too long or not a string';
  device.custom_name = n.v;
  device.notes = t.v;
  return null;
}

/**
 * The synthetic network over time. `clock()` gives wall-clock ms (injected for tests).
 * step() advances one second and returns the events the UI would receive:
 * { type: 'device' | 'scan' | 'traffic', data }.
 */
export function createDemoModel(clock = Date.now, seed = 7) {
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const t0 = clock();
  const devices = new Map(SEED.map((row) => [row[0], make(row, t0)]));
  const base = new Map(SEED.map((row) => [row[0], row[6]]));
  base.set(LATE_ID, LATE[6]);
  let tick = 0;

  const list = () => [...devices.values()];
  const status = () => ({
    scan_started_at: clock() - 4000, scan_finished_at: clock() - 1500,
    devices: devices.size, online: list().filter((d) => d.online).length,
    iface: 'en0', net: `${SUBNET}.0/24`, gateway: `${SUBNET}.1`, interval_s: 30, ping_method: 'demo', mdns_available: true, warnings: [],
  });
  const snapshot = () => ({ devices: list().map((d) => ({ ...d })), status: status() });

  function step() {
    tick++;
    const now = clock();
    const events = [];
    const touch = (d) => events.push({ type: 'device', data: { ...d } });

    if (tick % 4 === 0) {
      // jitter a few round-trip times so the latency pulses and panel move
      const online = list().filter((d) => d.online && !d.is_self);
      for (let k = 0; k < 3 && online.length; k++) {
        const d = online[Math.floor(rand() * online.length)];
        const b = base.get(d.id) || 10;
        d.rtt_ms = Math.round(Math.max(0.4, b * (0.6 + rand() * 0.9)) * 10) / 10;
        d.last_seen = now;
        touch(d);
      }
    }
    const cycle = tick % 90;
    const speaker = devices.get('d0:0d:00:00:00:09');
    if (cycle === 12 && speaker.online) {
      speaker.online = false; speaker.rtt_ms = null; touch(speaker);
    }
    if (cycle === 30 && !speaker.online) {
      speaker.online = true; speaker.rtt_ms = base.get(speaker.id); speaker.last_seen = now; touch(speaker);
    }
    if (tick === 20 && !devices.has(LATE_ID)) {
      const d = make(LATE, now);
      d.is_new = true; d.first_seen = now;
      devices.set(LATE_ID, d);
      touch(d);
    }
    if (tick === 80 && devices.has(LATE_ID)) {
      devices.get(LATE_ID).is_new = false;
      touch(devices.get(LATE_ID));
    }
    if (tick % 6 === 0) events.push({ type: 'scan', data: status() });
    // Capture is shown as unavailable, as it would be without the opt-in flag.
    const sample = fakeSample(tick, { ids: list().map((d) => d.id), selfId: SELF_ID, withCapture: false });
    sample.ts = now;
    sample.capture = { enabled: false, available: false, reason: 'Demo: packet capture is not available for synthetic data.', flows: [] };
    events.push({ type: 'traffic', data: sample });
    return events;
  }

  /** Simulated PUT /api/devices/{id}/meta. Returns { status, body }. */
  function rename(id, body) {
    const d = devices.get(id);
    if (!d) return { status: 404, body: { error: 'not found' } };
    const err = applyMeta(d, body);
    if (err) return { status: 400, body: { error: err } };
    return { status: 200, body: { ...d } };
  }

  return { devices, snapshot, step, rename, status, get tick() { return tick; } };
}

/**
 * Browser wrapper: an EventSource-like object and a fetch replacement driven by one
 * interval, which is cleared while the tab is hidden (so nothing piles up) and
 * restarted when it is visible again. The demo clock only advances while visible.
 */
export function createDemo() {
  const model = createDemoModel();
  const listeners = new Map();
  const source = {
    onopen: null,
    onerror: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    close() {
      stop();
    },
  };
  const emit = (type, data) => {
    for (const fn of listeners.get(type) || []) fn({ data: JSON.stringify(data) });
  };

  let timer = 0;
  const run = () => {
    for (const e of model.step()) emit(e.type, e.data);
  };
  const start = () => {
    if (!timer) timer = setInterval(run, 1000);
  };
  function stop() {
    clearInterval(timer);
    timer = 0;
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  setTimeout(() => {
    if (source.onopen) source.onopen();
    emit('snapshot', model.snapshot());
    emit('traffic', (() => { const e = model.step().find((x) => x.type === 'traffic'); return e.data; })());
    if (!document.hidden) start();
  }, 0);

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function demoFetch(url, init = {}) {
    const m = /^\/api\/devices\/([^/]+)\/meta$/.exec(String(url));
    if (m && String(init.method || 'GET').toUpperCase() === 'PUT') {
      let body = null;
      try {
        body = JSON.parse(init.body);
      } catch {
        return json(400, { error: 'bad json' });
      }
      const id = decodeURIComponent(m[1]);
      const r = model.rename(id, body);
      if (r.status === 200) emit('device', r.body); // the real server also pushes the update over SSE
      return json(r.status, r.body);
    }
    return json(404, { error: 'demo mode has no such endpoint' });
  }

  return { source, fetch: demoFetch, model };
}
