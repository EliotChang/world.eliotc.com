// eliotc.com atlas: a quiet world map; each place plays a short film.
// Map: Miller cylindrical (invertible, wraps horizontally). One WebGL canvas composites the
// map, the playing film, and a water-like lens that follows the cursor. On the bare map the
// lens surfaces the nearest place's film; during a film it opens a window onto the map.
(() => {
  "use strict";

  // ---------- constants ----------
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const ym = (lat) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * RAD)) * DEG;
  const latFromYm = (y) => (2.5 * Math.atan(Math.exp(0.8 * y * RAD)) - 0.625 * Math.PI) * DEG;
  const YM_MAX = ym(89.9);
  const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const approach = (cur, to, dt, tau) => cur + (to - cur) * (1 - Math.exp(-dt / tau));

  const COLORS = {
    ocean: "#0f0f0e",
    land: "#272725",
    border: "rgba(15,15,14,0.9)",
    pin: "#efeee9",
  };
  const FINALE_ID = "__finale";
  const WIPE_MS = 520;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const params = new URLSearchParams(location.search);
  const mqReduced = matchMedia("(prefers-reduced-motion: reduce)");
  const mqCoarse = matchMedia("(pointer: coarse)");
  const mqNarrow = matchMedia("(max-width: 899px)");
  const $ = (s) => document.querySelector(s);

  const els = {
    stage: $("#stage"), card: $("#card"), note: $("#note"), noteOpen: $("#note-open"), fold: $("#fold"),
    panel: $("#panel"), name: $("#p-name"), asof: $("#p-asof"), line: $("#p-line"), sources: $("#p-sources"),
    music: $("#p-music"), prev: $("#prev"), call: $("#call"), glint: $("#glint"), next: $("#next"), thread: $("#thread"),
    mute: $("#mute"), close: $("#close"), hint: $("#hint"), tip: $("#tip"),
  };

  // ---------- state ----------
  const S = {
    W: 0, H: 0, dpr: 1,
    view: { c: 0, y: 0, s: 4 },
    anim: null,               // view animation
    userMoved: false,         // user dragged the map
    cardOpen: true,
    panAfterReveal: false,
    landPath: null,
    raster: null,             // prefix-sum land raster for the card framing solver
    places: [], manifestBase: null, threads: new Map(), moment: "",
    calls: [], featherPath: [], finale: null, edges: [],
    watched: new Set(), drawn: new Set(), lineAnims: new Map(), route: null, glint: 0,
    pin: null, hot: null,
    mapDirty: true,
    pointer: { x: -1e4, y: -1e4, inside: false, type: "mouse" },
    lastMove: 0,
    down: null,
    // The lens. r: drawn radius; idle: 0 = full lens, 1 = resting as a faint ring.
    hole: { x: 0, y: 0, r: 0, vx: 0, vy: 0, hideAt: 0, idle: 0, swell: 0, holdUntil: 0 },
    // What the lens surfaces: cur fades/ripples in over old.
    surf: { cur: null, old: null, t0: 0 },
    ripple: null,             // { x, y, t0 }
    cur: null, next: null,    // video slots
    reveal: null,             // { x, y, t0, rMax, r0, f0 }
    closing: null,            // { x, y, t0, rMax, slot }
    muted: (() => { try { return localStorage.getItem("atlas-sound") !== "on"; } catch (_) { return true; } })(),
    started: false,
    posterCache: new Map(),
    lastT: performance.now(),
  };
  const reduced = () => mqReduced.matches;
  const playing = () => !!(S.cur || S.next) && !S.closing;
  const lensR = () => (playing() ? (S.W < 560 ? 72 : 80) : (S.W < 560 ? 92 : 110));

  // ---------- projection ----------
  function project(lng, lat, v = S.view) {
    return { x: S.W / 2 + v.s * wrap180(lng - v.c), y: S.H / 2 - v.s * (ym(lat) - v.y) };
  }
  function unproject(x, y, v = S.view) {
    return {
      lng: wrap180(v.c + (x - S.W / 2) / v.s),
      lat: latFromYm(clamp(v.y + (S.H / 2 - y) / v.s, -YM_MAX, YM_MAX)),
    };
  }
  // Screen x of a place's copy closest to a given screen x (the map repeats every 360deg).
  function nearestCopyX(x0, px, s) {
    const period = 360 * s;
    return x0 + Math.round((px - x0) / period) * period;
  }

  // ---------- land ----------
  async function loadLand() {
    const res = await fetch("data/land.json");
    const { q, polys } = await res.json();
    const path = new Path2D();
    for (const flat of polys) {
      let x = 0, y = 0;
      for (let i = 0; i < flat.length; i += 2) {
        x += flat[i]; y += flat[i + 1];
        const lng = x / q, my = ym(y / q);
        if (i === 0) path.moveTo(lng, my); else path.lineTo(lng, my);
      }
      path.closePath();
    }
    S.landPath = path;
    buildRaster();
  }

  // Land raster in (lng, ym) space at R px/deg, stored as a prefix sum over a doubled
  // width so any lng span (including across the antimeridian) is an O(1) query.
  function buildRaster() {
    const R = 3, w = 360 * R, h = Math.ceil(2 * 136 * R);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1 / R;
    for (const k of [-1, 0]) { // rings may run past +180; fold that part back in
      ctx.setTransform(R, 0, 0, -R, (180 + 360 * k) * R, 136 * R);
      ctx.fill(S.landPath); ctx.stroke(S.landPath);
    }
    const a = ctx.getImageData(0, 0, w, h).data;
    const W2 = 2 * w + 1, sum = new Int32Array(W2 * (h + 1));
    for (let yy = 0; yy < h; yy++) {
      let row = 0;
      for (let xx = 0; xx < 2 * w; xx++) {
        row += a[(yy * w + (xx % w)) * 4 + 3] > 0 ? 1 : 0;
        sum[(yy + 1) * W2 + xx + 1] = sum[yy * W2 + xx + 1] + row;
      }
    }
    S.raster = { R, w, h, W2, sum };
  }
  function landIn(lng0, lng1, y0, y1) {
    const { R, w, h, W2, sum } = S.raster;
    const a = lng0 - 360 * Math.floor((lng0 + 180) / 360);
    const x0 = Math.floor((a + 180) * R), x1 = Math.min(2 * w, Math.ceil((a + (lng1 - lng0) + 180) * R));
    const r0 = clamp(Math.floor((136 - y1) * R), 0, h), r1 = clamp(Math.ceil((136 - y0) * R), 0, h);
    return sum[r1 * W2 + x1] - sum[r0 * W2 + x1] - sum[r1 * W2 + x0] + sum[r0 * W2 + x0];
  }

  // ---------- framings ----------
  function worldView() {
    const s = Math.max(S.W / 360, (S.H * 0.64) / (ym(80) - ym(-58)));
    const fits = S.W / (360 * s) > 0.98;
    return { c: fits ? 11 : -20, y: (ym(80) + ym(-58)) / 2, s };
  }
  // The landing view: the centered card must sit over open ocean. Among scales up to ~2x
  // the world view, prefer a centre as far north as possible (so the landing still reads
  // as a world map), paying a small cost for zooming in; require some clearance so the
  // card never grazes a coast.
  function cardView() {
    const cw = els.card.offsetWidth, ch = els.card.offsetHeight;
    const m = S.W < 560 ? 16 : 28;
    const s0 = worldView().s, step = 0.5;
    const yLo = ym(-48), yHi = ym(36);
    const nx = 720, ny = Math.floor((yHi - yLo) / step) + 1, lng0 = -200;
    const ok = new Uint8Array(nx * ny);
    const L = new Uint16Array(nx * ny), Rr = new Uint16Array(nx * ny), U = new Uint16Array(nx * ny), D = new Uint16Array(nx * ny);
    let best = null;
    for (let s = s0; s < s0 * 3; s *= 1.03) {
      const hw = (cw / 2 + m) / s, hh = (ch / 2 + m) / s;
      let any = false;
      for (let j = 0; j < ny; j++) {
        const cy = yLo + j * step;
        const inside = cy + hh <= YM_MAX && cy - hh >= -YM_MAX;
        for (let i = 0; i < nx; i++) {
          const v = inside && landIn(lng0 + i * step - hw, lng0 + i * step + hw, cy - hh, cy + hh) === 0 ? 1 : 0;
          ok[j * nx + i] = v; if (v) any = true;
        }
      }
      if (!any) continue;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) { const k = j * nx + i; L[k] = ok[k] ? (i ? L[k - 1] : 0) + 1 : 0; }
        for (let i = nx - 1; i >= 0; i--) { const k = j * nx + i; Rr[k] = ok[k] ? (i < nx - 1 ? Rr[k + 1] : 0) + 1 : 0; }
      }
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) { const k = j * nx + i; D[k] = ok[k] ? (j ? D[k - nx] : 0) + 1 : 0; }
        for (let j = ny - 1; j >= 0; j--) { const k = j * nx + i; U[k] = ok[k] ? (j < ny - 1 ? U[k + nx] : 0) + 1 : 0; }
      }
      const need = Math.ceil(12 / (s * step)); // >= 12px of slack on every side
      for (let k = 0; k < nx * ny; k++) {
        if (!ok[k]) continue;
        const h = Math.min(L[k], Rr[k]), v = Math.min(U[k], D[k]);
        if (h < need || v < need) continue;
        const j = Math.floor(k / nx);
        const value = latFromYm(yLo + j * step) - 30 * Math.log(s / s0) + Math.min(h, 3 * need) * 0.01;
        if (!best || value > best.value) best = { value, c: wrap180(lng0 + (k % nx) * step), y: yLo + j * step, s };
      }
    }
    return best ? { c: best.c, y: best.y, s: best.s } : worldView();
  }

  function setView(target, animate) {
    if (!animate || reduced()) { S.view = { ...target }; S.anim = null; S.mapDirty = true; return; }
    const from = { ...S.view };
    const dc = wrap180(target.c - from.c);
    const dist = Math.hypot(dc * from.s, (target.y - from.y) * from.s);
    S.anim = { from, dc, to: { ...target }, t0: performance.now(), dur: clamp(700 + dist * 0.35, 800, 1500) };
  }
  function stepView(now) {
    const a = S.anim; if (!a) return;
    const t = clamp((now - a.t0) / a.dur, 0, 1), e = easeInOut(t);
    S.view = {
      c: wrap180(a.from.c + a.dc * e),
      y: a.from.y + (a.to.y - a.from.y) * e,
      s: a.from.s * Math.pow(a.to.s / a.from.s, e),
    };
    S.mapDirty = true;
    if (t >= 1) S.anim = null;
  }

  // ---------- memory: what this viewer has watched, and the lines it has earned ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const KEY_W = "atlas-watched", KEY_D = "atlas-drawn";
  if (params.get("reset") === "1") { store.del(KEY_W); store.del(KEY_D); }
  for (const id of store.get(KEY_W) || []) if (typeof id === "string") S.watched.add(id);
  for (const k of store.get(KEY_D) || []) if (typeof k === "string") S.drawn.add(k);

  // Connections: places sharing a thread, the two ends of a call, consecutive feather stops.
  function buildEdges(ids) {
    const out = new Map();
    const add = (a, b, kind) => {
      if (!a || !b || a === b || !ids.has(a) || !ids.has(b)) return;
      const [x, y] = a < b ? [a, b] : [b, a], key = `${kind}:${x}|${y}`;
      if (!out.has(key)) out.set(key, { key, kind, a: x, b: y });
    };
    const byThread = new Map();
    for (const p of S.places) for (const t of Array.isArray(p.threads) ? p.threads : []) {
      if (!byThread.has(t)) byThread.set(t, []);
      byThread.get(t).push(p.id);
    }
    for (const list of byThread.values()) for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) add(list[i], list[k], "thread");
    for (const c of S.calls) add(c.places[0], c.places[1], "call");
    for (let i = 1; i < S.featherPath.length; i++) add(S.featherPath[i - 1], S.featherPath[i], "feather");
    return [...out.values()];
  }
  const placeById = (id) => S.places.find((p) => p.id === id);
  function markWatched(place) {
    if (!place || S.watched.has(place.id) || !placeById(place.id)) return;
    S.watched.add(place.id);
    store.set(KEY_W, [...S.watched]);
    S.mapDirty = true;
  }
  const edgeEarned = (e) => S.watched.has(e.a) && S.watched.has(e.b);
  // New lines draw themselves slowly the first time the bare map is in view.
  function startLineAnims(now) {
    let i = 0;
    for (const e of S.edges) {
      if (!edgeEarned(e) || S.drawn.has(e.key) || S.lineAnims.has(e.key)) continue;
      S.lineAnims.set(e.key, reduced() ? now - 1e5 : now + 500 + 700 * i++);
    }
  }
  function stepLineAnims(now) {
    let changed = false;
    for (const [key, t0] of S.lineAnims) {
      if (now - t0 >= LINE_MS) { S.lineAnims.delete(key); S.drawn.add(key); changed = true; }
    }
    if (changed) store.set(KEY_D, [...S.drawn]);
  }
  const LINE_MS = 2800;
  const featherComplete = () => S.featherPath.length > 1 && S.featherPath.every((id) => placeById(id) && S.watched.has(id));

  const LINE_STYLE = {
    thread: { color: "rgba(226,196,158,0.34)", dash: [], bend: 0.14 },
    call: { color: "rgba(160,192,226,0.34)", dash: [], bend: -0.14 },
    feather: { color: "rgba(239,238,233,0.34)", dash: [3, 4], bend: 0 },
  };
  // A gentle arc between two places, taking the short way across the date line.
  function edgePoints(a, b) {
    const A = project(a.lng, a.lat), By = project(b.lng, b.lat).y;
    const Bx = A.x + wrap180(b.lng - a.lng) * S.view.s;
    return [A.x, A.y, Bx, By];
  }
  function strokeCurve(ax, ay, bx, by, bend, t0, t1) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay;
    const cx = mx - dy * bend, cy = my + dx * bend;
    const n = 64, i0 = Math.floor(t0 * n), i1 = Math.ceil(t1 * n);
    const pt = (t) => [(1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx, (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by];
    mctx.beginPath();
    for (let i = i0; i <= i1; i++) { const [x, y] = pt(clamp(i / n, t0, t1)); if (i === i0) mctx.moveTo(x, y); else mctx.lineTo(x, y); }
    mctx.stroke();
  }
  function drawLines(now) {
    const period = 360 * S.view.s;
    const each = (e, fn) => {
      const a = placeById(e.a), b = placeById(e.b);
      if (!a || !b) return;
      const [ax, ay, bx, by] = edgePoints(a, b);
      for (let k = -2; k <= 2; k++) {
        const o = k * period;
        if (Math.max(ax, bx) + o < -20 || Math.min(ax, bx) + o > S.W + 20) continue;
        fn(ax + o, ay, bx + o, by);
      }
    };
    mctx.lineWidth = 0.8; mctx.lineCap = "round";
    for (const e of S.edges) {
      if (!edgeEarned(e)) continue;
      let p = 0;
      if (S.drawn.has(e.key)) p = 1;
      else if (S.lineAnims.has(e.key)) p = easeInOut(clamp((now - S.lineAnims.get(e.key)) / LINE_MS, 0, 1));
      if (p <= 0) continue;
      const st = LINE_STYLE[e.kind];
      mctx.strokeStyle = st.color; mctx.setLineDash(st.dash);
      each(e, (ax, ay, bx, by) => strokeCurve(ax, ay, bx, by, st.bend, 0, p));
    }
    mctx.setLineDash([]);
    // after the finale: the whole route draws itself once, brighter, then settles
    if (S.route) {
      const t = (now - S.route) / 1000, n = S.featherPath.length - 1, dur = Math.max(4, n * 0.9);
      const fade = 1 - smooth(dur, dur + 2, t);
      if (fade <= 0) { S.route = null; return; }
      mctx.strokeStyle = `rgba(239,238,233,${0.75 * fade})`; mctx.lineWidth = 1.1;
      for (let i = 0; i < n; i++) {
        const p = clamp(t / dur * n - i, 0, 1);
        if (p <= 0) break;
        const a = placeById(S.featherPath[i]), b = placeById(S.featherPath[i + 1]);
        each({ a: a.id, b: b.id }, (ax, ay, bx, by) => strokeCurve(ax, ay, bx, by, 0, 0, easeOut(p)));
      }
    }
  }

  // A direction from the pipeline ("right", "east", "up", degrees...) as a unit screen vector.
  function dirVec(d) {
    if (typeof d === "number" && Number.isFinite(d)) return { x: Math.cos(d * RAD), y: -Math.sin(d * RAD) };
    const s = typeof d === "string" ? d.toLowerCase() : "";
    const x = /right|east|l-?r/.test(s) ? 1 : /left|west|r-?l/.test(s) ? -1 : 0;
    const y = /down|south|bottom/.test(s) ? 1 : /up|north|top/.test(s) ? -1 : 0;
    return x || y ? { x, y } : null;
  }
  // The travel direction between two consecutive feather stops, or null.
  function featherDir(from, to) {
    if (!from || !to) return null;
    const i = S.featherPath.indexOf(from.id), k = S.featherPath.indexOf(to.id);
    if (i < 0 || k < 0 || Math.abs(i - k) !== 1) return null;
    const ff = from.feather || {}, tf = to.feather || {};
    if (k > i) return dirVec(ff.exit) || dirVec(tf.enter);
    const back = dirVec(ff.enter) || dirVec(tf.exit);
    return back && { x: -back.x, y: -back.y };
  }
  // When a shot plays: {start, end} given directly, via place.shots[n], or the nth caption.
  function shotWindow(place, shot) {
    if (shot && typeof shot === "object") {
      const s = +(shot.start ?? shot.t ?? shot.time);
      return Number.isFinite(s) ? { start: s, end: Number.isFinite(+shot.end) ? +shot.end : s + 5 } : null;
    }
    if (typeof shot !== "number" || !Number.isFinite(shot)) return null;
    if (!Number.isInteger(shot)) return { start: shot, end: shot + 5 };
    const src = (Array.isArray(place.shots) && place.shots[shot]) || (Array.isArray(place.captions) && place.captions[shot]);
    if (src && Number.isFinite(+src.start)) return { start: +src.start, end: Number.isFinite(+src.end) ? +src.end : +src.start + 5 };
    return { start: shot * 5, end: shot * 5 + 5 };
  }
  function callOf(place) {
    const c = place && place.call;
    if (!c || typeof c !== "object") return null;
    let other = c.with && placeById(c.with);
    if (!other && c.id) { const top = S.calls.find((x) => x.id === c.id); if (top) other = placeById(top.places.find((id) => id !== place.id)); }
    const win = shotWindow(place, c.shot);
    return other && win ? { other, win } : null;
  }

  // ---------- map canvas ----------
  const mapCv = document.createElement("canvas");
  const mctx = mapCv.getContext("2d");
  // A soft glow sprite for "a film lives here" dots.
  const glowCv = document.createElement("canvas");
  (() => {
    const n = 48; glowCv.width = glowCv.height = n;
    const g = glowCv.getContext("2d");
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, "rgba(239,238,233,0.30)");
    grad.addColorStop(0.35, "rgba(239,238,233,0.10)");
    grad.addColorStop(1, "rgba(239,238,233,0)");
    g.fillStyle = grad; g.fillRect(0, 0, n, n);
  })();
  function drawMap() {
    const { W, H, dpr, view: v } = S;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.fillStyle = COLORS.ocean;
    mctx.fillRect(0, 0, mapCv.width, mapCv.height);
    if (!S.landPath) return;
    for (let k = -2; k <= 2; k++) {
      const left = W / 2 + v.s * (k * 360 - v.c - 180);
      if (left > W || left + 375 * v.s < 0) continue;
      mctx.setTransform(v.s * dpr, 0, 0, -v.s * dpr, (W / 2 + v.s * (k * 360 - v.c)) * dpr, (H / 2 + v.s * v.y) * dpr);
      mctx.fillStyle = COLORS.land;
      mctx.fill(S.landPath);
      mctx.lineWidth = 0.75 / v.s;
      mctx.strokeStyle = COLORS.border;
      mctx.stroke(S.landPath);
    }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLines(performance.now());
    const period = 360 * v.s;
    const copies = (q, pad, fn) => {
      for (let x = q.x - period * Math.ceil(q.x / period); x < W + pad; x += period) if (x > -pad) fn(x, q.y);
    };
    for (const p of S.places) {
      const isPin = S.pin && p.id === S.pin.id, isHot = S.hot && p.id === S.hot.id, watched = S.watched.has(p.id);
      copies(project(p.lng, p.lat), 24, (x, y) => {
        if (isPin) {
          mctx.fillStyle = COLORS.pin;
          mctx.beginPath(); mctx.arc(x, y, 3.5, 0, Math.PI * 2); mctx.fill();
          mctx.strokeStyle = "rgba(239,238,233,0.45)"; mctx.lineWidth = 1;
          mctx.beginPath(); mctx.arc(x, y, 9, 0, Math.PI * 2); mctx.stroke();
          return;
        }
        mctx.drawImage(glowCv, x - 12, y - 12, 24, 24);
        mctx.fillStyle = isHot ? "rgba(239,238,233,0.95)" : "rgba(239,238,233,0.6)";
        mctx.beginPath(); mctx.arc(x, y, isHot ? 2.4 : 1.8, 0, Math.PI * 2); mctx.fill();
        if (isHot) {
          mctx.strokeStyle = "rgba(239,238,233,0.4)"; mctx.lineWidth = 1;
          mctx.beginPath(); mctx.arc(x, y, 7, 0, Math.PI * 2); mctx.stroke();
        } else if (watched) {
          mctx.strokeStyle = "rgba(239,238,233,0.22)"; mctx.lineWidth = 0.8;
          mctx.beginPath(); mctx.arc(x, y, 4.5, 0, Math.PI * 2); mctx.stroke();
        }
      });
    }
  }

  // ---------- WebGL ----------
  const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;
  const FS = `
precision highp float;
uniform sampler2D uMap, uPrev, uNext, uSA, uSAv, uSB, uSBv;
uniform vec2 uRes, uVel;
uniform float uDpr, uTime, uMotion, uPrevAsp, uNextAsp, uHasPrev, uHasNext, uFilm, uIdle;
uniform vec3 uPrevF, uNextF, uReveal, uHole, uRipple, uSurf;
uniform vec4 uA, uB;
// A film laid out as a rect of height F.z px centred on F.xy.
vec2 frameUV(vec2 p, vec3 F, float asp) { return vec2((p.x - F.x) / (F.z * asp), (p.y - F.y) / F.z) + 0.5; }
float wob(vec2 d, float t, float amp) {
  float a = atan(d.y, d.x);
  return amp * (0.5 * sin(3.0 * a + 1.1 * t) + 0.3 * sin(5.0 * a - 1.7 * t + 1.3) + 0.2 * sin(9.0 * a + 2.3 * t + 4.0));
}
float line(float d, float w) { return exp(-(d * d) / (2.0 * w * w)); }
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float f = 1.2 * uDpr;

  // click ripple: a travelling ring that refracts whatever is under it
  vec2 disp = vec2(0.0);
  float glow = 0.0;
  if (uRipple.z >= 0.0) {
    vec2 d = p - uRipple.xy; float r = length(d);
    float R = uRipple.z * 820.0 * uDpr, w = 46.0 * uDpr, k = (r - R) / w;
    float prof = exp(-k * k) * exp(-uRipple.z * 2.4);
    disp = d / max(r, 1.0) * prof * 9.0 * uDpr * sin(k * 2.6);
    glow = prof;
  }
  vec2 mp = p + disp;
  vec3 mapC = texture2D(uMap, mp / uRes).rgb;

  // base: the map, or the film (with a new film blooming open inside the reveal circle)
  vec3 base = uHasPrev > 0.5 ? texture2D(uPrev, frameUV(mp, uPrevF, uPrevAsp)).rgb : mapC;
  if (uHasNext > 0.5) {
    vec2 rd = p - uReveal.xy; vec2 rn = rd / max(length(rd), 1.0);
    float rs = length(rd) - (uReveal.z + wob(rd, uTime * 1.3, 6.0 * uDpr * uMotion));
    float rm = 1.0 - smoothstep(-1.5 * f, 1.5 * f, rs);
    float wk = rs / (22.0 * uDpr);
    vec2 wd = rn * exp(-wk * wk) * sin(wk * 2.4) * 10.0 * uDpr * uMotion * step(1.0, uReveal.z);
    vec3 nx = texture2D(uNext, frameUV(mp + wd, uNextF, uNextAsp)).rgb;
    if (uHasPrev > 0.5) base = texture2D(uPrev, frameUV(mp + wd, uPrevF, uPrevAsp)).rgb;
    base = mix(base, nx, rm) + line(rs, 3.0 * uDpr) * step(1.0, uReveal.z) * 0.06;
  }
  vec3 col = base;

  // the lens
  if (uHole.z > 0.5) {
    vec2 hd = p - uHole.xy; float hr = length(hd); vec2 hn = hd / max(hr, 1.0);
    float vm = length(uVel);
    float amp = (1.5 * uDpr + min(vm * 0.4, 14.0 * uDpr)) * uMotion;
    float bulge = vm > 0.01 ? dot(hn, uVel / vm) * min(vm * 0.5, 16.0 * uDpr) * uMotion : 0.0;
    float hs = hr - (uHole.z + wob(hd, uTime * 1.7, amp) + bulge);
    float lm = (1.0 - smoothstep(-f, f, hs)) * (1.0 - uIdle);
    float rim = smoothstep(-26.0 * uDpr, 0.0, hs) * (1.0 - smoothstep(-f, f, hs));
    // swap ripple: a ring running outward from the centre refracts the lens contents
    float rk = (hr - uSurf.y) / (16.0 * uDpr);
    vec2 lp = p - hn * rim * rim * 14.0 * uDpr + hn * exp(-rk * rk) * uSurf.z * 7.0 * uDpr * uMotion;
    vec3 lensC = texture2D(uMap, (lp + disp) / uRes).rgb * 1.08;
    float sd = hr - (uSurf.x + wob(hd, uTime * 1.3 + 2.0, 2.0 * uDpr * uMotion));
    float sm = 1.0 - smoothstep(-f, f, sd);
    float bm = 1.0 - smoothstep(-2.0 * f, 2.0 * f, hr - uSurf.y - wob(hd, uTime * 2.1 + 5.0, 5.0 * uDpr * uMotion));
    vec3 F = vec3(uHole.xy, uSurf.x * 2.2);
    // films refract less than the map at the rim, so their edges do not smear
    vec2 fp = p - hn * rim * rim * 5.0 * uDpr + hn * exp(-rk * rk) * uSurf.z * 7.0 * uDpr * uMotion;
    vec2 ua = frameUV(fp, F, uA.y), ub = frameUV(fp, F, uB.y);
    vec3 cA = mix(texture2D(uSA, ua).rgb, texture2D(uSAv, ua).rgb, uA.x);
    vec3 cB = mix(texture2D(uSB, ub).rgb, texture2D(uSBv, ub).rgb, uB.x);
    vec4 s = mix(vec4(cA * uA.z, uA.z), vec4(cB * uB.z, uB.z), bm) * sm;
    lensC = lensC * (1.0 - s.a) + s.rgb;
    lensC *= 1.0 - 0.22 * rim * rim;
    lensC += line(sd, 1.1 * uDpr) * 0.10 * s.a * uFilm;
    float shade = (1.0 - smoothstep(0.0, 24.0 * uDpr, hs)) * step(0.0, hs) * (1.0 - uIdle);
    col = mix(base * (1.0 - 0.28 * shade), lensC, lm);
    col += line(hs, 1.1 * uDpr) * mix(0.11, 0.07, uIdle);
  }
  col += glow * 0.03;
  gl_FragColor = vec4(col, 1.0);
}`;

  let gl = null, prog = null, U = {}, mapTex = null, blankTex = null;
  function initGL() {
    try {
      gl = els.stage.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: false });
    } catch (_) { gl = null; }
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    try {
      if (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < 7) throw new Error("too few texture units");
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.info("atlas: WebGL unavailable, using 2D fallback", e.message); gl = null; return false; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["uMap", "uPrev", "uNext", "uSA", "uSAv", "uSB", "uSBv", "uRes", "uVel", "uDpr", "uTime", "uMotion", "uPrevAsp", "uNextAsp", "uHasPrev", "uHasNext", "uFilm", "uIdle", "uPrevF", "uNextF", "uReveal", "uHole", "uRipple", "uSurf", "uA", "uB"]) U[n] = gl.getUniformLocation(prog, n);
    ["uMap", "uPrev", "uNext", "uSA", "uSAv", "uSB", "uSBv"].forEach((n, i) => gl.uniform1i(U[n], i));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    mapTex = makeTex(); blankTex = makeTex();
    return true;
  }
  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([15, 15, 14]));
    return t;
  }
  function upload(tex, src) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
  }

  // ---------- media ----------
  const videoEls = [...document.querySelectorAll(".videos video")];
  const slots = videoEls.slice(0, 2).map((el) => ({ el, tex: null, asp: 16 / 9, place: null, hasContent: false, tainted: false, failed: false, lastT: -1 }));
  // One muted <video> feeds the lens; two textures ping-pong so the outgoing place keeps its last frame.
  const preview = { el: videoEls[2], place: null, timer: 0, lastT: -1, frames: 0, idleTimer: 0 };
  let vidTex = [null, null];
  const assetURL = (rel) => new URL(rel, S.manifestBase).href;

  function loadSlot(slot, place, autoplay) {
    if (slot.place && slot.place.id === place.id && slot.el.getAttribute("src")) {
      if (autoplay) playEl(slot.el);
      return;
    }
    slot.place = place; slot.hasContent = false; slot.tainted = false; slot.failed = false; slot.lastT = -1;
    slot.videoReady = false; slot.posterReady = false; slot.loadT = performance.now();
    const gen = slot.gen = (slot.gen || 0) + 1;
    const el = slot.el;
    // never let the last film this slot played show through
    if (gl) gl.bindTexture(gl.TEXTURE_2D, slot.tex), gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([15, 15, 14]));
    el.loop = place.id !== FINALE_ID;
    el.crossOrigin = "anonymous";
    el.muted = S.muted;
    el.preload = "auto";
    el.src = assetURL(place.video);
    watchFirstFrame(slot, gen);
    if (autoplay) playEl(el);
    const img = posterFor(place);
    const usePoster = () => {
      if (slot.gen !== gen || slot.videoReady || !img.naturalWidth) return;
      if (gl) { try { upload(slot.tex, img); } catch (_) { return; } }
      slot.asp = img.naturalWidth / img.naturalHeight; slot.posterReady = true;
    };
    if (img.complete) usePoster(); else img.addEventListener("load", usePoster, { once: true });
  }
  // Play with the remembered sound choice; if the browser refuses sound without a
  // gesture, play muted this time (the remembered choice is left alone).
  function playEl(el) {
    el.muted = S.muted;
    el.play().catch(() => {
      if (el.muted) return;
      S.muted = true; syncSound();
      for (const s of slots) s.el.muted = true;
      el.play().catch(() => {});
    });
  }
  function syncSound() {
    els.mute.textContent = S.muted ? "Sound on" : "Sound off";
    els.mute.setAttribute("aria-pressed", String(!S.muted));
  }
  // Mark a slot ready when the element presents its first real frame for this load.
  function watchFirstFrame(slot, gen) {
    const el = slot.el;
    const ok = () => { if (slot.gen === gen && slot.el === el) slot.videoReady = true; };
    if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(ok);
    else el.addEventListener("loadeddata", ok, { once: true });
  }
  function clearVideo(el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.classList.remove("is-on");
  }
  function unloadSlot(slot) {
    clearVideo(slot.el);
    slot.place = null; slot.hasContent = false;
  }
  function posterFor(place) {
    let img = S.posterCache.get(place.id);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = assetURL(place.poster);
      img.addEventListener("error", () => {}, { once: true });
      S.posterCache.set(place.id, img);
    }
    return img;
  }
  // Lens-sized poster textures (downscaled once; the lens never needs more than ~640px).
  const posterTexCache = new Map();
  const scaleCv = document.createElement("canvas");
  function posterTex(place) {
    let e = posterTexCache.get(place.id);
    if (e || !gl) return e || null;
    e = { tex: makeTex(), ready: false, asp: 16 / 9 };
    posterTexCache.set(place.id, e);
    const img = posterFor(place);
    const done = () => {
      if (!img.naturalWidth) return;
      const w = Math.min(640, img.naturalWidth), h = Math.round(w * img.naturalHeight / img.naturalWidth);
      scaleCv.width = w; scaleCv.height = h;
      const c = scaleCv.getContext("2d"); c.drawImage(img, 0, 0, w, h);
      try { upload(e.tex, scaleCv); e.ready = true; e.asp = w / h; } catch (_) {}
    };
    if (img.complete) done(); else img.addEventListener("load", done, { once: true });
    return e;
  }
  function slotOf(el) { return slots.find((s) => s.el === el); }
  for (const el of videoEls) {
    el.addEventListener("error", () => {
      const slot = slotOf(el);
      if (!slot || !slot.place) return;
      slot.failed = true; slot.loadT = -1e9;
      if (slot === S.next || slot === S.cur) els.line.textContent = "This film is not available right now.";
    });
  }
  const otherSlot = (slot) => (slot === slots[0] ? slots[1] : slots[0]);
  for (const el of videoEls) {
    el.addEventListener("ended", () => {
      const slot = slotOf(el);
      if (slot && slot === S.cur && slot.place && slot.place.id === FINALE_ID) { S.routePending = true; closeVideo(); }
    });
  }

  function wantPreview(place) {
    clearTimeout(preview.idleTimer); preview.idleTimer = 0;
    if (preview.place === place) { if (preview.el.paused && preview.el.getAttribute("src")) preview.el.play().catch(() => {}); return; }
    clearTimeout(preview.timer);
    // A short dwell so sweeping across the map does not start a download per dot.
    preview.timer = setTimeout(() => {
      preview.place = place; preview.lastT = -1; preview.frames = 0;
      const el = preview.el;
      el.crossOrigin = "anonymous"; el.muted = true; el.loop = true; el.preload = "auto";
      el.src = assetURL(place.video);
      el.play().catch(() => {});
    }, reduced() ? 0 : 120);
  }
  function restPreview() {
    clearTimeout(preview.timer);
    if (preview.idleTimer || !preview.place) return;
    preview.idleTimer = setTimeout(() => { preview.idleTimer = 0; if (!S.surf.cur) preview.el.pause(); }, 1200);
  }

  // ---------- picking ----------
  function screenOf(p, nearX) {
    const q = project(p.lng, p.lat);
    return { x: nearestCopyX(q.x, nearX, S.view.s), y: q.y };
  }
  // What the lens at (x, y) would surface. Bare map: the nearest place within reach (with a
  // distance fade). During a film: only a place inside the lens, never the one playing.
  function pickAt(x, y) {
    const film = playing(), R = lensR();
    const reach = film ? R * 0.85 : R * 2.6;
    let best = null, bd = Infinity;
    for (const p of S.places) {
      if (film && ((S.pin && p.id === S.pin.id))) continue;
      const q = screenOf(p, x);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best || bd > reach) return null;
    return { place: best, d: bd, str: film ? 1 : 1 - smooth(R * 1.6, reach, bd) };
  }
  function nearestPlace(lng, lat) {
    let best = null, bd = Infinity;
    const c1 = Math.cos(lat * RAD);
    for (const p of S.places) {
      const dLat = (p.lat - lat) * RAD, dLng = (p.lng - lng) * RAD;
      const h = Math.sin(dLat / 2) ** 2 + c1 * Math.cos(p.lat * RAD) * Math.sin(dLng / 2) ** 2;
      if (h < bd) { bd = h; best = p; }
    }
    return best;
  }
  // Flip through the world: the next place east (dir 1) or west (-1) by longitude, wrapping.
  function neighbor(from, dir, filter) {
    let best = null, bd = Infinity;
    for (const p of S.places) {
      if (p.id === from.id || (filter && !filter(p))) continue;
      let dl = wrap180(p.lng - from.lng) * dir;
      if (dl <= 0) dl += 360;
      if (dl < bd) { bd = dl; best = p; }
    }
    return best;
  }

  // ---------- selection ----------
  const coverFrame = (asp) => ({ x: S.W / 2, y: S.H / 2, h: Math.max(S.H, S.W / asp) });

  function select(place, x, y, opt = {}) {
    if (!place) return;
    S.started = true;
    if (S.cardOpen) { minimizeCard(false); S.panAfterReveal = !S.userMoved; }
    if (S.closing) { S.cur = S.closing.slot; S.closing = null; }
    if (S.cur && S.cur.place && S.cur.place.id === place.id && !S.next) {
      S.ripple = reduced() ? null : { x, y, t0: performance.now() };
      return;
    }
    if (S.next && S.reveal && S.reveal.t0) { // a wipe is mid-way: finish it now, never overlap two
      if (S.cur && S.cur !== S.next) unloadSlot(S.cur);
      S.cur = S.next; S.next = null; S.reveal = null;
    }
    const fromPlace = (S.next || S.cur || {}).place;
    document.body.classList.toggle("is-finale", place.id === FINALE_ID);
    S.pin = place; S.hot = null; S.mapDirty = true;
    S.ripple = reduced() || opt.fromLens || S.cur || S.next ? null : { x, y, t0: performance.now() };
    const slot = S.next || (S.cur ? otherSlot(S.cur) : slots[0]);
    const sc = S.surf.cur;
    let r0 = 0, f0 = null;
    if (opt.fromLens && sc && sc.place === place) {
      // Bloom out of the lens: the film keeps the size and position it had inside it.
      const surfR = playing() ? lensR() * 0.5 * (1 + 0.15 * S.hole.swell) : S.hole.r;
      r0 = surfR; f0 = { x: S.hole.x, y: S.hole.y, h: surfR * 2.2 };
      x = S.hole.x; y = S.hole.y;
    }
    if (gl && sc && sc.place === place && preview.place === place && sc.vidOn && preview.el.readyState >= 2) {
      // Hand the lens's live <video> to the film slot: no reload, no restart.
      const el = slot.el; slot.el = preview.el; preview.el = el;
      const t = slot.tex; slot.tex = vidTex[sc.vt]; vidTex[sc.vt] = t;
      clearVideo(preview.el); preview.place = null; clearTimeout(preview.timer);
      Object.assign(slot, { place, hasContent: true, videoReady: true, posterReady: false, tainted: false, failed: false, lastT: -1, loadT: performance.now(), gen: (slot.gen || 0) + 1, asp: slot.el.videoWidth / slot.el.videoHeight || 16 / 9 });
      playEl(slot.el);
    } else loadSlot(slot, place, true);
    S.next = slot;
    S.surf = { cur: null, old: null, t0: 0 };
    S.hole.r = 0; S.hole.holdUntil = performance.now() + (reduced() ? 0 : 1300);
    // Feather relay: the next stop arrives from the side the last one left by, sliding in.
    const fd = !f0 && (featherDir(fromPlace, place) || opt.side);
    let slide = null;
    if (fd) {
      x = S.W * (0.5 + 0.5 * fd.x); y = S.H * (0.5 + 0.5 * fd.y);
      const full = coverFrame(16 / 9);
      f0 = { x: full.x + fd.x * S.W * 0.08, y: full.y + fd.y * S.H * 0.08, h: full.h };
      slide = { x: -fd.x * S.W * 0.04, y: -fd.y * S.H * 0.04 };
      S.ripple = null;
    }
    S.reveal = { x, y, t0: 0, r0, f0, slide, rMax: Math.hypot(Math.max(x, S.W - x), Math.max(y, S.H - y)) + 80 };
    // the caption changes with the picture, not before it
    if (!S.cur) showPanel(place); else S.reveal.panel = place;
    document.body.classList.add("is-playing");
    updateHint();
  }

  // ---------- the ending ----------
  const lastStop = () => placeById(S.featherPath[S.featherPath.length - 1]);
  function playFinale() {
    const last = lastStop();
    if (!S.finale || !last) return;
    S.glint = 0; els.glint.classList.remove("is-on");
    const pl = { id: FINALE_ID, name: "", country: "", lat: last.lat, lng: last.lng, video: S.finale.video, poster: S.finale.poster || last.poster, captions: [], sources: [] };
    const q = screenOf(last, S.W / 2);
    select(pl, q.x, q.y);
  }
  function stepGlint(now) {
    const last = lastStop();
    if (!S.glint && S.finale && last && !playing() && !S.closing && !S.cardOpen && !S.down && now - S.lastMove > 3500 && featherComplete()) S.glint = now;
    const show = S.glint && !playing() && !S.closing && last;
    if (show) {
      const q = screenOf(last, S.W / 2);
      els.glint.style.transform = `translate(${q.x}px, ${q.y}px)`;
    }
    els.glint.classList.toggle("is-on", !!show);
  }

  function flip(dir) {
    const from = (S.next || S.cur || {}).place;
    if (!from || S.closing || from.id === FINALE_ID) return;
    go(neighbor(from, dir), { x: dir, y: 0 });
  }
  // Jump to a place from the keyboard or the caption: pan the (hidden) map if it is off-screen,
  // and open the film from where the place sits on the map.
  function go(place, side) {
    if (!place) return;
    let q = screenOf(place, S.W / 2);
    if (q.x < S.W * 0.08 || q.x > S.W * 0.92 || q.y < S.H * 0.08 || q.y > S.H * 0.92) {
      const half = S.H / 2 / S.view.s;
      const target = { ...S.view, c: place.lng, y: clamp(ym(place.lat), -YM_MAX + half, Math.max(-YM_MAX + half, YM_MAX - half)) };
      setView(target, false);
      q = screenOf(place, S.W / 2);
    }
    select(place, clamp(q.x, S.W * 0.06, S.W * 0.94), clamp(q.y, S.H * 0.1, S.H * 0.9), { side: playing() ? side : null });
  }

  function closeVideo() {
    if (!S.cur && !S.next) return;
    if (S.next) { unloadSlot(S.next); S.next = null; S.reveal = null; }
    if (!S.cur) { finishClose(); return; }
    const q = S.pin ? screenOf(S.pin, S.W / 2) : { x: S.W / 2, y: S.H / 2 };
    const x = clamp(q.x, 0, S.W), y = clamp(q.y, 0, S.H);
    S.closing = { slot: S.cur, x, y, t0: performance.now(), rMax: Math.hypot(Math.max(x, S.W - x), Math.max(y, S.H - y)) + 80 };
    S.cur = null;
    document.body.classList.remove("is-playing");
    if (reduced()) finishClose();
  }
  function finishClose() {
    if (S.closing) unloadSlot(S.closing.slot);
    S.closing = null;
    S.pin = null; S.mapDirty = true;
    document.body.classList.remove("is-playing", "is-finale");
    if (S.routePending) { S.routePending = false; S.route = performance.now() + 600; S.lastMove = performance.now() + 8000; }
    if (S.panAfterReveal) { S.panAfterReveal = false; setView(worldView(), true); }
    updateHint();
  }

  // ---------- panel / captions ----------
  function fmtDate(iso) {
    const [y, m, d] = (iso || "").split("-").map(Number);
    return y && m && d ? `as of ${MONTHS[m - 1]} ${d}, ${y}` : "";
  }
  // localTime is shown exactly as the manifest states it (never derived from longitude).
  function fmtLocal(v) {
    if (typeof v !== "string" || !v) return "";
    const t = v.match(/T(\d{2}:\d{2})/) || v.match(/^(\d{1,2}:\d{2}(?:\s?[AaPp][Mm])?)/);
    if (t) return t[1];
    return v.length <= 16 ? v : "";
  }
  // moment may be an ISO instant ("2026-09-25T12:00:00Z") or a ready-made label.
  function momentLabel(m) {
    const v = typeof m === "string" ? m : m && typeof m === "object" ? (m.label || m.title || m.text || m.iso || "") : "";
    const iso = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/);
    if (iso) return `${fmtDate(iso[1])}, ${iso[2]} UTC`;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v;
  }
  function placeThreads(place) {
    return (Array.isArray(place.threads) ? place.threads : []).map((id) => S.threads.get(id)).filter(Boolean);
  }
  let lineText = null;
  function showPanel(place) {
    els.name.textContent = place.country && place.country !== place.name ? `${place.name}, ${place.country}` : place.name;
    const local = fmtLocal(place.localTime);
    els.asof.textContent = [S.moment || fmtDate(place.asOf), local && `${local} local`].filter(Boolean).join(" · ");
    setLine("");
    const seen = new Set(), perOutlet = new Map(), list = [];
    for (const s of Array.isArray(place.sources) ? place.sources : []) {
      if (!s || !s.url) continue;
      let outlet = s.outlet;
      try { outlet = outlet || new URL(s.url).hostname.replace(/^www\./, ""); } catch (_) { outlet = outlet || "Source"; }
      const key = `${outlet.toLowerCase()}|${s.url.replace(/[#?].*$/, "").replace(/\/$/, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = (perOutlet.get(outlet) || 0) + 1; perOutlet.set(outlet, n);
      list.push({ s, label: n > 1 ? `${outlet} (${n})` : outlet });
      if (list.length === 4) break;
    }
    els.sources.replaceChildren(...list.map(({ s, label }) => {
      const a = document.createElement("a");
      a.href = s.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = label;
      if (s.title) a.title = s.title;
      return a;
    }));
    const music = place.music && typeof place.music === "object" ? place.music.title : typeof place.music === "string" ? place.music : "";
    els.music.textContent = music ? `Music: ${music}` : "";
    const w = neighbor(place, -1), e = neighbor(place, 1);
    els.prev.hidden = !w; els.next.hidden = !e;
    if (w) { els.prev.querySelector(".nav-name").textContent = w.name; els.prev.setAttribute("aria-label", `West to ${w.name}`); }
    if (e) { els.next.querySelector(".nav-name").textContent = e.name; els.next.setAttribute("aria-label", `East to ${e.name}`); }
    const call = callOf(place);
    els.call.hidden = !call; els.call.classList.remove("is-on");
    if (call) { els.call.querySelector(".nav-name").textContent = call.other.name; els.call.dataset.target = call.other.id; els.call.setAttribute("aria-label", `Over to ${call.other.name}`); }
    // Threads: a tiny tag that jumps to the next place (eastward) on the same story.
    els.thread.hidden = true; els.thread.dataset.target = "";
    for (const th of placeThreads(place)) {
      const to = neighbor(place, 1, (p) => Array.isArray(p.threads) && p.threads.includes(th.id));
      if (!to) continue;
      els.thread.textContent = `${th.title} → ${to.name}`;
      els.thread.setAttribute("aria-label", `Thread: ${th.title}. Next: ${to.name}`);
      els.thread.dataset.target = to.id; els.thread.hidden = false;
      break;
    }
  }
  function setLine(text) {
    if (text === lineText) return;
    lineText = text;
    if (reduced() || !text) { els.line.textContent = text; els.line.classList.remove("is-swap"); return; }
    els.line.classList.add("is-swap");
    setTimeout(() => { if (lineText === text) { els.line.textContent = text; els.line.classList.remove("is-swap"); } }, 180);
  }
  function updateCaption() {
    const slot = S.next && S.reveal && S.reveal.t0 ? S.next : S.cur || S.next;
    if (!slot || !slot.place || slot.failed) return;
    const t = slot.el.currentTime;
    const caps = slot.place.captions || [];
    let c = caps.find((c) => t >= c.start && t < c.end);
    // between captions, keep the last line up (full strength) until the next one starts
    if (!c) for (const x of caps) if (x.start <= t) c = x;
    setLine(c ? c.text : "");
  }

  // ---------- card <-> note ----------
  // The card folds into a small wall label; the same white sheet travels between the two.
  function foldSheet(from, to, radii, done) {
    if (reduced() || !els.fold.animate) { done(); return; }
    const f = els.fold;
    f.style.display = "block";
    const kf = (r, rad) => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", borderRadius: rad + "px" });
    const a = f.animate([kf(from, radii[0]), kf(to, radii[1])], { duration: 440, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "forwards" });
    a.onfinish = () => {
      done();
      const b = f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
      b.onfinish = () => { f.style.display = "none"; a.cancel(); b.cancel(); };
    };
  }
  function minimizeCard(pan = true) {
    if (!S.cardOpen) return;
    S.cardOpen = false;
    const hadFocus = els.card.contains(document.activeElement);
    const from = els.card.getBoundingClientRect();
    els.note.classList.toggle("is-compact", mqNarrow.matches);
    const to = els.note.getBoundingClientRect();
    els.card.classList.add("is-min");
    els.card.setAttribute("aria-hidden", "true");
    els.card.inert = true;
    els.noteOpen.setAttribute("aria-expanded", "false");
    foldSheet(from, to, [16, mqNarrow.matches ? 10 : 8], () => els.note.classList.add("is-on"));
    if (hadFocus) els.noteOpen.focus({ preventScroll: true });
    if (pan && !S.cur && !S.next && !S.userMoved) setView(worldView(), true);
    updateHint();
  }
  function openCard() {
    if (S.cardOpen) return;
    S.cardOpen = true;
    const from = els.note.getBoundingClientRect();
    els.note.classList.remove("is-on");
    els.noteOpen.setAttribute("aria-expanded", "true");
    els.card.inert = false;
    els.card.removeAttribute("aria-hidden");
    // measure the card where it will land (its closed transform is only a small offset)
    const cr = els.card.getBoundingClientRect();
    const to = { left: (S.W - cr.width) / 2, top: (S.H - cr.height) / 2, width: cr.width, height: cr.height };
    foldSheet(from, to, [8, 16], () => els.card.classList.remove("is-min"));
    els.card.focus({ preventScroll: true });
    if (!S.cur && !S.next) { S.userMoved = false; setView(cardView(), true); }
    updateHint();
  }
  els.note.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    if (els.note.classList.contains("is-compact")) { els.note.classList.remove("is-compact"); return; }
    openCard();
  });
  function updateHint() {
    els.hint.textContent = mqCoarse.matches ? "Press and drag across the map." : "Move across the map. Click a place to watch.";
    els.hint.classList.toggle("is-on", !S.cardOpen && !S.cur && !S.next && !S.closing && !S.started);
  }

  // ---------- input ----------
  function onDown(e) {
    const t = e.pointerType || "mouse";
    S.pointer = { x: e.clientX, y: e.clientY, inside: true, type: t };
    S.lastMove = performance.now();
    S.down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, type: t };
    try { els.stage.setPointerCapture(e.pointerId); } catch (_) {}
    if (mqNarrow.matches && !S.cardOpen) els.note.classList.add("is-compact");
    if (t !== "mouse") { S.hole.hideAt = 0; if (S.hole.r < 1) { S.hole.x = e.clientX; S.hole.y = e.clientY; } }
  }
  function onMove(e) {
    const t = e.pointerType || "mouse";
    S.pointer = { x: e.clientX, y: e.clientY, inside: true, type: t };
    S.lastMove = performance.now();
    const d = S.down;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
    if (d.moved && S.cardOpen) minimizeCard(false);
    // Mouse drag pans the bare map; a touch drag moves the lens (the map pans at the edges).
    if (d.moved && t === "mouse" && !playing() && !S.closing) {
      S.anim = null; S.userMoved = true;
      panBy(e.clientX - d.lx, e.clientY - d.ly);
    }
    d.lx = e.clientX; d.ly = e.clientY;
  }
  function panBy(dx, dy) {
    const v = S.view, half = S.H / 2 / v.s;
    S.view = { ...v, c: wrap180(v.c - dx / v.s), y: clamp(v.y + dy / v.s, -YM_MAX + half, Math.max(-YM_MAX + half, YM_MAX - half)) };
    S.mapDirty = true;
  }
  function onUp(e) {
    const d = S.down; S.down = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.type !== "mouse") S.hole.hideAt = performance.now() + 900;
    if (d.moved && d.type === "mouse") return;
    tap(e.clientX, e.clientY);
  }
  function tap(x, y) {
    const hit = pickAt(x, y);
    if (hit) { select(hit.place, x, y, { fromLens: true }); return; }
    if (S.cardOpen) minimizeCard(true);
  }

  els.stage.addEventListener("pointerdown", onDown);
  els.stage.addEventListener("pointermove", onMove);
  els.stage.addEventListener("pointerup", onUp);
  els.stage.addEventListener("pointercancel", () => { S.down = null; S.hole.hideAt = performance.now() + 600; });
  els.stage.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") S.pointer.inside = false; });
  document.addEventListener("mouseleave", () => { S.pointer.inside = false; });
  els.close.addEventListener("click", closeVideo);
  els.prev.addEventListener("click", () => flip(-1));
  els.next.addEventListener("click", () => flip(1));
  els.thread.addEventListener("click", () => go(S.places.find((p) => p.id === els.thread.dataset.target)));
  els.call.addEventListener("click", () => go(placeById(els.call.dataset.target)));
  els.glint.addEventListener("click", playFinale);
  els.mute.addEventListener("click", () => {
    S.muted = !S.muted;
    try { localStorage.setItem("atlas-sound", S.muted ? "off" : "on"); } catch (_) {}
    for (const s of slots) s.el.muted = S.muted;
    syncSound();
    const s = S.next || S.cur; if (s && s.el.paused) s.el.play().catch(() => {});
  });
  syncSound();
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (S.cardOpen) minimizeCard(true); else if (S.cur || S.next) closeVideo();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && playing()) {
      e.preventDefault(); flip(e.key === "ArrowRight" ? 1 : -1);
    }
  });

  // ---------- frame loop ----------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    if (W === S.W && H === S.H && dpr === S.dpr) return;
    const first = !S.W;
    S.W = W; S.H = H; S.dpr = dpr;
    mapCv.width = Math.round(W * dpr); mapCv.height = Math.round(H * dpr);
    if (gl) { els.stage.width = mapCv.width; els.stage.height = mapCv.height; }
    else { mapCv.style.width = W + "px"; mapCv.style.height = H + "px"; }
    if (!first && S.raster && !S.userMoved) setView(S.cardOpen && !S.cur ? cardView() : worldView(), false);
    if (!S.cardOpen) els.note.classList.toggle("is-compact", mqNarrow.matches);
    S.mapDirty = true;
  }

  // Decide what the lens surfaces this frame and animate the swap.
  function stepSurface(now, dt, lensOn) {
    const sf = S.surf, H = S.hole;
    let hit = lensOn && S.places.length ? pickAt(H.x, H.y) : null;
    const cur = sf.cur;
    // hysteresis: keep the current place unless the new one is clearly closer
    if (hit && cur && hit.place !== cur.place) {
      const q = screenOf(cur.place, H.x), dc = Math.hypot(q.x - H.x, q.y - H.y);
      const reach = playing() ? lensR() * 0.85 : lensR() * 2.6;
      if (dc < reach && dc < hit.d + 12) hit = { place: cur.place, d: dc, str: playing() ? 1 : 1 - smooth(lensR() * 1.6, reach, dc) };
    }
    if (hit && (!cur || hit.place !== cur.place)) {
      const pt = posterTex(hit.place);
      if (pt) {
        const vt = cur ? 1 - cur.vt : 0;
        sf.old = cur && cur.alpha > 0.02 ? cur : null;
        sf.cur = { place: hit.place, vt, vidMix: 0, vidOn: false, fade: 0, str: hit.str, alpha: 0, pt };
        sf.t0 = now;
        wantPreview(hit.place);
      }
    }
    const c = sf.cur;
    if (c) {
      const on = !!hit && hit.place === c.place;
      if (on) c.str = hit.str;
      c.fade = reduced() ? (on ? 1 : 0) : approach(c.fade, on ? 1 : 0, dt, on ? 90 : 140);
      c.alpha = c.fade * c.str * (c.pt.ready ? 1 : 0);
      if (!on && c.fade < 0.01) { sf.cur = null; sf.old = null; restPreview(); }
    }
    const hot = sf.cur && sf.cur.alpha > 0.2 ? sf.cur.place : null;
    if (hot !== S.hot) { S.hot = hot; S.mapDirty = true; }
    // live frames from the preview video
    const pc = sf.cur, el = preview.el;
    if (gl && pc && preview.place === pc.place && el.readyState >= 2 && el.videoWidth) {
      if (el.currentTime !== preview.lastT) {
        try { upload(vidTex[pc.vt], el); preview.frames++; } catch (_) {}
        preview.lastT = el.currentTime;
        if (preview.frames >= 2) pc.vidOn = true;
      }
    }
    for (const s of [sf.cur, sf.old]) if (s) s.vidMix = reduced() ? (s.vidOn ? 1 : 0) : approach(s.vidMix, s.vidOn ? 1 : 0, dt, 160);
    const sp = reduced() ? 1 : clamp((now - sf.t0) / 700, 0, 1);
    if (sp >= 1) sf.old = null;
    return sp;
  }

  function updateLabel(lensOn) {
    const c = S.surf.cur, H = S.hole;
    const show = gl ? lensOn && c && c.alpha > 0.25 : null;
    let place = show ? c.place : null, x = H.x, y = H.y + H.r + 14;
    if (!gl) { // 2D fallback: label the nearest place under a plain cursor
      const hit = S.pointer.inside && S.pointer.type === "mouse" && !playing() ? pickAt(S.pointer.x, S.pointer.y) : null;
      if (hit && hit.d < 48) { place = hit.place; const q = screenOf(place, S.pointer.x); x = q.x; y = q.y + 14; }
    }
    if (place) {
      if (els.tip.dataset.id !== place.id) {
        els.tip.dataset.id = place.id;
        const span = document.createElement("span");
        span.textContent = place.name;
        const local = fmtLocal(place.localTime);
        if (local) { const sm = document.createElement("small"); sm.textContent = local; span.append(sm); }
        els.tip.replaceChildren(span);
      }
      if (y > S.H - 28) y = H.y - H.r - 26;
      els.tip.style.transform = `translate(${clamp(x, 60, S.W - 60)}px, ${y}px)`;
      els.tip.classList.add("is-on");
    } else els.tip.classList.remove("is-on");
    els.stage.style.cursor = place && S.pointer.type === "mouse" ? "pointer" : "";
  }

  function preloadNear(x, y) {
    const list = S.places.map((p) => { const q = screenOf(p, x); return [Math.hypot(q.x - x, q.y - y), p]; }).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(3, list.length); i++) posterTex(list[i][1]) || posterFor(list[i][1]);
  }

  let lastPreload = { x: -1e4, y: -1e4 };
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(64, now - S.lastT); S.lastT = now;
    const motion = !reduced();
    stepView(now);

    // video uploads (only when a new frame is available) + reveal start
    for (const slot of [S.cur, S.next, S.closing && S.closing.slot]) {
      if (!slot || !slot.place || slot.tainted) continue;
      const el = slot.el;
      if (slot.videoReady && el.readyState >= 2 && el.videoWidth) {
        if (gl) {
          if (el.currentTime !== slot.lastT) {
            try { upload(slot.tex, el); } catch (_) { slot.tainted = true; continue; }
            slot.lastT = el.currentTime;
          }
        } else el.classList.add("is-on");
        slot.asp = el.videoWidth / el.videoHeight; slot.hasContent = true;
      }
    }
    if (S.next && !S.next.hasContent && S.next.posterReady && now - S.next.loadT > 900) S.next.hasContent = true;
    if (S.next && S.next.hasContent && S.reveal && !S.reveal.t0) {
      S.reveal.t0 = now;
      if (S.reveal.panel) { showPanel(S.reveal.panel); S.reveal.panel = null; }
    }
    let revealR = 0, revealE = 0;
    if (S.reveal && S.reveal.t0) {
      const t = motion ? clamp((now - S.reveal.t0) / WIPE_MS, 0, 1) : 1;
      revealE = t < 1 ? 1 - Math.pow(1 - t, 2.2) : 1;
      revealR = S.reveal.r0 + revealE * (S.reveal.rMax - S.reveal.r0);
      if (t >= 1) {
        if (S.cur && S.cur !== S.next) unloadSlot(S.cur);
        S.cur = S.next; S.next = null; S.reveal = null;
        if (S.panAfterReveal) { S.panAfterReveal = false; setView(worldView(), true); }
      }
    }
    let closeR = 0;
    if (S.closing) {
      const t = clamp((now - S.closing.t0) / 900, 0, 1);
      closeR = (1 - easeInOut(t)) * S.closing.rMax;
      if (t >= 1) finishClose();
    }

    // lens
    const H = S.hole, P = S.pointer, film = playing();
    const touchHeld = P.type !== "mouse" && (S.down || now < H.hideAt);
    const lensOn = !S.closing && now >= H.holdUntil && (P.type === "mouse" ? P.inside : touchHeld) && S.places.length > 0;
    // touch: drag near the left/right edge to pan the map under the lens
    if (S.down && S.down.type !== "mouse" && S.down.moved) {
      const m = 44, ex = P.x < m ? (m - P.x) / m : P.x > S.W - m ? -(P.x - (S.W - m)) / m : 0;
      if (ex) { S.anim = null; S.userMoved = true; panBy(ex * 7 * dt / 16, 0); }
    }
    const k = motion ? 1 - Math.exp(-dt / 70) : 1;
    const px = H.x, py = H.y;
    if (P.inside || touchHeld) { H.x += (P.x - H.x) * k; H.y += (P.y - H.y) * k; }
    const sp = gl ? stepSurface(now, dt, lensOn) : 1;
    // During a film the lens rests as a faint ring after 1.5s of stillness, and swells a
    // little when a place is within reach ("click jumps here").
    const still = film && P.type === "mouse" && now - S.lastMove > 1500;
    H.idle = motion ? approach(H.idle, still ? 1 : 0, dt, still ? 260 : 60) : (still ? 1 : 0);
    const snap = film && S.surf.cur && S.surf.cur.fade > 0.5 ? 1 : 0;
    H.swell = motion ? approach(H.swell, snap, dt, 120) : snap;
    const R0 = lensR() * (1 + 0.15 * H.swell) * (1 - 0.35 * H.idle);
    H.r = motion ? approach(H.r, lensOn ? R0 : 0, dt, 110) : (lensOn ? R0 : 0);
    if (H.r < 0.5 && !lensOn) H.r = 0;
    const vk = 1 - Math.exp(-dt / 90);
    H.vx += ((H.x - px) / Math.max(dt, 1) * 16 - H.vx) * vk;
    H.vy += ((H.y - py) / Math.max(dt, 1) * 16 - H.vy) * vk;
    if (lensOn && Math.hypot(H.x - lastPreload.x, H.y - lastPreload.y) > 40) { lastPreload = { x: H.x, y: H.y }; preloadNear(H.x, H.y); }

    if (S.ripple && (now - S.ripple.t0) > 1800) S.ripple = null;
    // memory: a film counts as watched past 60%; earned lines draw when the map is in view
    const cs = S.cur;
    if (cs && cs.place && cs.place.id !== FINALE_ID && !S.closing) {
      const dur = cs.el.duration || cs.place.durationS;
      if (dur && cs.el.currentTime / dur >= 0.6) markWatched(cs.place);
      const call = callOf(cs.place), t = cs.el.currentTime;
      els.call.classList.toggle("is-on", !!call && !S.next && t >= call.win.start && t < call.win.end);
    }
    if (!film && !S.closing && S.edges.length) startLineAnims(now);
    stepLineAnims(now);
    if (S.lineAnims.size || S.route) S.mapDirty = true;
    stepGlint(now);
    updateCaption();
    updateLabel(lensOn && H.r > 8 && H.idle < 0.5);

    if (S.mapDirty) {
      drawMap(); S.mapDirty = false;
      if (gl) upload(mapTex, mapCv);
    }
    if (!gl) return;

    const d = S.dpr;
    gl.viewport(0, 0, els.stage.width, els.stage.height);
    gl.uniform2f(U.uRes, els.stage.width, els.stage.height);
    gl.uniform1f(U.uDpr, d);
    gl.uniform1f(U.uTime, motion ? now / 1000 : 0);
    gl.uniform1f(U.uMotion, motion ? 1 : 0);
    let prev = null, next = null, rv = [0, 0, 0], nf = null;
    if (S.closing) { next = S.closing.slot; rv = [S.closing.x, S.closing.y, closeR]; nf = coverFrame(next.asp); }
    else {
      prev = S.cur && S.cur.hasContent ? S.cur : null;
      if (S.next && S.reveal && S.reveal.t0) {
        next = S.next; rv = [S.reveal.x, S.reveal.y, revealR];
        const full = coverFrame(next.asp), f0 = S.reveal.f0;
        nf = f0 ? { x: f0.x + (full.x - f0.x) * revealE, y: f0.y + (full.y - f0.y) * revealE, h: f0.h * Math.pow(full.h / f0.h, revealE) } : full;
      }
    }
    const pf = prev ? coverFrame(prev.asp) : { x: 0, y: 0, h: 1 };
    if (prev && S.reveal && S.reveal.slide) { pf.x += S.reveal.slide.x * revealE; pf.y += S.reveal.slide.y * revealE; }
    const sf = S.surf, A = sf.old, B = sf.cur;
    const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex || blankTex); };
    bind(0, mapTex);
    bind(1, prev && prev.tex); bind(2, next && next.tex);
    bind(3, A && A.pt.tex); bind(4, A && vidTex[A.vt]);
    bind(5, B && B.pt.tex); bind(6, B && vidTex[B.vt]);
    gl.uniform1f(U.uHasPrev, prev ? 1 : 0);
    gl.uniform1f(U.uHasNext, next ? 1 : 0);
    gl.uniform1f(U.uPrevAsp, prev ? prev.asp : 1);
    gl.uniform1f(U.uNextAsp, next ? next.asp : 1);
    gl.uniform3f(U.uPrevF, pf.x * d, pf.y * d, pf.h * d);
    gl.uniform3f(U.uNextF, nf ? nf.x * d : 0, nf ? nf.y * d : 0, nf ? nf.h * d : 1);
    gl.uniform3f(U.uReveal, rv[0] * d, rv[1] * d, rv[2] * d);
    gl.uniform3f(U.uHole, H.x * d, H.y * d, H.r * d);
    gl.uniform2f(U.uVel, motion ? H.vx * d : 0, motion ? H.vy * d : 0);
    gl.uniform1f(U.uFilm, film ? 1 : 0);
    gl.uniform1f(U.uIdle, H.idle);
    const surfR = film ? H.r * 0.5 : H.r;
    const front = A || sp < 1 ? easeOut(sp) * surfR * 1.35 : 1e5;
    gl.uniform3f(U.uSurf, surfR * d, front * d, motion && sp < 1 ? Math.pow(1 - sp, 1.5) : 0);
    gl.uniform4f(U.uA, A ? A.vidMix : 0, A ? A.pt.asp : 1, A ? A.alpha : 0, 0);
    gl.uniform4f(U.uB, B ? B.vidMix : 0, B ? B.pt.asp : 1, B ? B.alpha : 0, 0);
    if (S.ripple && motion) gl.uniform3f(U.uRipple, S.ripple.x * d, S.ripple.y * d, (now - S.ripple.t0) / 1000);
    else gl.uniform3f(U.uRipple, 0, 0, -1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- boot ----------
  // v2 (when present) is laid over v1 place by place, so a partially published v2 never
  // hides the rest of the world. ?manifest= loads exactly one file (fixtures, tests).
  async function fetchManifest(url) {
    const abs = new URL(url, location.href);
    const res = await fetch(abs);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const m = await res.json();
    const base = new URL(m.cdn || "./", abs).href;
    const places = (Array.isArray(m.places) ? m.places : []).filter((p) => p && p.id && p.video && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => ({ ...p, video: new URL(p.video, base).href, poster: p.poster ? new URL(p.poster, base).href : "" }));
    return { m, base, places };
  }
  async function loadManifest() {
    const ds = document.documentElement.dataset;
    const urls = params.get("manifest") ? [params.get("manifest")] : [ds.manifestV2, ds.manifest].filter(Boolean);
    const got = (await Promise.allSettled(urls.map(fetchManifest))).filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!got.length) throw new Error("no manifest");
    S.manifestBase = got[got.length - 1].base;
    const byId = new Map();
    for (const g of got.slice().reverse()) for (const p of g.places) byId.set(p.id, p); // later (v2) wins
    S.places = [...byId.values()];
    const m = got[0].m, finaleBase = got[0].base;
    S.moment = momentLabel(m.moment);
    if (Array.isArray(m.threads)) for (const t of m.threads) if (t && t.id && t.title) S.threads.set(t.id, t);
    const ids = new Set(S.places.map((p) => p.id));
    S.calls = (Array.isArray(m.calls) ? m.calls : []).filter((c) => c && Array.isArray(c.places) && c.places.length === 2);
    S.featherPath = m.feather && Array.isArray(m.feather.path) ? m.feather.path.filter((id) => typeof id === "string") : [];
    S.finale = m.finale && m.finale.video ? { ...m.finale, video: new URL(m.finale.video, finaleBase).href, poster: m.finale.poster ? new URL(m.finale.poster, finaleBase).href : "" } : null;
    S.edges = buildEdges(ids);
  }

  async function boot() {
    const hasGL = initGL();
    if (hasGL) { for (const s of slots) s.tex = makeTex(); vidTex = [makeTex(), makeTex()]; }
    else {
      document.documentElement.classList.add("no-gl");
      mapCv.id = "stage-2d";
      mapCv.style.cssText = "position:fixed;inset:0;z-index:1;touch-action:none";
      els.stage.replaceWith(mapCv);
      mapCv.addEventListener("pointerdown", onDown);
      mapCv.addEventListener("pointermove", onMove);
      mapCv.addEventListener("pointerup", onUp);
      mapCv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") S.pointer.inside = false; });
      els.stage = mapCv;
    }
    resize();
    window.addEventListener("resize", resize);
    const fontsReady = Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]);
    const [landRes, manRes] = await Promise.allSettled([loadLand(), loadManifest()]);
    if (landRes.status === "rejected") console.warn("atlas: land failed to load", landRes.reason);
    if (manRes.status === "rejected") console.warn("atlas: manifest failed to load", manRes.reason);
    await fontsReady;

    if (params.get("unlock") === "1") { for (const id of S.featherPath) if (placeById(id)) S.watched.add(id); store.set(KEY_W, [...S.watched]); }
    const debugPlace = params.get("place") && S.places.find((p) => p.id === params.get("place"));
    if (params.get("card") === "min" || debugPlace) {
      minimizeCard(false);
      setView(worldView(), false);
    } else if (S.raster) setView(cardView(), false);
    else setView(worldView(), false);
    S.mapDirty = true;
    requestAnimationFrame((t) => { S.lastT = t; frame(t); });
    requestAnimationFrame(() => els.stage.classList.add("is-ready"));
    updateHint();

    if (debugPlace) {
      const q = screenOf(debugPlace, S.W / 2);
      select(debugPlace, q.x, q.y);
    }
    if (params.has("hx")) {
      S.pointer = { x: +params.get("hx") * S.W, y: +(params.get("hy") || 0.5) * S.H, inside: true, type: "mouse" };
      S.hole.x = S.pointer.x; S.hole.y = S.pointer.y; S.lastMove = performance.now();
    }
    // Warm the lens: every poster, a few at a time, once the page is idle.
    if (gl) {
      const queue = S.places.slice();
      const pump = () => { for (let i = 0; i < 3 && queue.length; i++) posterTex(queue.shift()); if (queue.length) setTimeout(pump, 400); };
      setTimeout(pump, 1500);
    }
  }

  // Debug surface for verification scripts.
  window.__atlas = {
    state: S, markWatched, placeById, playFinale, project, unproject, ym, latFromYm, cardView, worldView, screenOf, pickAt, preview, slots,
    cardRect: () => els.card.getBoundingClientRect(),
  };

  mqReduced.addEventListener("change", () => { S.ripple = null; });
  boot();
})();
