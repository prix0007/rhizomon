// Screen-space label placement. Pure: no DOM, no three.js. Tested with `node --test ui/tests/`.

/**
 * Candidate anchors around a node, in the order they are tried. Each gives the
 * top-left corner of a w x h label box for a node of screen radius r at (x, y).
 */
export const SLOTS = [
  (x, y, r, w, h, g) => ({ x: x - w / 2, y: y + r + g }), // 0 below
  (x, y, r, w, h, g) => ({ x: x - w / 2, y: y - r - g - h }), // 1 above
  (x, y, r, w, h, g) => ({ x: x + r + g + 2, y: y - h / 2 }), // 2 right
  (x, y, r, w, h, g) => ({ x: x - r - g - 2 - w, y: y - h / 2 }), // 3 left
  (x, y, r, w, h, g) => ({ x: x - w / 2, y: y + r + g + h + 4 }), // 4 further below
  (x, y, r, w, h, g) => ({ x: x - w / 2, y: y - r - g - h * 2 - 4 }), // 5 further above
  (x, y, r, w, h, g) => ({ x: x + r * 0.7 + g, y: y + r * 0.7 + g }), // 6 below right
  (x, y, r, w, h, g) => ({ x: x - r * 0.7 - g - w, y: y + r * 0.7 + g }), // 7 below left
  (x, y, r, w, h, g) => ({ x: x + r * 0.7 + g, y: y - r * 0.7 - g - h }), // 8 above right
  (x, y, r, w, h, g) => ({ x: x - r * 0.7 - g - w, y: y - r * 0.7 - g - h }), // 9 above left
];

export function rectOverlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** True when the disc (cx, cy, r) intersects the rectangle. */
export function circleHitsRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return Math.hypot(cx - nx, cy - ny) < r;
}

/** Does the segment (x1,y1)-(x2,y2) pass through the rectangle? (Liang-Barsky clip.) */
export function segmentHitsRect(x1, y1, x2, y2, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - rect.x, rect.x + rect.w - x1, y1 - rect.y, rect.y + rect.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

const OWN_LINK_COST = 350;
const OTHER_LINK_COST = 120;
const OTHER_LINKS_MAX_ITEMS = 40;
const EXCLUDED_COST = 900;
const CELL = 100;

/** A coarse spatial hash of rectangles/discs so a candidate is only tested against its neighbours. */
function makeGrid() {
  const cells = new Map();
  const key = (cx, cy) => cx * 100003 + cy;
  return {
    add(rect, obj) {
      for (let cx = Math.floor(rect.x / CELL); cx <= Math.floor((rect.x + rect.w) / CELL); cx++) {
        for (let cy = Math.floor(rect.y / CELL); cy <= Math.floor((rect.y + rect.h) / CELL); cy++) {
          const k = key(cx, cy);
          const list = cells.get(k);
          if (list) list.push(obj);
          else cells.set(k, [obj]);
        }
      }
    },
    /** Visit each distinct object whose cells touch `rect`. */
    query(rect, fn) {
      const seen = new Set();
      for (let cx = Math.floor(rect.x / CELL); cx <= Math.floor((rect.x + rect.w) / CELL); cx++) {
        for (let cy = Math.floor(rect.y / CELL); cy <= Math.floor((rect.y + rect.h) / CELL); cy++) {
          const list = cells.get(key(cx, cy));
          if (!list) continue;
          for (const o of list) {
            if (seen.has(o)) continue;
            seen.add(o);
            fn(o);
          }
        }
      }
    },
  };
}

function cost(rect, item, ctx) {
  const { pad, bounds, segments, segsById, exclusions, checkOthers, placedGrid, discGrid } = ctx;
  const padded = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
  let c = 0;
  placedGrid.query(padded, (p) => { c += rectOverlapArea(padded, p.rect); });
  discGrid.query(padded, (d) => {
    if (d.id !== item.id && circleHitsRect(d.x, d.y, d.r + pad, rect)) c += 400;
  });
  const all = item.avoidAllLinks || checkOthers; // the gateway label avoids every root, like a label avoids its own
  const mine = segsById.get(item.id);
  if (mine) for (let i = 0; i < mine.length; i++) if (segmentHitsRect(mine[i].x1, mine[i].y1, mine[i].x2, mine[i].y2, rect)) c += OWN_LINK_COST;
  if (all) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.id === item.id) continue;
      if (segmentHitsRect(s.x1, s.y1, s.x2, s.y2, rect)) c += item.avoidAllLinks ? OWN_LINK_COST : OTHER_LINK_COST;
    }
  }
  for (let i = 0; i < exclusions.length; i++) if (rectOverlapArea(rect, exclusions[i]) > 0) c += EXCLUDED_COST;
  if (bounds) {
    if (rect.x < bounds.x) c += (bounds.x - rect.x) * rect.h + 50;
    if (rect.y < bounds.y) c += (bounds.y - rect.y) * rect.w + 50;
    if (rect.x + rect.w > bounds.x + bounds.w) c += (rect.x + rect.w - bounds.x - bounds.w) * rect.h + 50;
    if (rect.y + rect.h > bounds.y + bounds.h) c += (rect.y + rect.h - bounds.y - bounds.h) * rect.w + 50;
  }
  return c;
}

