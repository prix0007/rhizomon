// Pure helpers: no DOM, no network. Tested with `node --test ui/tests/`.

/**
 * Turn a device list into a star graph: the gateway is pinned at the origin
 * and every other device links to it. With no gateway there are no links.
 */
export function buildGraph(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const gw = list.find((d) => d.is_gateway);
  const nodes = list.map((d) => (d.is_gateway ? { ...d, fx: 0, fy: 0, fz: 0 } : { ...d }));
  const links = gw ? list.filter((d) => d !== gw).map((d) => ({ source: d.id, target: gw.id })) : [];
  return { nodes, links };
}

const COLOR = {
  gateway: '#ffc247',
  self: '#5ab0ff',
  fresh: '#ff7a3d',
  online: '#5fe08a',
  offline: 'rgba(150,150,150,0.35)',
};

export function nodeColor(d) {
  if (d.is_gateway) return COLOR.gateway;
  if (d.is_self) return COLOR.self;
  if (d.online === false) return COLOR.offline;
  if (d.is_new) return COLOR.fresh;
  return COLOR.online;
}

export function nodeSize(d) {
  if (d.is_gateway) return 8;
  if (d.is_self) return 5;
  return 3;
}

/** Legend category of a device, in the same precedence as `nodeColor`: gw, me, off, new, on. */
export function nodeCategory(d) {
  if (d.is_gateway) return 'gw';
  if (d.is_self) return 'me';
  if (d.online === false) return 'off';
  if (d.is_new) return 'new';
  return 'on';
}

/** Stable pseudo-random angle in [0, 2pi) from a string, so each link keeps its own curve direction. */
export function hashAngle(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h / 4294967296) * Math.PI * 2;
}

/** World-space radius of a node's body. Collision and rendering both use this. */
export function nodeRadius(d) {
  if (d.is_gateway) return 9;
  if (d.is_self) return 6;
  return 4.5;
}

/** Clearance kept around a body so the glow halo and a little air fit inside the collision sphere. */
export const COLLIDE_PADDING = 6;

export function collisionRadius(d) {
  // this Mac wears a ring drawn at 2.05x its body radius, so it needs the room for it
  return d.is_self ? nodeRadius(d) * 2.15 + 4 : nodeRadius(d) + COLLIDE_PADDING;
}

/**
 * Visual state of a node as plain data (hex colour, body opacity, halo
 * strength 0..1). The renderer eases towards it, so a status change fades.
 * Colours match `nodeColor` and the legend; offline is grey and glowless.
 */
export function nodeStyle(d) {
  if (d.is_gateway) return { color: COLOR.gateway, opacity: 1, glow: 1 };
  if (d.is_self) return { color: COLOR.self, opacity: 1, glow: 0.8 };
  if (d.online === false) return { color: '#8a919c', opacity: 0.4, glow: 0 };
  if (d.is_new) return { color: COLOR.fresh, opacity: 1, glow: 1 };
  return { color: COLOR.online, opacity: 0.95, glow: 0.55 };
}

/** Particles flow along every live link; a newly-seen device gets a denser, faster stream. */
export function linkParticles(d) {
  if (!d || d.online === false) return 0;
  return d.is_new ? 4 : 1;
}

// ---- labels ----

const LEGAL_SUFFIX = /[\s,]+(?:co\.?(?:\s*,?\s*ltd\.?)?|ltd\.?|inc\.?|llc|gmbh|corp(?:oration)?\.?|company|limited|technology|technologies|electronics|communications?|intl\.?|international)[.,]*\s*$/i;

/** Drop control characters and bidi overrides (device strings are untrusted) and collapse whitespace. */
function clean(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ellipsize(s, max) {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join('').trimEnd() + '\u2026';
}

function shortVendor(v) {
  let s = clean(v);
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\s*\([^)]*\)\s*$/, '').replace(LEGAL_SUFFIX, '').trim();
    if (next === s || next === '') break;
    s = next;
  }
  return s;
}

function shortHost(h) {
  let s = clean(h).replace(/\.(local|lan|home|localdomain)\.?$/i, '');
  const stripped = s.replace(/[-_ ]?[0-9a-f]{12,}$/i, '');
  return stripped || s;
}

function pick(d, keys, shorten) {
  for (const k of keys) {
    const v = shorten(d[k]);
    if (v) return v;
  }
  return '';
}

const NAME_KEYS = ['custom_name', 'friendly_name', 'hostname', 'dns_name', 'netbios_name'];
const MACHINE_KEYS = new Set(['hostname', 'dns_name', 'netbios_name']); // names a device or resolver made up itself

