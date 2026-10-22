import {
  collisionRadius,
  detailGroups,
  displayName,
  hashAngle,
  labelFor,
  linkParticles,
  linkStrength,
  makeCollideForce,
  makeFlattenForce,
  metaUrl,
  nodeCategory,
  nodeColor,
  nodeSize,
  nodeStyle,
  normalizeMeta,
  reconcile,
  removeDevice,
  seedPosition,
  toGraphData,
  upsertDevice,
} from './graph-model.js';
import { shouldUseDemo } from './mode.js';
import { createLabels } from './labels.js';
import { chatterEmitters, fakeSample, trafficGroup } from './traffic.js';
import { createTrafficUI, initCollapsibles } from './traffic-ui.js';
import { createLinkMaterials, createNodes, createRings, createRoots, createSpores, probeKit, setupRenderer } from './scene.js';

const statusbar = document.getElementById('statusbar');
const statusText = document.getElementById('status-text');
const banners = document.getElementById('banners');
const panel = document.getElementById('panel');
const panelTitle = document.getElementById('panel-title');
const panelRows = document.getElementById('panel-rows');
const panelTraffic = document.getElementById('panel-traffic');
const stage = document.getElementById('graph');
const deviceList = document.getElementById('device-list');
const editForm = document.getElementById('edit');
const editName = document.getElementById('edit-name');
const editNotes = document.getElementById('edit-notes');
const editSave = document.getElementById('edit-save');
const editReset = document.getElementById('edit-reset');
const editMsg = document.getElementById('edit-msg');
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
// Demo mode: served by something other than the local agent (e.g. GitHub Pages), or ?demo. Nothing then calls /api/.
const demoMode = shouldUseDemo(location.origin, location.search);
if (demoMode) {
  document.body.classList.add('demo');
  document.getElementById('demo-banner').hidden = false;
}
const demo = demoMode ? (await import('./demo.js')).createDemo() : null;
const apiFetch = demo ? demo.fetch : (...args) => fetch(...args);
const nodeMap = new Map();
const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let selectedId = null;
let hoveredId = null;
let ready = false; // the 3D kit has been probed and node objects are available
let settled = false; // the first layout has cooled; later reheats are gentle
let userMoved = false; // the user has taken the camera: stop auto-framing
let linkUnit = 74; // current link distance, also the radius of the first range ring
let lastInteract = performance.now();
const fitTimers = new Map();
let gatewayReturn = null; // gateway released after a drag: eases back to the origin

// ---- simulation tuning ----
// Lower alpha decay = a longer, softer cool-down; lower velocity decay = less
// friction, so nodes glide instead of stopping dead. Link and charge forces
// are capped after the first layout (see damped) so an SSE update nudges the
// graph instead of re-exploding it.
const SIM = {
  alphaDecay: 0.014,
  alphaMin: 0.002,
  velocityDecay: 0.26,
  linkDistance: 74,
  linkStrength: 0.45,
  charge: -75,
  chargeMax: 340,
  // Past ~10 leaves the shell must grow: distance and charge scale with cbrt(n / 10).
  reheatCap: 0.28,
  seedDistance: 66,
  flatten: 0.03, // weak pull to the horizontal plane: less line-of-sight stacking at a pitched camera
};

function endpointNode(end) {
  return typeof end === 'object' && end !== null ? end : nodeMap.get(end);
}

/** Wrap a d3 force so that its alpha never exceeds `cap()`; every other method passes through. */
function damped(force, cap) {
  const f = (alpha) => force(Math.min(alpha, cap()));
  const proxy = new Proxy(f, {
    get(target, key) {
      if (key in target) return target[key];
      const v = force[key];
      if (typeof v !== 'function') return v;
      return (...args) => {
        const r = v.apply(force, args);
        return r === force ? proxy : r;
      };
    },
  });
  return proxy;
}

/** Brief shells from devices sending broadcast/multicast chatter (capture on only). */
function emitChatter(sample) {
  if (!nodes3d) return;
  const now = performance.now();
  for (const e of chatterEmitters(sample.capture, new Set(nodeMap.keys()))) nodes3d.emit(e.id, e.level, now);
}

