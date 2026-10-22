// DOM side of the traffic readout. Every string that reaches the page goes through textContent;
// sparkline attributes are built from numbers only. The DOM is touched at most 4 times a second
// no matter how often samples arrive, and only where the text actually changed.
import {
  HISTORY, captureStatus, describeLink, formatRate, isStale, niceCeil, normalizeSample, pushHistory,
  rememberedOpen, smooth, sparkPoints, storeOpen,
} from './traffic.js';

const W = 200;
const H = 34;
const RENDER_MS = 250;

/** Restore and persist the open/closed state of every <details data-key> in the HUD. */
export function initCollapsibles(root) {
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  const narrow = window.innerWidth < 700;
  for (const el of root.querySelectorAll('details[data-key]')) {
    const key = el.dataset.key;
    const fallback = narrow && key !== 'network' ? false : el.hasAttribute('open');
    el.open = rememberedOpen(storage, key, fallback);
    el.addEventListener('toggle', () => storeOpen(storage, key, el.open));
  }
}

export function createTrafficUI({ onSample = () => {}, onRender = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const els = {
    sec: $('sec-network'), iface: $('net-iface'), rx: $('net-rx'), tx: $('net-tx'), sparkRx: $('spark-rx'), sparkTx: $('spark-tx'),
    linkTitle: $('net-link-title'), linkDetail: $('net-link-detail'), wanRx: $('wan-rx'), wanTx: $('wan-tx'), note: $('net-note'),
    capBadge: $('cap-badge'), capText: $('cap-text'),
  };
  const shown = new Map(); // element -> last text, so unchanged text is never rewritten
  const setText = (el, text) => {
    if (shown.get(el) === text) return;
    shown.set(el, text);
    el.textContent = text;
  };

  let sample = null;
  let lastRecv = null;
  let missing = false; // the endpoint answered 404 or failed, and no event has arrived since
  let dirty = true;
  const histRx = [];
  const histTx = [];
  const disp = { rx: undefined, tx: undefined, wanRx: undefined, wanTx: undefined };
  let wasStale = null;
  let timer = 0;

  function push(raw) {
    const s = normalizeSample(raw);
    if (!s) return;
    sample = s;
    lastRecv = Date.now();
    missing = false;
    const h = s.host;
    pushHistory(histRx, h ? h.rx_bps : null);
    pushHistory(histTx, h ? h.tx_bps : null);
    disp.rx = smooth(disp.rx, h ? h.rx_bps : null);
    disp.tx = smooth(disp.tx, h ? h.tx_bps : null);
    disp.wanRx = smooth(disp.wanRx, s.wan ? s.wan.rx_bps : null);
    disp.wanTx = smooth(disp.wanTx, s.wan ? s.wan.tx_bps : null);
    dirty = true;
    onSample(s);
  }

  function render() {
    const now = Date.now();
    const stale = isStale(lastRecv, now);
    if (!dirty && stale === wasStale) return;
    dirty = false;
    wasStale = stale;
    els.sec.classList.toggle('stale', stale && !missing);
    const s = sample;
    if (!s) {
      setText(els.rx, '—'); setText(els.tx, '—'); setText(els.wanRx, '—'); setText(els.wanTx, '—');
      setText(els.linkTitle, '—'); setText(els.linkDetail, ''); setText(els.iface, '');
      setText(els.note, missing ? 'This server version does not report traffic yet.' : 'Waiting for the first sample...');
      els.sparkRx.setAttribute('points', ''); els.sparkTx.setAttribute('points', '');
      renderCapture(null);
      onRender(null);
      return;
    }
    const live = !stale;
    setText(els.iface, s.host && s.host.iface ? s.host.iface : '');
    setText(els.rx, live ? formatRate(disp.rx) : '—');
    setText(els.tx, live ? formatRate(disp.tx) : '—');
    setText(els.wanRx, live && s.wan ? formatRate(disp.wanRx) : '—');
    setText(els.wanTx, live && s.wan ? formatRate(disp.wanTx) : '—');
    const link = describeLink(s.host && s.host.link);
    setText(els.linkTitle, link ? link.title : 'not reported');
    setText(els.linkDetail, link ? link.detail : '');
    const max = niceCeil(Math.max(0, ...histRx, ...histTx));
    els.sparkRx.setAttribute('points', sparkPoints(histRx, W, H, max, HISTORY));
    els.sparkTx.setAttribute('points', sparkPoints(histTx, W, H, max, HISTORY));
    const notes = [];
    if (stale) notes.push(`No sample for ${Math.round((now - lastRecv) / 1000)} s: showing nothing rather than old numbers.`);
    else if (!s.wan) notes.push('Internet rate unavailable: the router did not answer.');
    setText(els.note, notes.join(' '));
    renderCapture(stale ? null : s.capture);
    onRender(stale ? null : s);
  }

  function renderCapture(capture) {
    const c = captureStatus(capture);
    setText(els.capBadge, c.badge);
    setText(els.capText, c.text);
    els.capBadge.className = 'badge ' + c.state;
  }

  return {
    push,
    markMissing() {
      missing = true;
      dirty = true;
    },
    /** The latest sample, or null when none has arrived recently. */
    current() {
      return sample && !isStale(lastRecv, Date.now()) ? sample : null;
    },
    start() {
      render();
      timer = setInterval(render, RENDER_MS);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