/**
 * True for names that are identifiers rather than names: a UUID (also a truncated one),
 * a long run of hex digits, or a MAC address. `custom_name` and `friendly_name`
 * are never judged this way: a person chose them.
 */
export function isOpaqueName(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/^uuid:/, '');
  if (!s) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return true;
  if (/^[0-9a-f]{8}(-[0-9a-f]{1,4}){1,4}$/.test(s)) return true; // truncated UUID
  if (/^[0-9a-f]{12,}$/.test(s)) return true;
  if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(s)) return true;
  return false;
}

function nameFrom(d, shorten) {
  for (const k of NAME_KEYS) {
    const v = shorten(d[k]);
    if (!v) continue;
    if (MACHINE_KEYS.has(k) && isOpaqueName(v)) continue;
    return v;
  }
  return '';
}

/** Full (untruncated) display name: custom_name, friendly_name, hostname, dns_name, netbios_name, vendor, IP. */
export function displayName(d) {
  return (
    nameFrom(d, (v) => clean(v)) ||
    shortVendor(d.vendor) ||
    clean(d.ip) ||
    clean(d.mac) ||
    '?'
  );
}

/**
 * What to print next to a device, by priority: custom_name, friendly_name,
 * hostname, dns_name, netbios_name, vendor, IP. `primary` is the name;
 * `secondary` is a short qualifier (the IP when the name is not the IP,
 * "private MAC" for an anonymous device) or null. When `dup` is true another
 * device shares this primary, so the last IP octet is appended to tell them
 * apart. Plain strings only; the UI sets them with textContent.
 */
export function labelParts(d, max = 24, dup = false) {
  const named = nameFrom(d, (v) => shortHost(v));
  const base = named || shortVendor(d.vendor);
  const ip = clean(d.ip);
  if (base) {
    const tag = dup && ip ? ' .' + ip.split('.').pop() : '';
    return { primary: ellipsize(base, max - [...tag].length) + tag, secondary: ip || null };
  }
  const name = ip || clean(d.mac) || '?';
  return { primary: ellipsize(name, max + 4), secondary: d.randomized_mac ? 'private MAC' : null };
}

/** Primary label texts that more than one device would show; those get a disambiguating tag. */
export function duplicatePrimaries(devices, max = 24) {
  const seen = new Set();
  const dup = new Set();
  for (const d of devices) {
    const p = labelParts(d, max).primary;
    if (seen.has(p)) dup.add(p);
    seen.add(p);
  }
  return dup;
}

export function labelText(d, max = 24, dup = false) {
  return labelParts(d, max, dup).primary;
}

/** Where a freshly seen node should start: on a random bearing around the gateway, not on top of it. */
export function seedPosition(gateway, rand, distance) {
  const gx = (gateway && gateway.x) || 0;
  const gy = (gateway && gateway.y) || 0;
  const gz = (gateway && gateway.z) || 0;
  const u = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return { x: gx + distance * s * Math.cos(a), y: gy + distance * u, z: gz + distance * s * Math.sin(a) };
}

// ---- collision ----

function isFixed(n) {
  return n.fx !== undefined && n.fx !== null;
}

/**
 * Push overlapping spheres apart, in place. Each pair closer than the sum of
 * its radii is separated along the line between centres; a pinned node never
 * moves, a heavier node (mass ~ r^3) moves less. `softness` is the share of
 * the overlap removed per iteration, so separation is eased over several ticks
 * instead of snapping. Coincident centres get a deterministic direction.
 */
const radiusCache = [];
function radiiFor(nodes, radiusOf) {
  radiusCache.length = nodes.length;
  for (let i = 0; i < nodes.length; i++) radiusCache[i] = radiusOf(nodes[i]);
  return radiusCache;
}

export function separate(nodes, radiusOf, { softness = 0.5, iterations = 2 } = {}) {
  const n = nodes.length;
  const r = radiiFor(nodes, radiusOf);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        const fa = isFixed(a);
        const fb = isFixed(b);
        if (fa && fb) continue;
        let dx = (b.x || 0) - (a.x || 0);
        let dy = (b.y || 0) - (a.y || 0);
        let dz = (b.z || 0) - (a.z || 0);
        let dist = Math.hypot(dx, dy, dz);
        const min = r[i] + r[j];
        if (dist >= min) continue;
        if (dist < 1e-6) {
          const ang = (i * 2.399963 + j) % (Math.PI * 2);
          dx = Math.cos(ang); dy = Math.sin(ang); dz = 0.3 * Math.cos(ang * 2);
          dist = Math.hypot(dx, dy, dz);
        }
        const push = ((min - dist) * softness) / dist;
        const ma = r[i] ** 3;
        const mb = r[j] ** 3;
        const shareA = fa ? 0 : fb ? 1 : mb / (ma + mb);
        const shareB = fb ? 0 : fa ? 1 : ma / (ma + mb);
        a.x = (a.x || 0) - dx * push * shareA; a.y = (a.y || 0) - dy * push * shareA; a.z = (a.z || 0) - dz * push * shareA;
        b.x = (b.x || 0) + dx * push * shareB; b.y = (b.y || 0) + dy * push * shareB; b.z = (b.z || 0) + dz * push * shareB;
      }
    }
  }
}