const trafficUI = createTrafficUI({ onSample: emitChatter, onRender: () => renderPanelTraffic() });
initCollapsibles(document.getElementById('hud'));

let graph = null;
let nodes3d = null;
let spores = null;
let labels = null;
let linkMats = null;
let rings = null;
let roots = null;
let gatewayNode = null; // cached; cleared whenever the data changes
let quality = '';
let linkForce = null;
let chargeForce = null;

function unit01(id) {
  return hashAngle(String(id)) / (Math.PI * 2);
}

/** Scale the layout with the device count and give each link its own length so leaves do not share one shell. */
function tuneForces() {
  if (!linkForce) return;
  const scale = Math.max(1, Math.cbrt(Math.max(0, nodeMap.size - 1) / 10));
  linkUnit = SIM.linkDistance * scale;
  linkForce
    .distance((l) => linkUnit * (0.8 + 0.4 * unit01(endpointNode(l.source)?.id ?? '')))
    .strength(SIM.linkStrength / Math.sqrt(scale));
  chargeForce.strength(SIM.charge * scale).distanceMax(SIM.chargeMax * scale);
}

try {
  graph = ForceGraph3D({ rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' } })(stage)
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .d3AlphaDecay(SIM.alphaDecay)
    .d3AlphaMin(SIM.alphaMin)
    .d3VelocityDecay(SIM.velocityDecay)
    .cooldownTicks(Infinity)
    .cooldownTime(Infinity)
    .nodeLabel(labelFor) // HTML, but labelFor escapes every field
    .nodeResolution(24)
    .onNodeClick(selectNode)
    .onNodeHover((n) => {
      hoveredId = n ? n.id : null;
      stage.style.cursor = n ? 'pointer' : '';
    })
    .onNodeDragEnd((n) => {
      if (n.is_gateway) {
        gatewayReturn = n; // the engine left it pinned where it was dropped
        graph.d3ReheatSimulation();
      }
    })
    .onEngineStop(() => {
      if (!ready || nodeMap.size === 0) return; // the probe-only graph cooling is not a real layout
      settled = true;
      scheduleFit(0, 'settle');
    });

  graph.camera().position.set(0, 175, 270); // close to the final framing; refined once the layout settles
  const cap = () => (settled ? SIM.reheatCap : 1);
  linkForce = graph.d3Force('link');
  chargeForce = graph.d3Force('charge');
  tuneForces();
  graph.d3Force('link', damped(linkForce, cap));
  graph.d3Force('charge', damped(chargeForce, cap));
  graph.d3Force('collide', makeCollideForce(collisionRadius));
  if (!(debug && params.has('noflat'))) graph.d3Force('flatten', makeFlattenForce(SIM.flatten));

  labels = createLabels(document.getElementById('labels'), graph);
  setupRenderer(graph);
  (debug && params.has('nokit') ? Promise.reject(new Error('3D kit disabled by ?nokit')) : probeKit(graph))
    .then((kit) => {
      nodes3d = createNodes(kit);
      rings = createRings(kit, graph.scene());
      linkMats = createLinkMaterials(kit);
      spores = createSpores(kit, graph.scene());
      roots = createRoots(kit, graph.scene(), linkMats);
      applyQuality();
      graph.nodeThreeObject((d) => nodes3d.build(d)).nodeThreeObjectExtend(false).linkVisibility(false); // roots replace the library's links
      ready = true;
      scheduleRender(true);
      scheduleFit(2500, 'early');
      scheduleFit(6000, 'late');
      scheduleFit(11000, 'later');
    })
    .catch((e) => {
      // Degrade to the library's own spheres; labels and the panel still work.
      graph.nodeColor(nodeColor).nodeVal(nodeSize).nodeOpacity(0.95).linkColor(() => 'rgba(120,190,170,0.45)').linkWidth(0.7).linkDirectionalParticles((l) => linkParticles(endpointNode(l.source))).linkDirectionalParticleWidth(1.5);
      ready = true;
      showNotice('Basic 3D mode: ' + e.message);
      scheduleRender(true);
      scheduleFit(2500, 'early');
    });
} catch (e) {
  statusText.textContent = 'WebGL is unavailable in this browser: ' + e.message;
}

/**
 * Frame the whole graph (eased) unless the user has taken the camera. Timers are
 * keyed, so the early and late fits both run, while repeated requests with the
 * same key (a burst of updates) collapse into one.
 */
function scheduleFit(delay, key = 'update') {
  clearTimeout(fitTimers.get(key));
  fitTimers.set(
    key,
    setTimeout(() => {
      if (userMoved || !graph || nodeMap.size === 0) return;
      fitSphere();
    }, delay),
  );
}

/**
 * Frame the graph by its bounding sphere around the gateway instead of the
 * library's box, which fit loosely (the graph spanned ~30% of the viewport).
 * Distance is chosen so the sphere fits the narrower of the two view angles.
 */
function fitSphere() {
  const gw = gateway();
  const cam = graph.camera();
  const ctl = graph.controls();
  if (!gw) return;
  let R = 0;
  for (const n of nodeMap.values()) R = Math.max(R, Math.hypot((n.x || 0) - gw.x, (n.y || 0) - gw.y, (n.z || 0) - gw.z) + 14);
  const W = stage.clientWidth || 1, H = stage.clientHeight || 1;
  const half = Math.min((cam.fov * Math.PI) / 360, Math.atan(Math.tan((cam.fov * Math.PI) / 360) * (W / H)));
  const dist = (R / Math.sin(half)) * 1.1;
  const t = (ctl && ctl.target) || { x: 0, y: 0, z: 0 };
  let dx = cam.position.x - t.x, dy = cam.position.y - t.y, dz = cam.position.z - t.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  graph.cameraPosition({ x: gw.x + dx * dist, y: gw.y + dy * dist, z: gw.z + dz * dist }, gw, 1200);
}

/** The user asked for the map back: re-frame it and resume auto-framing for new devices. */
function recenter() {
  userMoved = false;
  lastInteract = performance.now();
  scheduleFit(0, 'recenter');
}

/** Detail of the 3D bodies by device count; applied when nodes are (re)built. */
function applyQuality() {
  const n = nodeMap.size;
  const q = n > 60 ? 'lo' : n > 30 ? 'mid' : 'hi';
  if (q === quality || !nodes3d) return false;
  quality = q;
  nodes3d.shells = q === 'hi' ? 10 : q === 'mid' ? 6 : 2;
  nodes3d.detail = q === 'lo' ? 'lo' : 'hi';
  return true;
}

let notice = null;
function showNotice(text) {
  notice = text;
  renderBanners([]);
}

// ---- details panel ----

let formId = null; // device the edit form is currently showing
let dirty = false; // the user has typed since the form was filled
let saving = false;

function setMsg(text, kind) {
  editMsg.textContent = text;
  editMsg.className = kind || '';
}

function fillForm(d) {
  editName.value = d.custom_name || '';
  editNotes.value = d.notes || '';
  editName.placeholder = displayName({ ...d, custom_name: null });
  formId = d.id;
  dirty = false;
  setMsg('', '');
}

function renderPanel() {
  const d = selectedId && nodeMap.get(selectedId);
  if (!d) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    formId = null;
    return;
  }
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  panel.style.setProperty('--accent', nodeStyle(d).color);
  panelTitle.textContent = displayName(d); // textContent only, never innerHTML
  const out = [];
  for (const g of detailGroups(d, Date.now())) {
    const h = document.createElement('dt');
    h.className = 'group';
    h.textContent = g.title;
    out.push(h);
    for (const [k, v] of g.rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      out.push(dt, dd);
    }
  }
  panelRows.replaceChildren(...out);
  renderPanelTraffic(true);
  // Never overwrite what the user is typing; refresh the form only when it is clean.
  if (formId !== d.id || (!dirty && !saving)) {
    const keepMsg = formId === d.id ? editMsg.textContent : '';
    const kind = editMsg.className;
    fillForm(d);
    if (keepMsg) setMsg(keepMsg, kind);
  }
}

let trafficKey = '';
/** The Traffic group of the details panel. Rewritten only when its content changed. */
function renderPanelTraffic(force = false) {
  const d = selectedId && nodeMap.get(selectedId);
  if (!d) return;
  const g = trafficGroup(d, trafficUI.current());
  const key = JSON.stringify([d.id, g]);
  if (!force && key === trafficKey) return;
  trafficKey = key;
  const out = [];
  const h = document.createElement('dt');
  h.className = 'group';
  h.textContent = g.title;
  out.push(h);
  for (const [k, v] of g.rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    out.push(dt, dd);
  }
  const note = document.createElement('dd');
  note.className = 'note';
  note.textContent = g.note;
  out.push(note);
  panelTraffic.replaceChildren(...out);
}

function markDirty() {
  dirty = true;
  setMsg('', '');
}
editName.addEventListener('input', markDirty);
editNotes.addEventListener('input', markDirty);
editReset.addEventListener('click', () => {
  const d = nodeMap.get(selectedId);
  if (d) fillForm(d);
});

editForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const d = nodeMap.get(selectedId);
  if (!d || saving) return;
  const m = normalizeMeta(editName.value, editNotes.value);
  if (m.error) return setMsg(m.error, 'error');
  saving = true;
  editSave.disabled = true;
  setMsg('Saving...', '');
  try {
    const res = await apiFetch(metaUrl(d.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Rhizomon': '1' },
      body: JSON.stringify(m.body),
    });
    if (!res.ok) {
      const why = res.status === 404 ? 'the server cannot store names, or this device no longer exists' : `server said ${res.status}`;
      setMsg(`Not saved: ${why}. Your edits are kept here.`, 'error');
      return;
    }
    let updated = null;
    try {
      updated = await res.json();
    } catch {
      updated = null;
    }
    if (updated && typeof updated === 'object' && updated.id === d.id) {
      if (upsertDevice(nodeMap, updated)) scheduleRender(true);
    } else {
      d.custom_name = m.body.custom_name;
      d.notes = m.body.notes;
    }
    dirty = false;
    scheduleRender(false);
    setMsg('Saved.', 'ok');
  } catch {
    setMsg('Not saved: could not reach the server. Your edits are kept here.', 'error');
  } finally {
    saving = false;
    editSave.disabled = false;
  }
});

