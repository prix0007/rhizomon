// Always-on device labels as a DOM overlay positioned each frame.
// Text is only ever assigned with textContent: names and vendors come from untrusted LAN hosts.
//
// Labels are glued to their nodes: every frame the label is drawn at the live
// projected anchor plus an offset. Only the offset eases (when the placement
// picks a new slot), so camera motion never makes a label trail its node.
// Slot placement itself is throttled for big graphs and reuses its arrays.
import { labelParts, nodeRadius, nodeStyle } from './graph-model.js';
import { labelBudget, placeLabels } from './label-layout.js';

const ALIGN = ['center', 'center', 'left', 'right', 'center', 'center', 'left', 'right', 'left', 'right'];
const HALO_FACTOR = 2.0; // label obstacle radius = body radius * this (the outer glow shell reaches 2.05x)

export function createLabels(container, graph) {
  const items = new Map(); // id -> record
  let measureAll = true;
  let frameNo = 0;
  let size = { w: 0, h: 0 };
  const measureSize = () => {
    const r = container.getBoundingClientRect();
    size = { w: r.width, h: r.height };
  };
  measureSize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(measureSize).observe(container);
  else window.addEventListener('resize', measureSize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measureAll = true; });

  const frameItems = [];
  const budgetItems = [];
  let exclusions = [];
  const segments = [];
  const ROOT_TS = [0.25, 0.5, 0.75, 1];
  const worldPts = [];
  const scr = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  let V = null;
  let P = null;
  let sizeW = 0;
  let sizeH = 0;

  /** Project a world point to screen px into `out`; false when behind the camera. */
  function project(x, y, z, out) {
    const vx = V[0] * x + V[4] * y + V[8] * z + V[12];
    const vy = V[1] * x + V[5] * y + V[9] * z + V[13];
    const vz = V[2] * x + V[6] * y + V[10] * z + V[14];
    if (vz >= -1) return false;
    const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
    out.x = ((P[0] * vx + P[4] * vy + P[8] * vz + P[12]) / cw * 0.5 + 0.5) * sizeW;
    out.y = (0.5 - (P[1] * vx + P[5] * vy + P[9] * vz + P[13]) / cw * 0.5) * sizeH;
    return true;
  }

  const stats = { placeMs: 0, updateMs: 0, placements: 0 };

  function ensure(id) {
    let it = items.get(id);
    if (it) return it;
    const root = document.createElement('div');
    root.className = 'label';
    const name = document.createElement('span');
    name.className = 'label-name';
    const sub = document.createElement('span');
    sub.className = 'label-sub';
    root.append(name, sub);
    container.append(root);
    it = {
      id, root, name, sub, key: null, parts: null, shownPrimary: null, shownSecondary: null,
      w: 80, h: 30, sx: 0, sy: 0, zv: 0, r: 8, bodyPx: 4, fade: 0, wanted: true, slot: 0, ox: 0, oy: 0, tox: 0, toy: 0, placed: false, visible: false, align: -1, d: null,
    };
    items.set(id, it);
    return it;
  }

  function refreshText(it, d, dup) {
    const key = [d.custom_name, d.friendly_name, d.hostname, d.dns_name, d.netbios_name, d.vendor, d.ip, d.mac, d.randomized_mac].join('\u0001');
    let changed = false;
    if (key !== it.key) {
      it.key = key;
      it.parts = labelParts(d, 24);
      it.dupParts = null;
      changed = true;
    }
    let p = it.parts;
    if (dup.has(it.parts.primary)) {
      it.dupParts ||= labelParts(d, 24, true);
      p = it.dupParts;
    }
    if (p.primary !== it.shownPrimary) {
      it.name.textContent = p.primary;
      it.shownPrimary = p.primary;
      changed = true;
    }
    if (p.secondary !== it.shownSecondary) {
      it.sub.textContent = p.secondary || '';
      it.sub.hidden = !p.secondary;
      it.shownSecondary = p.secondary;
      changed = true;
    }
    return changed;
  }

  /** Add the real (curved) root of a device as a short polyline; falls back to a straight line. */
  function pushRoot(it, gw, roots) {
    let px = gw.sx, py = gw.sy;
    if (roots && roots.points(it.id, ROOT_TS, worldPts)) {
      for (let i = 0; i < ROOT_TS.length; i++) {
        const w = worldPts[i];
        if (!project(w.x, w.y, w.z, scr[i])) break;
        segments.push({ id: it.id, x1: px, y1: py, x2: scr[i].x, y2: scr[i].y });
        px = scr[i].x; py = scr[i].y;
      }
    } else {
      segments.push({ id: it.id, x1: it.sx, y1: it.sy, x2: gw.sx, y2: gw.sy });
    }
  }

  /** Project, place and draw. Call once per frame, after the graph has rendered. */
  function update(nodes, { selectedId = null, hoveredId = null, calm = false, dt = 1 / 60, gateway = null, roots = null } = {}) {
    const t0 = performance.now();
    frameNo++;
    for (const [id, it] of items) {
      if (!nodes.has(id)) {
        it.root.remove();
        items.delete(id);
      }
    }
    const { w: W, h: H } = size;
    if (!W || !H) return;

    // Which primaries are shared? (strings only; cheap)
    const counts = new Map();
    for (const it of items.values()) if (it.parts) counts.set(it.parts.primary, (counts.get(it.parts.primary) || 0) + 1);
    const dup = new Set();
    for (const [k, n] of counts) if (n > 1) dup.add(k);

    const dense = items.size > 60; // crowded: drop the second line so labels take half the room
    if (dense !== container.classList.contains('dense')) {
      container.classList.toggle('dense', dense);
      measureAll = true;
    }
    const camera = graph.camera();
    camera.updateMatrixWorld();
    V = camera.matrixWorldInverse.elements;
    P = camera.projectionMatrix.elements;
    sizeW = W;
    sizeH = H;
    const focal = H / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const cp = camera.position;
    const refDist = Math.hypot(cp.x, cp.y, cp.z) || 1;

    let gw = null;
    const gwId = gateway ? gateway.id : null;
    for (const [id, d] of nodes) {
      const it = ensure(id);
      it.d = d;
      if (refreshText(it, d, dup) || measureAll) {
        it.w = it.root.offsetWidth || it.w;
        it.h = it.root.offsetHeight || it.h;
      }
      const x = d.x || 0, y = d.y || 0, z = d.z || 0;
      const vx = V[0] * x + V[4] * y + V[8] * z + V[12];
      const vy = V[1] * x + V[5] * y + V[9] * z + V[13];
      const vz = V[2] * x + V[6] * y + V[10] * z + V[14];
      it.zv = vz;
      it.visible = vz < -1;
      if (!it.visible) continue;
      const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
      it.sx = ((P[0] * vx + P[4] * vy + P[8] * vz + P[12]) / cw * 0.5 + 0.5) * W;
      it.sy = (0.5 - (P[1] * vx + P[5] * vy + P[9] * vz + P[13]) / cw * 0.5) * H;
      it.bodyPx = (nodeRadius(d) * focal) / -vz;
      it.r = Math.max(6, it.bodyPx * HALO_FACTOR);
      if (id === gwId) gw = it;
    }
    measureAll = false;

    // Too many labels cannot all be legible: past 60 devices keep the gateway, this Mac,
    // hovered/selected, the nearest to the camera, and any node drawn large; the rest fade out.
    budgetItems.length = 0;
    for (const it of items.values()) {
      if (!it.visible) continue;
      budgetItems.push({ id: it.id, depth: -it.zv, bodyPx: it.bodyPx, always: it.d.is_gateway || it.d.is_self || it.id === selectedId || it.id === hoveredId });
    }
    const shown = labelBudget(budgetItems);
    for (const it of items.values()) it.wanted = it.visible && shown.has(it.id);

    // Re-place slots: every frame for small graphs, every third for large ones.
    const interval = items.size > 40 ? 3 : 1;
    let needFirst = false;
    for (const it of items.values()) if (it.wanted && !it.placed) { needFirst = true; break; }
    if (needFirst || frameNo % interval === 0) {
      const p0 = performance.now();
      frameItems.length = 0;
      segments.length = 0;
      for (const it of items.values()) {
        if (!it.wanted) continue;
        frameItems.push({
          id: it.id, x: it.sx, y: it.sy, r: it.r, w: it.w, h: it.h,
          priority: (it.d.is_gateway ? 3 : it.d.is_self ? 2 : 1) + (it.id === selectedId ? 4 : 0) + (it.id === hoveredId ? 4 : 0),
          prev: it.placed ? it.slot : undefined,
          avoidAllLinks: it === gw,
        });
        if (gw && it !== gw) pushRoot(it, gw, roots);
      }
      const placed = placeLabels(frameItems, { gap: 6, pad: 3, bounds: { x: 6, y: 6, w: W - 12, h: H - 40 }, segments, exclusions });
      for (const [id, pl] of placed) {
        const it = items.get(id);
        it.slot = pl.slot;
        it.tox = pl.rect.x - it.sx;
        it.toy = pl.rect.y - it.sy;
        if (!it.placed) {
          it.ox = it.tox;
          it.oy = it.toy;
          it.placed = true;
        }
      }
      stats.placeMs += performance.now() - p0;
      stats.placements++;
    }
    const k = calm ? 1 : 1 - Math.exp(-dt * 14);
    for (const it of items.values()) {
      const kf = calm ? 1 : 1 - Math.exp(-dt * 7);
      it.fade += ((it.wanted ? 1 : 0) - it.fade) * kf;
      if (!it.visible || !it.placed || it.fade < 0.03) {
        if (it.shownOpacity !== '0') it.root.style.opacity = it.shownOpacity = '0';
        continue;
      }
      it.ox += (it.tox - it.ox) * k;
      it.oy += (it.toy - it.oy) * k;
      const d = it.d;
      const active = it.id === selectedId || it.id === hoveredId;
      const depth = Math.max(0.35, Math.min(1, Math.pow(refDist / -it.zv, 1.4)));
      const off = d.online === false;
      const op = ((off ? 0.7 : 0.45 + 0.55 * depth) * it.fade).toFixed(2);
      it.root.style.transform = `translate3d(${(it.sx + it.ox).toFixed(1)}px, ${(it.sy + it.oy).toFixed(1)}px, 0)${active ? ' scale(1.1)' : ''}`;
      if (it.align !== ALIGN[it.slot]) {
        it.root.style.textAlign = ALIGN[it.slot];
        it.align = ALIGN[it.slot];
      }
      if (op !== it.shownOpacity) it.root.style.opacity = it.shownOpacity = op;
      const color = nodeStyle(d).color;
      if (color !== it.shownColor) {
        it.root.style.setProperty('--c', color);
        it.shownColor = color;
      }
      it.root.classList.toggle('off', off);
      it.root.classList.toggle('gw', !!d.is_gateway);
      it.root.classList.toggle('active', active);
    }
    stats.updateMs += performance.now() - t0;
  }

  return {
    update,
    count: () => items.size,
    stats,
    /** Rectangles (screen px) that labels must stay out of: the HUD and the open panel. */
    setExclusions: (rects) => { exclusions = rects; },
  };
}