/**
 * A d3-force compatible force (d3-force-3d's forceCollide is not exposed by
 * the vendored bundle). Install with `graph.d3Force('collide', makeCollideForce(collisionRadius))`.
 */
export function makeCollideForce(radiusOf, opts) {
  let nodes = [];
  const force = () => separate(nodes, radiusOf, opts);
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

/** Escape text for use inside HTML (3d-force-graph renders `nodeLabel` as HTML). */
export function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tooltip HTML. Every device-supplied field is escaped. */
export function labelFor(d) {
  const title = displayName(d);
  const bits = [d.ip, d.mac, d.vendor, d.kind].filter(Boolean).map(escapeHtml);
  return `<div><b>${escapeHtml(title)}</b><br/>${bits.join(' &middot; ')}</div>`;
}

export function lastSeenText(ms, now) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 30) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function dateText(ms) {
  return ms ? new Date(ms).toLocaleString() : 'never';
}

function rttText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return ms < 10 ? `${Math.round(ms * 10) / 10} ms` : `${Math.round(ms)} ms`;
}

/**
 * Panel content as titled groups of [label, value] string pairs (identity,
 * hardware, network, history). Optional fields are omitted when absent. The
 * UI renders every value with textContent.
 */
export function detailGroups(d, now) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const group = (title, rows) => ({ title, rows: rows.filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [String(k), String(v)]) });
  const identity = [
    ['Name', str(d.custom_name)],
    ['Friendly name', str(d.friendly_name)],
    ['Hostname', str(d.hostname)],
    ['DNS name', str(d.dns_name)],
    ['NetBIOS name', str(d.netbios_name)],
    ['Kind', d.kind || 'unknown'],
    ['OS', str(d.os_hint)],
  ];
  const hardware = [
    ['Vendor', d.vendor || (d.randomized_mac ? '(private address)' : '(unknown)')],
    ['Manufacturer', str(d.manufacturer)],
    ['Model', str(d.model)],
    ['MAC', d.mac],
    ['Private MAC', d.randomized_mac ? 'yes (randomized / locally administered)' : ''],
  ];
  const network = [
    ['IP', d.ip],
    ['Status', d.online ? 'online' : 'offline'],
    ['Latency', rttText(d.rtt_ms)],
    ['Services', d.services && d.services.length ? d.services.join(', ') : ''],
    ['SSDP server', str(d.ssdp_server)],
    ['SSDP location', str(d.ssdp_location)],
  ];
  const history = [
    ['New', d.is_new ? 'seen for the first time recently' : ''],
    ['Last seen', d.online ? 'now' : lastSeenText(d.last_seen, now)],
    ['First seen', dateText(d.first_seen)],
  ];
  return [group('Identity', identity), group('Hardware', hardware), group('Network', network), group('History', history)].filter((g) => g.rows.length);
}

/** Flat [label, value] pairs (all groups concatenated). */
export function detailRows(d, now) {
  return detailGroups(d, now).flatMap((g) => g.rows);
}

export const NAME_MAX = 64;
export const NOTES_MAX = 500;

/**
 * Validate the rename form. Empty (after trimming) becomes null, which clears
 * the value on the server. Returns { body } or { error }.
 */