function selectNode(n) {
  selectedId = n.id;
  userMoved = true;
  lastInteract = performance.now();
  renderPanel();
  const dist = 130;
  const len = Math.hypot(n.x || 0, n.y || 0, n.z || 0);
  const pos = len < 1 ? { x: 0, y: 0, z: dist } : { x: n.x * (1 + dist / len), y: n.y * (1 + dist / len), z: n.z * (1 + dist / len) };
  graph.cameraPosition(pos, n, 1100);
}

document.getElementById('panel-close').addEventListener('click', () => {
  selectedId = null;
  renderPanel();
});

// ---- legend counts ----

const legendCounts = {};
for (const el of document.querySelectorAll('[data-count]')) legendCounts[el.dataset.count] = el;

function renderLegend() {
  const counts = { gw: 0, me: 0, on: 0, new: 0, off: 0 };
  for (const d of nodeMap.values()) counts[nodeCategory(d)]++;
  for (const [k, el] of Object.entries(legendCounts)) el.textContent = String(counts[k] ?? 0);
  renderDeviceList();
}

// A visually hidden list of buttons: the canvas itself is not reachable by keyboard or screen reader.
let listKey = '';
function renderDeviceList() {
  const devs = [...nodeMap.values()].sort((a, b) => String(a.ip).localeCompare(String(b.ip), undefined, { numeric: true }));
  const key = devs.map((d) => [d.id, displayName(d), d.ip, d.online].join('|')).join('\n');
  if (key === listKey) return;
  listKey = key;
  deviceList.replaceChildren(
    ...devs.map((d) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${displayName(d)}, ${d.ip}${d.online === false ? ', offline' : ''}`;
      b.addEventListener('click', () => selectNode(d));
      li.append(b);
      return li;
    }),
  );
}

// ---- data flow ----

const pending = { structure: false, scheduled: false };
function scheduleRender(structureChanged) {
  pending.structure ||= structureChanged;
  if (pending.scheduled || !graph || !ready) return;
  pending.scheduled = true;
  requestAnimationFrame(() => {
    pending.scheduled = false;
    if (pending.structure) {
      seedNewcomers();
      tuneForces();
      if (applyQuality()) graph.nodeThreeObject((d) => nodes3d.build(d)); // a new accessor makes the library rebuild every node
      graph.graphData(toGraphData(nodeMap));
      if (settled) scheduleFit(1500);
    } else if (!roots) {
      graph.nodeColor(graph.nodeColor()); // fallback mode: re-evaluate colours
    }
    // With the 3D kit, node colour/size and the roots are eased every frame, so nothing to re-evaluate here.
    gatewayNode = null;
    pending.structure = false;
    if (selectedId && !nodeMap.has(selectedId)) selectedId = null;
    renderPanel();
    renderLegend();
  });
}

function gateway() {
  if (!gatewayNode || !nodeMap.has(gatewayNode.id)) gatewayNode = [...nodeMap.values()].find((n) => n.is_gateway) || null;
  return gatewayNode;
}

/** Start new nodes on a random bearing around the gateway instead of on top of it. */
function seedNewcomers() {
  const gw = gateway();
  for (const n of nodeMap.values()) {
    if (n.is_gateway || typeof n.x === 'number') continue;
    Object.assign(n, seedPosition(gw, Math.random, SIM.seedDistance));
  }
}

let warnings = [];
function renderBanners(list) {
  warnings = list;
  const notes = [...warnings, ...(notice ? [notice] : [])];
  banners.replaceChildren(
    ...notes.map((w) => {
      const el = document.createElement('div');
      el.className = 'banner';
      el.textContent = w; // never innerHTML
      return el;
    }),
  );
}

function showStatus(s) {
  if (!s) return;
  const parts = [`${s.online}/${s.devices} online`, s.iface, s.net];
  if (s.gateway) parts.push('gw ' + s.gateway);
  statusText.textContent = parts.filter(Boolean).join(' | ');
  renderBanners([...(s.warnings || [])]);
}

const es = demo ? demo.source : new EventSource('/api/events');
es.addEventListener('snapshot', (e) => {
  const snap = JSON.parse(e.data);
  const r = reconcile(nodeMap, snap.devices);
  showStatus(snap.status);
  scheduleRender(r.structureChanged);
});
es.addEventListener('device', (e) => scheduleRender(upsertDevice(nodeMap, JSON.parse(e.data))));
es.addEventListener('removed', (e) => scheduleRender(removeDevice(nodeMap, JSON.parse(e.data))));
es.addEventListener('scan', (e) => showStatus(JSON.parse(e.data)));
es.addEventListener('traffic', (e) => {
  try {
    trafficUI.push(JSON.parse(e.data));
  } catch {
    /* a malformed event is ignored; the stale timer covers a stream that stops */
  }
});
es.onopen = () => statusbar.classList.add('live');
es.onerror = () => {
  statusbar.classList.remove('live');
  statusText.textContent = 'disconnected, retrying...';
};

// ---- recenter, keyboard, label exclusion zones ----

document.getElementById('recenter').addEventListener('click', recenter);
// The camera controls listen on window; keep typing in the form away from them.
editForm.addEventListener('keydown', (e) => e.stopPropagation());
window.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) recenter();
});

/** Rectangles labels must stay out of: the HUD (brand, legend, recenter) and the open panel. */
function updateExclusions() {
  if (!labels) return;
  const rects = [];
  const hud = document.getElementById('hud').getBoundingClientRect();
  rects.push({ x: hud.left - 6, y: hud.top - 6, w: hud.width + 12, h: hud.height + 12 });
  if (demoMode) {
    const b = document.getElementById('demo-banner').getBoundingClientRect();
    rects.push({ x: 0, y: 0, w: window.innerWidth, h: b.bottom + 6 });
  }
  if (panel.classList.contains('open')) rects.push({ x: window.innerWidth - 14 - 320 - 6, y: 8, w: 332, h: panel.offsetHeight + 12 });
  labels.setExclusions(rects);
}
window.addEventListener('resize', updateExclusions);
new MutationObserver(updateExclusions).observe(panel, { attributes: true, attributeFilter: ['class'] });
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(updateExclusions).observe(panel);
  new ResizeObserver(updateExclusions).observe(document.getElementById('hud')); // sections open and close
}
setTimeout(updateExclusions, 0);

// ---- per-frame: node animation, camera drift, labels ----

for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => { lastInteract = performance.now(); }, { passive: true });
}
stage.addEventListener('pointerdown', () => { userMoved = true; });
stage.addEventListener('wheel', () => { userMoved = true; }, { passive: true });
let pointerDown = false;
window.addEventListener('pointerdown', () => { pointerDown = true; });
window.addEventListener('pointerup', () => { pointerDown = false; lastInteract = performance.now(); });

/** Rotate the camera slowly about its up axis through the controls' target. */
function drift(dt) {
  const cam = graph.camera();
  const ctl = graph.controls();
  const t = (ctl && ctl.target) || { x: 0, y: 0, z: 0 };
  const a = 0.032 * dt;
  const c = Math.cos(a), s = Math.sin(a);
  const u = cam.up;
  const ul = Math.hypot(u.x, u.y, u.z) || 1;
  const ax = u.x / ul, ay = u.y / ul, az = u.z / ul;
  const vx = cam.position.x - t.x, vy = cam.position.y - t.y, vz = cam.position.z - t.z;
  const dot = ax * vx + ay * vy + az * vz;
  const cx = ay * vz - az * vy, cy = az * vx - ax * vz, cz = ax * vy - ay * vx;
  cam.position.x = t.x + vx * c + cx * s + ax * dot * (1 - c);
  cam.position.y = t.y + vy * c + cy * s + ay * dot * (1 - c);
  cam.position.z = t.z + vz * c + cz * s + az * dot * (1 - c);
}

function easeGatewayHome(dt) {
  const g = gatewayReturn;
  if (!g) return;
  const k = 1 - Math.exp(-dt * 6);
  for (const f of ['fx', 'fy', 'fz']) g[f] += (0 - g[f]) * k;
  if (Math.hypot(g.fx, g.fy, g.fz) < 0.05) {
    g.fx = 0; g.fy = 0; g.fz = 0;
    gatewayReturn = null;
  }
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!graph || !ready) return;
  const gw = gateway();
  if (nodes3d) nodes3d.animate(now, dt, nodeMap, { selectedId, hoveredId, calm, camera: graph.camera() });
  if (rings) rings.place(gw, linkUnit);
  if (roots) roots.update(now, dt, nodeMap, gw, { calm, traffic: trafficUI.current() });
  if (spores) spores.animate(now, calm);
  easeGatewayHome(dt);
  if (!calm && !pointerDown && !selectedId && now - lastInteract > 5000 && gatewayReturn === null) drift(dt);
  labels.update(nodeMap, { selectedId, hoveredId, calm, dt, gateway: gw, roots });
}
requestAnimationFrame(frame);

// Test and debugging hook, present only with ?debug in the URL.
if (debug) {
  window.__rhizomon = {
    nodeMap,
    reheat: () => graph.d3ReheatSimulation(),
    screenOf: (id) => { const n = nodeMap.get(id); return graph.graph2ScreenCoords(n.x, n.y, n.z); },
    inject: (devices) => scheduleRender(reconcile(nodeMap, devices).structureChanged),
    labelStats: () => ({ ...labels.stats, labels: labels.count() }),
    settled: () => settled,
    linkUnit: () => linkUnit,
    camera: () => graph.camera().position.toArray(),
    traffic: () => trafficUI.current(),
    demoMode,
  };
}

// ---- traffic feed: one fetch for the latest sample, then SSE events; a missing endpoint is a normal state ----

trafficUI.start();
if (debug && params.has('faketraffic')) {
  // Synthetic samples through the same code path as real ones (?debug&faketraffic, or &faketraffic=nocap for "capture unavailable").
  const feed = () => {
    const ids = [...nodeMap.keys()];
    const self = [...nodeMap.values()].find((n) => n.is_self);
    trafficUI.push(fakeSample(Date.now() / 1000, { ids, selfId: self ? self.id : null, withCapture: params.get('faketraffic') !== 'nocap' }));
  };
  const feedTimer = setInterval(feed, 1000);
  setTimeout(feed, 600);
  if (window.__rhizomon) window.__rhizomon.pauseFake = () => clearInterval(feedTimer); // lets a test see the stale state
} else if (!demoMode) {
  fetch('/api/traffic', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json().then((j) => trafficUI.push(j)) : trafficUI.markMissing()))
    .catch(() => trafficUI.markMissing());
}
