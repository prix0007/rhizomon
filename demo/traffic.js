// Traffic and link-quality logic. Pure: no DOM, no network. Tested with `node --test ui/tests/`.
//
// Honesty rules baked in here: a number is only "measured" when the backend says
// it was measured (capture on, `measured: true`); latency-derived pulses are
// labelled as such, and a stale or missing sample never shows frozen numbers.

export const STALE_MS = 5000;
export const HISTORY = 60;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Coerce whatever the server sent into a safe shape: numbers are finite and
 * non-negative or null, strings are strings or null, everything may be absent.
 * Returns null when the input is not an object at all.
 */
export function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw.host && typeof raw.host === 'object' ? raw.host : null;
  const l = h && h.link && typeof h.link === 'object' ? h.link : null;
  const w = raw.wan && typeof raw.wan === 'object' ? raw.wan : null;
  const c = raw.capture && typeof raw.capture === 'object' ? raw.capture : null;
  const devices = new Map();
  if (raw.devices && typeof raw.devices === 'object' && !Array.isArray(raw.devices)) {
    for (const [id, v] of Object.entries(raw.devices)) {
      if (!v || typeof v !== 'object') continue;
      devices.set(id, {
        loss_pct: num(v.loss_pct),
        jitter_ms: num(v.jitter_ms),
        rx_bps: num(v.rx_bps),
        tx_bps: num(v.tx_bps),
        measured: v.measured === true && (num(v.rx_bps) !== null || num(v.tx_bps) !== null),
      });
    }
  }
  const flows = [];
  if (c && Array.isArray(c.flows)) {
    for (const f of c.flows) {
      if (!f || typeof f !== 'object' || !str(f.src) || !str(f.dst)) continue;
      flows.push({ src: f.src, dst: f.dst, proto: str(f.proto) || 'other', bps: num(f.bps) ?? 0, pps: num(f.pps) ?? 0 });
    }
  }
  return {
    ts: num(raw.ts),
    host: h
      ? {
          iface: str(h.iface),
          rx_bps: num(h.rx_bps),
          tx_bps: num(h.tx_bps),
          link: l
            ? {
                kind: l.kind === 'wifi' || l.kind === 'ethernet' ? l.kind : null,
                rate_mbps: num(l.rate_mbps),
                rssi_dbm: typeof l.rssi_dbm === 'number' && Number.isFinite(l.rssi_dbm) ? l.rssi_dbm : null,
                noise_dbm: typeof l.noise_dbm === 'number' && Number.isFinite(l.noise_dbm) ? l.noise_dbm : null,
                channel: str(l.channel),
                phy: str(l.phy),
              }
            : null,
        }
      : null,
    wan: w && (num(w.rx_bps) !== null || num(w.tx_bps) !== null) ? { rx_bps: num(w.rx_bps), tx_bps: num(w.tx_bps), source: str(w.source) } : null,
    devices,
    capture: c
      ? { enabled: c.enabled === true, available: c.available === true, reason: str(c.reason), flows }
      : null,
  };
}

/** "1.2 Mbps", "480 kbps", "—" for missing. Fixed precision so the text does not jump in width. */
export function formatRate(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps < 0) return '—';
  const fix = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1e6) return `${fix(bps / 1e3)} kbps`;
  if (bps < 1e9) return `${fix(bps / 1e6)} Mbps`;
  return `${fix(bps / 1e9)} Gbps`;
}

/** Link speed from megabits per second: "866 Mbps", "1 Gbps". */
export function formatLinkRate(mbps) {
  if (typeof mbps !== 'number' || !Number.isFinite(mbps) || mbps <= 0) return null;
  return mbps >= 1000 ? `${Math.round((mbps / 1000) * 10) / 10} Gbps` : `${Math.round(mbps)} Mbps`;
}

/** Wi-Fi signal quality words from RSSI (dBm). */
export function signalQuality(rssi) {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi)) return null;
  if (rssi >= -50) return 'excellent';
  if (rssi >= -60) return 'good';
  if (rssi >= -70) return 'fair';
  return 'weak';
}

/**
 * Link description as { title, detail }: "Wi-Fi 866 Mbps" with
 * "good signal -52 dBm, 5 GHz ch 44, 802.11ax" or "Ethernet 1 Gbps".
 */
export function describeLink(link) {
  if (!link || !link.kind) return null;
  const rate = formatLinkRate(link.rate_mbps);
  if (link.kind === 'ethernet') return { title: rate ? `Ethernet ${rate}` : 'Ethernet', detail: '' };
  const bits = [];
  const q = signalQuality(link.rssi_dbm);
  if (q) {
    let s = `${q} signal ${Math.round(link.rssi_dbm)} dBm`;
    if (typeof link.noise_dbm === 'number') s += `, SNR ${Math.round(link.rssi_dbm - link.noise_dbm)} dB`;
    bits.push(s);
  }
  if (link.channel) bits.push(link.channel);
  if (link.phy) bits.push(link.phy);
  return { title: rate ? `Wi-Fi ${rate}` : 'Wi-Fi', detail: bits.join(', ') };
}