export function normalizeMeta(name, notes) {
  const n = String(name ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const t = String(notes ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if ([...n].length > NAME_MAX) return { error: `Name is limited to ${NAME_MAX} characters.` };
  if ([...t].length > NOTES_MAX) return { error: `Notes are limited to ${NOTES_MAX} characters.` };
  return { body: { custom_name: n === '' ? null : n, notes: t === '' ? null : t } };
}

/** The ids contain colons and may contain '@'; encode the whole segment. */
export function metaUrl(id) {
  return `/api/devices/${encodeURIComponent(id)}/meta`;
}

/** Link brightness 0..1 for a device: live links glow by status; offline links fade with time since last seen. */
export function linkStrength(d, now) {
  if (!d) return 0.1;
  if (d.online !== false) return d.is_new ? 0.5 : 0.36;
  const hours = d.last_seen ? Math.max(0, (now - d.last_seen) / 3600000) : 24;
  return 0.12 * Math.exp(-hours / 12) + 0.03;
}

// ---- reconciliation: keep node objects (and so their layout positions) stable ----

function applyPin(node, isGateway) {
  if (isGateway) {
    node.fx = 0; node.fy = 0; node.fz = 0;
  } else if ('fx' in node) {
    delete node.fx; delete node.fy; delete node.fz;
  }
}

function gatewayId(nodeMap) {
  for (const n of nodeMap.values()) if (n.is_gateway) return n.id;
  return null;
}

/** Insert or update one device in place. Returns true when a node was added. */
export function upsertDevice(nodeMap, device) {
  const existing = nodeMap.get(device.id);
  if (existing) {
    const roleChanged = !!existing.is_gateway !== !!device.is_gateway;
    Object.assign(existing, device);
    // Only touch the pin when the gateway role changes: re-pinning on every
    // update would snap a gateway the user is dragging or easing home.
    if (roleChanged) applyPin(existing, !!device.is_gateway);
    return false;
  }
  const node = { ...device };
  applyPin(node, !!device.is_gateway);
  nodeMap.set(device.id, node);
  return true;
}

/** Returns true when a node was removed. */
export function removeDevice(nodeMap, id) {
  return nodeMap.delete(id);
}

/**
 * Make `nodeMap` match `devices` (a full snapshot). `structureChanged` is true
 * when nodes were added/removed or the gateway changed, i.e. when the graph
 * must be re-fed to the layout engine.
 */
export function reconcile(nodeMap, devices) {
  const list = Array.isArray(devices) ? devices : [];
  const before = gatewayId(nodeMap);
  let structureChanged = false;
  const keep = new Set(list.map((d) => d.id));
  for (const id of [...nodeMap.keys()]) {
    if (!keep.has(id)) { nodeMap.delete(id); structureChanged = true; }
  }
  for (const d of list) if (upsertDevice(nodeMap, d)) structureChanged = true;
  if (gatewayId(nodeMap) !== before) structureChanged = true;
  return { structureChanged };
}

/** Graph data for the layout engine, reusing the node objects in `nodeMap`. */
export function toGraphData(nodeMap) {
  const nodes = [...nodeMap.values()];
  const gw = gatewayId(nodeMap);
  const links = gw === null ? [] : nodes.filter((n) => n.id !== gw).map((n) => ({ source: n.id, target: gw }));
  return { nodes, links };
}

// ---- round 3: colour mixing and pulse behaviour ----

/** Linear mix of two #rrggbb colours; t = 0 gives `a`, t = 1 gives `b`. */
export function mixHex(a, b, t) {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const k = Math.max(0, Math.min(1, t));
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[1].slice(i * 2, i * 2 + 2), 16);
    const y = parseInt(pb[1].slice(i * 2, i * 2 + 2), 16);
    out += Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * How the pulse on a device's root flows. `speed` is trips along the root per
 * second, `glow` is 0..1 brightness. With `rtt_ms` (from the backend) a nearer
 * device pulses faster and brighter; without it the pulse follows recency, so
 * a device seen just now flows briskly and a long-quiet one fades to a trickle.
 * Offline devices do not pulse.
 */
export function pulseParams(d, now) {
  if (!d || d.online === false) return { speed: 0, glow: 0 };
  if (typeof d.rtt_ms === 'number' && Number.isFinite(d.rtt_ms) && d.rtt_ms >= 0) {
    const q = 1 / (1 + d.rtt_ms / 30); // 1 at 0 ms, 0.5 at 30 ms, 0.1 at 270 ms
    return { speed: 0.12 + 0.4 * q, glow: 0.45 + 0.55 * q };
  }
  const ageSec = d.last_seen ? Math.max(0, (now - d.last_seen) / 1000) : 120;
  const q = 1 / (1 + ageSec / 60);
  return { speed: 0.12 + 0.2 * q, glow: 0.5 + 0.4 * q };
}

/**
 * A weak spring toward the horizontal plane (y = 0). Leaves around the gateway
 * then spread as a thick disc instead of a ball, so a camera looking down at a
 * pitch sees fewer of them stacked behind one another. Pinned nodes are left alone.
 */
export function makeFlattenForce(strength = 0.03) {
  let nodes = [];
  const force = () => {
    for (const n of nodes) {
      if (n.fy !== undefined && n.fy !== null) continue;
      n.vy = (n.vy || 0) - (n.y || 0) * strength;
    }
  };
  force.initialize = (ns) => { nodes = ns; };
  return force;
}
