// The 3D look: bioluminescent cells on soil-dark space, joined by glowing filaments.
//
// three.js is not a global here (the vendored 3d-force-graph bundle keeps it
// private), and vendoring a second copy would load two instances of three.
// Instead the few constructors needed are recovered from objects the bundle
// builds itself (see probeKit). Nothing in this file touches the DOM.
import { linkParticles, linkStrength, mixHex, nodeRadius, nodeStyle, pulseParams, hashAngle } from './graph-model.js';
import { pulsePlan, rateLevel } from './traffic.js';
import { SHAPES, buildRootGeometry, chooseRoll, rootCurve, rootMatrix, toWorld } from './roots.js';

// Hard-coded three.js enum values (stable for years; re-check when 3d-force-graph is upgraded, see vendor/VERSIONS).
const ADDITIVE = 2; // THREE.AdditiveBlending
const DOUBLE_SIDE = 2; // THREE.DoubleSide
const BACK_SIDE = 1; // THREE.BackSide
const ACES_FILMIC = 4; // THREE.ACESFilmicToneMapping

/**
 * Feed the graph one throwaway node, wait for the bundle to build its default
 * mesh, and read the constructors off it. Resolves with the kit, or rejects
 * if the bundle never built one.
 */
export function probeKit(graph) {
  graph.graphData({ nodes: [{ id: '__probe' }], links: [] });
  return new Promise((resolve, reject) => {
    let frames = 0;
    const look = () => {
      let found = null;
      graph.scene().traverse((o) => {
        if (!found && o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry' && o.material && o.material.emissive) found = o;
      });
      if (found) {
        const Mesh = found.constructor;
        resolve({
          Mesh,
          Object3D: Object.getPrototypeOf(Mesh),
          Sphere: found.geometry.constructor,
          Lambert: found.material.constructor,
          Color: found.material.color.constructor,
          BufferGeometry: Object.getPrototypeOf(found.geometry.constructor),
          Attr: found.geometry.attributes.position.constructor,
        });
      } else if (++frames > 180) {
        reject(new Error('could not obtain three.js constructors from the bundle'));
      } else {
        requestAnimationFrame(look);
      }
    };
    requestAnimationFrame(look);
  });
}

/** Tone mapping and lighting: a cool fill, a warm key from the camera side, a teal rim from behind. */
export function setupRenderer(graph) {
  const renderer = graph.renderer();
  renderer.toneMapping = ACES_FILMIC;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const cam = graph.camera();
  cam.fov = 50; // a narrower field of view keeps halos round at the screen edge
  cam.updateProjectionMatrix();
  graph.scene().traverse((o) => {
    if (o.isAmbientLight) {
      o.color.set('#7fa6b8');
      o.intensity = 0.22;
    } else if (o.isDirectionalLight && !o.userData.rhizomonRim) {
      o.color.set('#fff0d8');
      o.intensity = 1.7;
      const rim = o.clone();
      rim.userData.rhizomonRim = true;
      rim.color.set('#35e0c0');
      rim.intensity = 1.5;
      rim.position.set(-o.position.x - 60, -o.position.y - 40, -o.position.z - 120);
      (o.parent || graph.scene()).add(rim);
    }
  });
}

function mat(kit, color, opts) {
  return new kit.Lambert({ color, transparent: true, ...opts });
}

/** A flat annulus in the XY plane with outer radius 1, as a three.js geometry built from the recovered constructors. */
export function ringGeometry(kit, inner, segments = 64) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pos.push(Math.cos(a) * inner, Math.sin(a) * inner, 0, Math.cos(a), Math.sin(a), 0);
    const o = i * 2;
    const n = ((i + 1) % segments) * 2;
    idx.push(o, o + 1, n, n, o + 1, n + 1);
  }
  const g = new kit.BufferGeometry();
  g.setAttribute('position', new kit.Attr(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

/** Builds node objects and animates them from node data every frame. */
export function createNodes(kit) {
  const unitHi = new kit.Sphere(1, 36, 24);
  const unitLo = new kit.Sphere(1, 20, 14);
  const shellGeo = new kit.Sphere(1, 16, 12); // shared, low-poly: the shells are soft glow, not surfaces
  const ringGeo = ringGeometry(kit, 0.9);
  const records = new Map();
  const tmp = new kit.Color();
  // `shells` and `detail` are read when a node is built, so changing them takes effect on rebuild.
  const api = { build: null, animate: null, records, shells: 8, detail: 'hi' };

  function dispose(rec) {
    for (const m of rec.materials) m.dispose();
  }

  /** `nodeThreeObject` accessor. The returned group is what the engine positions and drags. */
  function build(d) {
    const old = records.get(d.id);
    if (old) dispose(old);
    const style = nodeStyle(d);
    const g = new kit.Object3D();
    const body = new kit.Object3D();
    g.add(body);

    // A lit sphere: opaque so it writes depth and shows a real terminator.
    const core = new kit.Mesh(api.detail === 'lo' ? unitLo : unitHi, new kit.Lambert({ color: style.color, emissive: style.color }));
    // The glow is a stack of faint additive shells: the steps add up to a soft falloff instead of one flat disc.
    const halos = [];
    for (let i = 0; i < api.shells; i++) {
      const h = new kit.Mesh(shellGeo, mat(kit, '#000000', { emissive: style.color, opacity: 0.03, depthWrite: false, blending: ADDITIVE, side: BACK_SIDE })); // back faces only: the glow sits behind the body, never over it
      h.raycast = () => {}; // glow is not a click or drag target
      halos.push(h);
    }
    const pulse = new kit.Mesh(shellGeo, mat(kit, '#000000', { emissive: style.color, opacity: 0, depthWrite: false, blending: ADDITIVE }));
    pulse.raycast = () => {};
    // A brief expanding shell when this device sends broadcast/multicast chatter (capture only).
    const chatter = new kit.Mesh(shellGeo, mat(kit, '#000000', { emissive: '#d9ecff', opacity: 0, depthWrite: false, blending: ADDITIVE, side: BACK_SIDE }));
    chatter.raycast = () => {};
    chatter.visible = false;
    // This Mac wears a ring that always faces the camera: a shape cue, not only a hue.
    let ring = null;
    if (d.is_self) {
      ring = new kit.Mesh(ringGeo, mat(kit, '#000000', { emissive: style.color, opacity: 0.9, depthWrite: false, blending: ADDITIVE, side: DOUBLE_SIDE }));
      ring.raycast = () => {};
    }
    body.add(pulse, chatter, ...halos, core);
    if (ring) body.add(ring);

    const rec = {
      g, body, core, halos, pulse, ring, chatter, emitAt: -1e9, emitLevel: 0,
      materials: [core.material, pulse.material, chatter.material, ...halos.map((h) => h.material), ...(ring ? [ring.material] : [])],
      cur: new kit.Color(style.color),
      op: style.opacity,
      glow: style.glow,
      boost: 0,
      translucent: false,
      born: performance.now(),
      phase: Math.random() * Math.PI * 2,
    };
    records.set(d.id, rec);
    g.__rhizomonId = d.id;
    return g;
  }

  /**
   * Ease every node toward its current style and breathe. `nodes` is the id ->
   * device map; a status change therefore fades instead of snapping.
   */
  function animate(now, dt, nodes, { selectedId = null, hoveredId = null, calm = false, camera = null } = {}) {
    const k = 1 - Math.exp(-dt * 5);
    for (const [id, rec] of records) {
      const d = nodes.get(id);
      if (!d) {
        dispose(rec);
        records.delete(id);
        continue;
      }
      const style = nodeStyle(d);
      const R = nodeRadius(d);
      tmp.set(style.color);
      rec.cur.lerp(tmp, k);
      rec.op += (style.opacity - rec.op) * k;
      rec.glow += (style.glow - rec.glow) * k;
      const wantBoost = (id === selectedId ? 1 : 0) + (id === hoveredId ? 0.6 : 0);
      rec.boost += (wantBoost - rec.boost) * k;

      const t = (now - rec.born) / 1000;
      const age = Math.min(1, (now - rec.born) / 900);
      const grow = age >= 1 ? 1 : 1 - Math.pow(1 - age, 3) * Math.cos(age * 7); // eased, slight overshoot
      const breathe = calm ? 0 : Math.sin(now / 1000 * 1.3 + rec.phase);
      rec.body.position.y = calm ? 0 : Math.sin(now / 1000 * 0.7 + rec.phase * 1.7) * 0.9;

      const s = R * grow * (1 + 0.02 * breathe);
      const cm = rec.core.material;
      const translucent = rec.op < 0.97;
      if (translucent !== rec.translucent) {
        rec.translucent = translucent;
        cm.transparent = translucent;
        cm.needsUpdate = true;
      }
      cm.color.copy(rec.cur);
      cm.emissive.copy(rec.cur).multiplyScalar(0.07 + 0.1 * rec.boost);
      cm.opacity = rec.op;
      rec.core.scale.setScalar(s);

      const n = rec.halos.length;
      const gl = rec.glow * (1 + rec.boost * 0.9) * (1 + 0.15 * breathe);
      for (let i = 0; i < n; i++) {
        const h = rec.halos[i];
        h.scale.setScalar(s * (1.1 + (0.95 * (i + 1)) / n)); // 1.1 .. 2.05 x body
        h.material.emissive.copy(rec.cur);
        h.material.opacity = (0.42 / n) * gl * (1.25 - 0.5 * (i / n)); // denser near the body: a smooth falloff
        h.visible = gl > 0.01;
      }

      if (rec.ring) {
        rec.ring.scale.setScalar(s * 2.05);
        rec.ring.material.emissive.copy(rec.cur);
        rec.ring.material.opacity = 0.75 * rec.op * (1 + 0.2 * rec.boost);
        if (camera) rec.ring.quaternion.copy(camera.quaternion);
      }

      // Broadcast/multicast chatter: one soft shell, 0.9 s, brighter for busier senders.
      const ep = (now - rec.emitAt) / 900;
      if (ep >= 0 && ep < 1 && !calm) {
        rec.chatter.scale.setScalar(s * (1.3 + ep * 2.6));
        rec.chatter.material.opacity = Math.pow(1 - ep, 1.6) * (0.18 + 0.3 * rec.emitLevel);
        rec.chatter.visible = true;
      } else if (rec.chatter.visible) {
        rec.chatter.visible = false;
      }

      // A slow ripple leaves the gateway; a new device pings faster.
      const period = d.is_gateway ? 3.6 : d.is_new && d.online !== false ? 1.9 : 0;
      if (period && !calm) {
        const p = ((t + rec.phase) % period) / period;
        rec.pulse.scale.setScalar(s * (1.3 + p * (d.is_gateway ? 4.2 : 3.4)));
        rec.pulse.material.emissive.copy(rec.cur);
        rec.pulse.material.opacity = Math.pow(1 - p, 2.2) * 0.14;
        rec.pulse.visible = true;
      } else {
        rec.pulse.visible = false;
      }
    }
  }

  /** Start a chatter emission on a device's node. */
  api.emit = (id, level, now) => {
    const rec = records.get(id);
    if (!rec) return;
    rec.emitAt = now;
    rec.emitLevel = level;
  };
  api.build = build;
  api.animate = animate;
  return api;
}

/**
 * One ring in the horizontal plane around the gateway, drawn in 3D so it
 * foreshortens and stays centred on the gateway however the camera moves. Its
 * radius is the nominal link length: the "one hop" boundary where devices sit.
 */
export function createRings(kit, scene) {
  const geo = ringGeometry(kit, 0.99, 96);
  const ring = new kit.Mesh(geo, mat(kit, '#000000', { emissive: '#9fe8d0', opacity: 0.2, depthWrite: false, blending: ADDITIVE, side: DOUBLE_SIDE }));
  ring.rotation.x = -Math.PI / 2;
  ring.raycast = () => {};
  const group = new kit.Object3D();
  group.add(ring);
  scene.add(group);
  return {
    place(gateway, unit) {
      group.position.set((gateway && gateway.x) || 0, (gateway && gateway.y) || 0, (gateway && gateway.z) || 0);
      ring.scale.setScalar(unit);
    },
  };
}

/** Link materials, cached by colour/opacity so thousands of frames allocate nothing. */
export function createLinkMaterials(kit) {
  const cache = new Map();
  return (color, strength) => {
    const key = color + '|' + strength.toFixed(2);
    let m = cache.get(key);
    if (!m) {
      m = mat(kit, '#000000', { emissive: color, opacity: strength, depthWrite: false, blending: ADDITIVE });
      cache.set(key, m);
    }
    return m;
  };
}

/** Faint motes drifting through the volume: parallax and depth when the camera moves. */
export function createSpores(kit, scene, count = 240) {
  const geo = new kit.Sphere(1, 6, 4);
  const mats = [0, 1, 2].map((i) => mat(kit, '#000000', { emissive: ['#9fe8d0', '#b9d9ff', '#e8f6c8'][i], opacity: 0.4, depthWrite: false, blending: ADDITIVE }));
  const group = new kit.Object3D();
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const motes = [];
  for (let i = 0; i < count; i++) {
    const m = new kit.Mesh(geo, mats[i % 3]);
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const rr = 140 + Math.pow(rand(), 0.7) * 520;
    const s = Math.sqrt(1 - u * u);
    m.position.set(rr * s * Math.cos(a), rr * u, rr * s * Math.sin(a));
    m.scale.setScalar(0.35 + rand() * 0.6);
    m.raycast = () => {};
    group.add(m);
    motes.push({ m, ox: m.position.x, oy: m.position.y, oz: m.position.z, p: rand() * 6.28, sp: 0.1 + rand() * 0.25 });
  }
  scene.add(group);
  return {
    animate(now, calm) {
      mats.forEach((m, i) => { m.opacity = calm ? 0.4 : 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(now / 1000 * (0.4 + i * 0.23) + i * 2)); });
      if (calm) return;
      const t = now / 1000;
      for (const o of motes) {
        o.m.position.x = o.ox + Math.sin(t * o.sp + o.p) * 9;
        o.m.position.y = o.oy + Math.cos(t * o.sp * 0.8 + o.p) * 9;
        o.m.position.z = o.oz + Math.sin(t * o.sp * 0.6 + o.p * 2) * 9;
      }
    },
  };
}

/**
 * The links, drawn as roots: a thick-to-thin tapered tube from the gateway to
 * each device, with two side filaments ending in spores, a bow that is steered
 * away from other nodes, and small pulses flowing outward. One shared geometry
 * per shape (3 in all), one mesh per device, a handful of tiny pulse meshes.
 * The library's own link objects are hidden and still drive the layout.
 */
export function createRoots(kit, scene, linkMats) {
  const geos = SHAPES.map((s) => {
    const { positions, index } = buildRootGeometry(s);
    const g = new kit.BufferGeometry();
    g.setAttribute('position', new kit.Attr(new Float32Array(positions), 3));
    g.setIndex(index);
    return g;
  });
  const pulseGeo = new kit.Sphere(1, 8, 6);
  const group = new kit.Object3D();
  scene.add(group);
  const recs = new Map();
  const obstacles = [];
  const leaves = [];
  const gwPos = { x: 0, y: 0, z: 0 };
  const pt = [0, 0, 0];
  const world = { x: 0, y: 0, z: 0 };
  let cursor = 0;

  function make(id) {
    const shape = Math.floor((hashAngle('s' + id) / (Math.PI * 2)) * SHAPES.length) % SHAPES.length;
    const mesh = new kit.Mesh(geos[shape], linkMats('#9fe8d0', 0.3));
    mesh.matrixAutoUpdate = false;
    mesh.raycast = () => {};
    mesh.frustumCulled = false; // the matrix is set by hand, so bounds are not trustworthy
    group.add(mesh);
    const roll = hashAngle('r' + id);
    return { mesh, shape, roll, target: roll, pulses: [], phase: hashAngle('p' + id) / (Math.PI * 2), leaf: { x: 0, y: 0, z: 0 }, obstacle: null };
  }

  function setPulses(rec, n) {
    while (rec.pulses.length < n) {
      const p = new kit.Mesh(pulseGeo, linkMats('#ffffff', 0.5));
      p.raycast = () => {};
      group.add(p);
      rec.pulses.push(p);
    }
    while (rec.pulses.length > n) group.remove(rec.pulses.pop());
  }

  return {
    /**
     * World points along a device's root at parameters `ts` (0 gateway .. 1 device),
     * written into `out` as {x,y,z} objects; returns false if there is no root yet.
     * Used by the labels so they steer clear of the real, curved root.
     */
    points(id, ts, out) {
      const rec = recs.get(id);
      if (!rec) return false;
      for (let i = 0; i < ts.length; i++) {
        rootCurve(ts[i], SHAPES[rec.shape], pt);
        const o = out[i] || (out[i] = { x: 0, y: 0, z: 0 });
        toWorld(gwPos, rec.leaf, rec.roll, pt, o);
      }
      return true;
    },
    update(now, dt, nodes, gateway, { calm = false, steer = true, traffic = null } = {}) {
      const t = now / 1000;
      const wall = Date.now();
      for (const [id, rec] of recs) {
        if (!nodes.has(id) || !gateway) {
          group.remove(rec.mesh);
          setPulses(rec, 0);
          recs.delete(id);
        }
      }
      if (!gateway) return;
      gwPos.x = gateway.x || 0; gwPos.y = gateway.y || 0; gwPos.z = gateway.z || 0;
      leaves.length = 0;
      for (const [id, d] of nodes) {
        if (d === gateway || d.is_gateway) continue;
        leaves.push(d);
        let rec = recs.get(id);
        if (!rec) recs.set(id, (rec = make(id)));
        rec.leaf.x = d.x || 0; rec.leaf.y = d.y || 0; rec.leaf.z = d.z || 0;
      }
      // obstacles for steering: every leaf's body plus glow (the gateway is where roots start, so it is not one)
      obstacles.length = leaves.length;
      for (let i = 0; i < leaves.length; i++) {
        const d = leaves[i];
        const o = obstacles[i] || (obstacles[i] = { x: 0, y: 0, z: 0, r: 0 });
        o.x = d.x || 0; o.y = d.y || 0; o.z = d.z || 0; o.r = nodeRadius(d) * 1.6 + 3;
        recs.get(d.id).obstacle = o;
      }
      // re-steer a few roots per frame, round robin: cost stays flat as the graph grows
      if (steer && leaves.length) {
        const per = Math.min(leaves.length, 6);
        for (let k = 0; k < per; k++) {
          const rec = recs.get(leaves[cursor++ % leaves.length].id);
          rec.target = chooseRoll(gwPos, rec.leaf, SHAPES[rec.shape], obstacles, rec.target, 12, rec.obstacle);
        }
      }
      const dens = leaves.length > 30 ? Math.sqrt(30 / leaves.length) : 1; // many additive roots meet at the gateway: thin them out
      const k = 1 - Math.exp(-dt * 3);
      for (const d of leaves) {
        const rec = recs.get(d.id);
        const diff = ((rec.target - rec.roll + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        rec.roll += diff * k;
        rootMatrix(rec.mesh.matrix.elements, gwPos, rec.leaf, rec.roll);
        rec.mesh.matrixWorldNeedsUpdate = true;
        const style = nodeStyle(d);
        const col = d.online === false ? style.color : mixHex(style.color, '#9fe8d0', 0.4);
        const plan = pulsePlan(d, traffic, pulseParams(d, wall));
        // this Mac's own root brightens with its real throughput
        const live = d.is_self && plan.mode === 'measured' && traffic && traffic.host ? rateLevel(Math.max(traffic.host.rx_bps || 0, traffic.host.tx_bps || 0)) : 0;
        const strength = Math.round(Math.min(1, linkStrength(d, wall) * 1.7 * dens * (1 + 0.6 * live)) * 20) / 20;
        rec.mesh.material = linkMats(col, strength);

        let want = 0;
        if (!calm) for (const st of plan.streams) want += plan.mode === 'latency' ? linkParticles(d) || 1 : st.count;
        if (rec.pulses.length !== want) setPulses(rec, want);
        if (!want) continue;
        // measured flow: bright white-hot, larger; latency estimate: dim, small, node-coloured
        const measured = plan.mode === 'measured';
        let pi = 0;
        for (const st of plan.streams) {
          const n = measured ? st.count : linkParticles(d) || 1;
          const glow = Math.round(st.glow * 10) / 10;
          const pcol = measured
            ? linkMats(mixHex(style.color, '#ffffff', 0.8), 1)
            : linkMats(mixHex(style.color, '#ffffff', 0.15), 0.35 + 0.15 * glow);
          const size = measured ? 1.1 + 1.0 * glow : 0.5 + 0.5 * glow;
          for (let c = 0; c < n; c++) {
            const u = ((((rec.phase + t * st.speed * st.dir + c / n) % 1) + 1) % 1);
            rootCurve(u, SHAPES[rec.shape], pt);
            toWorld(gwPos, rec.leaf, rec.roll, pt, world);
            const mesh = rec.pulses[pi++];
            mesh.position.set(world.x, world.y, world.z);
            mesh.scale.setScalar(size * Math.sin(Math.PI * u) + 0.01);
            mesh.material = pcol;
          }
        }
      }
    },
  };
}