/**
 * Choose a slot for every label so that no label covers another label, a node
 * (including its glow, since `r` is the obstacle radius), a link, or an
 * excluded rectangle (HUD, open panel), where the geometry allows it.
 *
 * items:    [{ id, x, y, r, w, h, priority?, prev? }]  (screen px; prev is last frame's slot)
 * segments: [{ id, x1, y1, x2, y2 }]  the polyline of each root (several segments share an id); a label
 *           avoids its own root strongly and, for small graphs, the others too; an item flagged
 *           `avoidAllLinks` (the gateway) avoids every root
 * exclusions: [{ x, y, w, h }] rectangles no label may sit on
 * returns Map id -> { slot, rect: {x,y,w,h}, cost }   (cost 0 means conflict-free)
 *
 * Higher priority is placed first. The previous slot is tried first and kept
 * at once when conflict-free; otherwise all slots are scored and the previous
 * one is kept only if no other is better by more than 20% (no flip-flopping).
 */
export function placeLabels(items, { gap = 5, pad = 2, bounds = null, segments = [], exclusions = [] } = {}) {
  const discGrid = makeGrid();
  for (const it of items) discGrid.add({ x: it.x - it.r - pad, y: it.y - it.r - pad, w: (it.r + pad) * 2, h: (it.r + pad) * 2 }, it);
  const placedGrid = makeGrid();
  const segsById = new Map();
  for (const s of segments) {
    const list = segsById.get(s.id);
    if (list) list.push(s);
    else segsById.set(s.id, [s]);
  }
  const ctx = { pad, bounds, segments, segsById, exclusions, checkOthers: items.length <= OTHER_LINKS_MAX_ITEMS, placedGrid, discGrid };
  const order = [...items].sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.y - b.y || (a.id < b.id ? -1 : 1));
  const out = new Map();
  for (const item of order) {
    const rectAt = (k) => ({ ...SLOTS[k](item.x, item.y, item.r, item.w, item.h, gap), w: item.w, h: item.h });
    const hasPrev = Number.isInteger(item.prev) && SLOTS[item.prev];
    let chosen = null;
    let prev = null;
    if (hasPrev) {
      const rect = rectAt(item.prev);
      prev = { slot: item.prev, rect, cost: cost(rect, item, ctx) };
      if (prev.cost === 0) chosen = prev;
    }
    if (!chosen) {
      let best = null;
      for (let k = 0; k < SLOTS.length; k++) {
        if (hasPrev && k === item.prev) continue;
        const rect = rectAt(k);
        const c = cost(rect, item, ctx);
        if (best === null || c < best.cost) best = { slot: k, rect, cost: c };
        if (c === 0) break;
      }
      if (prev && prev.cost < best.cost) best = prev;
      chosen = prev && prev.cost <= best.cost * 1.2 ? prev : best;
    }
    placedGrid.add(chosen.rect, chosen);
    out.set(item.id, chosen);
  }
  return out;
}

/**
 * Which labels to show when there are too many for all to be legible. At or
 * below `limit` items everything shows. Above it: items flagged `always`
 * (gateway, this Mac, hovered, selected), the `nearest` items by camera
 * distance (smallest `depth`), and any item whose node body is drawn at least
 * `bigPx` pixels in radius (`bodyPx`). Returns a Set of ids.
 */
export function labelBudget(items, { limit = 60, nearest = 36, bigPx = 9 } = {}) {
  if (items.length <= limit) return new Set(items.map((i) => i.id));
  const show = new Set();
  for (const i of items) if (i.always || i.bodyPx >= bigPx) show.add(i.id);
  const byDepth = [...items].sort((a, b) => a.depth - b.depth);
  for (let k = 0; k < Math.min(nearest, byDepth.length); k++) show.add(byDepth[k].id);
  return show;
}