/** True when no sample has arrived for `staleMs`. A never-seen stream is stale too. */
export function isStale(lastReceivedAt, now, staleMs = STALE_MS) {
  return typeof lastReceivedAt !== 'number' || now - lastReceivedAt > staleMs;
}

/** Exponential smoothing for display only; null/NaN input leaves the previous value. */
export function smooth(prev, next, a = 0.35) {
  if (typeof next !== 'number' || !Number.isFinite(next)) return prev;
  if (typeof prev !== 'number' || !Number.isFinite(prev)) return next;
  return prev + (next - prev) * a;
}

/** A fixed-length history of numbers (nulls kept as 0 so the time axis stays honest). */
export function pushHistory(arr, v, max = HISTORY) {
  arr.push(typeof v === 'number' && Number.isFinite(v) ? v : 0);
  while (arr.length > max) arr.shift();
  return arr;
}

/** Round a maximum up to 1, 2 or 5 x 10^k, so the sparkline scale changes rarely and in clear steps. */
export function niceCeil(v, floor = 10000) {
  const x = Math.max(v, floor);
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (x <= m * p) return m * p;
  return 10 * p;
}

/** SVG polyline points for `values` in a w x h box, newest at the right; scale is `max` (use niceCeil). */
export function sparkPoints(values, w, h, max, length = HISTORY) {
  if (!values.length) return '';
  const step = w / Math.max(1, length - 1);
  const x0 = w - (values.length - 1) * step;
  return values
    .map((v, i) => `${(x0 + i * step).toFixed(1)},${(h - 1 - (Math.min(v, max) / max) * (h - 2)).toFixed(1)}`)
    .join(' ');
}

/** 0..1 level of a rate on a log scale from 1 kbps to 100 Mbps. */
export function rateLevel(bps) {
  if (typeof bps !== 'number' || !(bps > 0)) return 0;
  const l = (Math.log10(bps) - 3) / 5;
  return Math.max(0, Math.min(1, l));
}

/**
 * Is this device's pulse driven by a measurement? Only when capture reports
 * measured numbers for it. Everything else is the latency/recency estimate.
 */
export function pulseMode(dev) {
  return dev && dev.measured ? 'measured' : 'latency';
}

/**
 * What the map should animate along one device's root.
 * mode 'measured': streams follow the measured rates (toward the device = tx from
 * this Mac, back = rx); for this Mac's own root, host rx/tx. mode 'latency': the
 * existing latency/recency pulse, drawn dimmer and smaller. Offline devices: none.
 * `latency` is the {speed, glow} from graph-model's pulseParams.
 */
export function pulsePlan(d, traffic, latency) {
  if (d && d.online === false) return { mode: 'none', streams: [] };
  const dev = traffic && traffic.devices ? traffic.devices.get(d.id) : null;
  let rx = null;
  let tx = null;
  let measured = false;
  if (d && d.is_self && traffic && traffic.host && (traffic.host.rx_bps !== null || traffic.host.tx_bps !== null)) {
    rx = traffic.host.rx_bps;
    tx = traffic.host.tx_bps;
    measured = true; // interface counters are real measurements even without capture
  } else if (pulseMode(dev) === 'measured') {
    rx = dev.rx_bps;
    tx = dev.tx_bps;
    measured = true;
  }
  if (!measured) {
    if (!latency || !(latency.speed > 0)) return { mode: 'none', streams: [] };
    return { mode: 'latency', streams: [{ dir: 1, speed: latency.speed, glow: latency.glow, count: 1 }] };
  }
  const streams = [];
  for (const [dir, bps] of [[1, tx], [-1, rx]]) {
    const lv = rateLevel(bps);
    if (lv <= 0) continue;
    streams.push({ dir, speed: 0.15 + 0.5 * lv, glow: 0.45 + 0.55 * lv, count: 1 + Math.round(lv * 2) });
  }
  return { mode: 'measured', streams };
}

/** Sending devices of broadcast/multicast chatter: [{ id, proto, level }] with level 0..1. */
export function chatterEmitters(capture, knownIds) {
  const out = new Map();
  if (!capture || !capture.enabled || !capture.flows) return [];
  for (const f of capture.flows) {
    if (f.dst !== 'broadcast' && f.dst !== 'multicast') continue;
    if (!knownIds.has(f.src)) continue;
    const prev = out.get(f.src);
    const level = Math.max(0.25, rateLevel(f.bps));
    if (!prev || level > prev.level) out.set(f.src, { id: f.src, proto: f.proto, level });
  }
  return [...out.values()];
}

