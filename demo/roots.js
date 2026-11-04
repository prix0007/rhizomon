// Root geometry maths for the links. Pure: no DOM, no three.js. Tested with `node --test ui/tests/`.
//
// A root is drawn in a unit frame: it starts at the gateway (0,0,0), runs along
// +x to the device at (1,0,0), bows sideways by a small amount, and tapers.
// Two side filaments leave it and end in a spore. The frame is placed in the
// world by a basis built from the gateway and the device (see rootMatrix), and
// rolled about the root's own axis so the bow can point away from other nodes.

/** Three shapes so the roots do not look stamped. `A` bow, `B` second harmonic, branches: t along root, len, angle around the axis. */
export const SHAPES = [
  { A: 0.1, B: 0.035, branches: [{ t: 0.3, len: 0.17, ang: 0.9 }, { t: 0.62, len: 0.11, ang: -2.2 }] },
  { A: 0.13, B: -0.03, branches: [{ t: 0.22, len: 0.12, ang: -1.1 }, { t: 0.5, len: 0.19, ang: 2.0 }] },
  { A: 0.08, B: 0.05, branches: [{ t: 0.4, len: 0.2, ang: 0.2 }, { t: 0.72, len: 0.1, ang: 2.7 }] },
];

/** Point on the main root at t in [0,1], unit frame. */
export function rootCurve(t, shape, out = [0, 0, 0]) {
  out[0] = t;
  out[1] = shape.A * Math.sin(Math.PI * t) + shape.B * Math.sin(2 * Math.PI * t);
  out[2] = 0;
  return out;
}

/** Radius of the main root at t, in unit-frame length units (thick at the gateway, thin at the leaf). */
export function rootRadius(t) {
  return 0.0035 + (0.0125 - 0.0035) * Math.pow(1 - t, 1.5);
}

/** Point on a side filament at u in [0,1]. */
export function branchPoint(shape, i, u) {
  const b = shape.branches[i];
  const [sx, sy] = rootCurve(b.t, shape);
  const dy = Math.cos(b.ang) * 0.85;
  const dz = Math.sin(b.ang) * 0.85;
  const curl = 0.3 * u * (1 - u);
  return [sx + 0.55 * b.len * u + curl * b.len * 0.5, sy + (dy * u + -Math.sin(b.ang) * curl) * b.len, (dz * u + Math.cos(b.ang) * curl) * b.len];
}

function tube(points, radii, radial, positions, index) {
  const base = positions.length / 3;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[Math.min(n - 1, i + 1)];
    const o = points[Math.max(0, i - 1)];
    let tx = q[0] - o[0], ty = q[1] - o[1], tz = q[2] - o[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // a reference axis not parallel to the tangent
    const rx = Math.abs(tx) < 0.9 ? 1 : 0, ry = rx ? 0 : 1;
    let ux = ty * 0 - tz * ry, uy = tz * rx - tx * 0, uz = tx * ry - ty * rx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a) * radii[i], s = Math.sin(a) * radii[i];
      positions.push(p[0] + ux * c + vx * s, p[1] + uy * c + vy * s, p[2] + uz * c + vz * s);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = base + i * radial + k;
      const b = base + i * radial + ((k + 1) % radial);
      const c = a + radial;
      const d = b + radial;
      index.push(a, c, b, b, c, d);
    }
  }
}

const SPORE_FACES = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];

function spore(center, r, positions, index) {
  const base = positions.length / 3;
  const [x, y, z] = center;
  positions.push(x + r, y, z, x - r, y, z, x, y + r, z, x, y - r, z, x, y, z + r, x, y, z - r);
  for (const f of SPORE_FACES) index.push(base + f);
}

/** Merged tube geometry for one root shape: main root plus two side filaments and spores. Returns plain arrays. */
export function buildRootGeometry(shape, { segments = 14, radial = 5 } = {}) {
  const positions = [];
  const index = [];
  const main = [];
  const radii = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    main.push(rootCurve(t, shape));
    radii.push(rootRadius(t));
  }
  tube(main, radii, radial, positions, index);
  shape.branches.forEach((b, bi) => {
    const pts = [];
    const rs = [];
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      pts.push(branchPoint(shape, bi, u));
      rs.push(0.0055 * (1 - u * 0.75));
    }
    tube(pts, rs, 4, positions, index);
    spore(pts[steps], 0.011, positions, index);
  });
  return { positions, index };
}