/** Capture status as display text and a state: 'on' | 'off' | 'unavailable' | 'unknown'. Text is the server's own wording where given. */
export function captureStatus(capture) {
  if (!capture) return { state: 'unknown', badge: 'unknown', text: 'The server did not report capture status.' };
  if (capture.enabled) return { state: 'on', badge: 'on', text: 'Capture is on. Flows are shown only for traffic that touches this Mac, plus broadcast and multicast chatter from every device.' };
  if (!capture.available) return { state: 'unavailable', badge: 'unavailable', text: capture.reason || 'Packet capture is unavailable on this machine.' };
  return { state: 'off', badge: 'off', text: capture.reason || 'Capture is off.' };
}

const FOOT = 'Traffic between other devices and the internet is not visible from this machine.';

/**
 * Traffic group for the details panel: [{ title, rows: [[label, value]], note }].
 * Latency, jitter and loss come from pings; rates are shown only when measured.
 */
export function trafficGroup(d, traffic, rttFallback) {
  const dev = traffic && traffic.devices ? traffic.devices.get(d.id) : null;
  const rows = [];
  const ms = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ms` : null);
  const rtt = ms(d.rtt_ms ?? rttFallback);
  if (rtt) rows.push(['Latency', rtt]);
  if (dev && dev.jitter_ms !== null) rows.push(['Jitter', ms(dev.jitter_ms)]);
  if (dev && dev.loss_pct !== null) rows.push(['Packet loss', `${Math.round(dev.loss_pct * 10) / 10}%`]);
  let note;
  if (d.is_self) {
    const h = traffic && traffic.host;
    if (h && (h.rx_bps !== null || h.tx_bps !== null)) {
      rows.push(['Down (this Mac)', formatRate(h.rx_bps)], ['Up (this Mac)', formatRate(h.tx_bps)]);
    }
    note = 'Measured from this interface’s own counters. ' + FOOT;
  } else if (dev && dev.measured) {
    rows.push(['To this Mac', formatRate(dev.tx_bps)], ['From this Mac', formatRate(dev.rx_bps)]);
    note = 'Rates are measured traffic between this Mac and the device. ' + FOOT;
  } else {
    note = 'Latency, jitter and loss come from pings. Rates are not available without packet capture, and this machine cannot see this device’s traffic to others or the internet.';
  }
  if (!rows.length) rows.push(['Measured', 'nothing yet']);
  return { title: 'Traffic', rows, note };
}

/** Deterministic synthetic samples for `?debug&faketraffic`; goes through the same code path as real ones. */
export function fakeSample(tSec, { ids = [], selfId = null, withCapture = true } = {}) {
  const wave = (p, a = 1) => Math.max(0, 0.5 + 0.5 * Math.sin(tSec / p)) * a;
  const devices = {};
  ids.forEach((id, i) => {
    const measured = withCapture && (id === selfId ? false : i % 2 === 0);
    devices[id] = {
      loss_pct: i % 5 === 0 ? 2 + wave(7) : 0,
      jitter_ms: 0.8 + wave(3 + i * 0.3, 6),
      rx_bps: measured ? Math.round(wave(5 + i, 800000)) : null,
      tx_bps: measured ? Math.round(wave(4 + i, 120000)) : null,
      measured,
    };
  });
  const flows = withCapture
    ? ids.filter((_, i) => i % 3 === 1).map((id) => ({ src: id, dst: 'multicast', proto: 'mdns', bps: 3000 + wave(2, 9000), pps: 5 }))
    : [];
  return {
    ts: Date.now(),
    host: {
      iface: 'en0',
      rx_bps: Math.round(wave(6, 6e6) + 2e5),
      tx_bps: Math.round(wave(9, 8e5) + 3e4),
      link: { kind: 'wifi', rate_mbps: 866, rssi_dbm: -52, noise_dbm: -90, channel: '44 (5 GHz, 80 MHz)', phy: '802.11ax' },
    },
    wan: { rx_bps: Math.round(wave(8, 2.4e7)), tx_bps: Math.round(wave(11, 2e6)), source: 'upnp-igd' },
    devices,
    capture: withCapture
      ? { enabled: true, available: true, reason: null, flows }
      : { enabled: false, available: false, reason: 'packet capture needs permission (synthetic sample)', flows: [] },
  };
}

const KEY = (k) => `rhizomon.hud.${k}`;

/** Remembered open/closed state of a HUD section. Storage may be missing or throw (private mode); then the fallback wins. */
export function rememberedOpen(storage, key, fallback) {
  try {
    const v = storage && storage.getItem(KEY(key));
    return v === '1' ? true : v === '0' ? false : fallback;
  } catch {
    return fallback;
  }
}

export function storeOpen(storage, key, open) {
  try {
    if (storage) storage.setItem(KEY(key), open ? '1' : '0');
  } catch {
    /* not persisted; the section still works */
  }
}