// Scratch storage: these run for every root every frame, so they allocate nothing.
const B = { len: 0, d: [0, 0, 0], u: [0, 0, 0], v: [0, 0, 0] };
const M = new Array(16).fill(0);

function basis(gw, leaf) {
  const dx = leaf.x - gw.x, dy = leaf.y - gw.y, dz = leaf.z - gw.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
  const d = B.d, u = B.u, v = B.v;
  d[0] = dx / len; d[1] = dy / len; d[2] = dz / len;
  const flat = Math.abs(d[1]) >= 0.9; // reference axis: y normally, x when nearly vertical
  const r0 = flat ? 1 : 0, r1 = flat ? 0 : 1;
  u[0] = r1 * d[2]; u[1] = -r0 * d[2]; u[2] = r0 * d[1] - r1 * d[0];
  const ul = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]) || 1;
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  v[0] = d[1] * u[2] - d[2] * u[1]; v[1] = d[2] * u[0] - d[0] * u[2]; v[2] = d[0] * u[1] - d[1] * u[0];
  B.len = len;
  return B;
}

/** Fill `out` (16 numbers, column-major) with the matrix placing the unit-frame root between gw and leaf, rolled by `roll`. Returns the length. */
export function rootMatrix(out, gw, leaf, roll) {
  const { len, d, u, v } = basis(gw, leaf);
  const c = Math.cos(roll), s = Math.sin(roll);
  for (let i = 0; i < 3; i++) {
    out[i] = d[i] * len;
    out[4 + i] = (u[i] * c + v[i] * s) * len;
    out[8 + i] = (-u[i] * s + v[i] * c) * len;
  }
  out[12] = gw.x; out[13] = gw.y; out[14] = gw.z;
  out[3] = out[7] = out[11] = 0;
  out[15] = 1;
  return len;
}

/** World position of the unit-frame point p under rootMatrix. Writes into `out` when given. */
export function toWorld(gw, leaf, roll, p, out = { x: 0, y: 0, z: 0 }) {
  rootMatrix(M, gw, leaf, roll);
  out.x = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12];
  out.y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13];
  out.z = M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14];
  return out;
}

const P = [0, 0, 0];
const SAMPLES = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];

/** Smallest distance from the root's curve to the surface of any obstacle ({x,y,z,r}); negative when it passes through one. */
export function clearance(gw, leaf, roll, shape, obstacles, skip = null) {
  const m = M;
  rootMatrix(m, gw, leaf, roll);
  let best = Infinity;
  const test = (p) => {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    for (let k = 0; k < obstacles.length; k++) {
      const o = obstacles[k];
      if (o === skip) continue;
      const dx = x - o.x, dy = y - o.y, dz = z - o.z;
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz) - o.r);
    }
  };
  for (const t of SAMPLES) test(rootCurve(t, shape, P));
  // the spore at the end of each side filament must not land inside another node's glow either
  for (let bi = 0; bi < shape.branches.length; bi++) test(branchPoint(shape, bi, 1));
  return best;
}

/**
 * Pick the roll that keeps the root's bow clear of other nodes. The current roll
 * is kept while it is clear (so roots do not wander); otherwise the clearest of
 * `candidates` evenly spaced rolls wins, ties going to the one nearest the current.
 */
export function chooseRoll(gw, leaf, shape, obstacles, current, candidates = 12, skip = null) {
  if (clearance(gw, leaf, current, shape, obstacles, skip) >= 0) return current;
  let best = current;
  let bestC = -Infinity;
  let bestDist = Infinity;
  for (let i = 0; i < candidates; i++) {
    const r = (i / candidates) * Math.PI * 2;
    const c = clearance(gw, leaf, r, shape, obstacles, skip);
    const diff = Math.abs(((r - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (c > bestC + 1e-9 || (Math.abs(c - bestC) <= 1e-9 && diff < bestDist)) {
      best = r;
      bestC = c;
      bestDist = diff;
    }
  }
  return best;
}
