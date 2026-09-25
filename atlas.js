// eliotc.com atlas: a quiet world map; each place plays a short film.
// Map: Miller cylindrical (invertible, wraps horizontally). One WebGL canvas composites
// the map (bottom) and the playing video (top); a cursor circle cuts through to the map.
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

  const COLORS = {
    ocean: "#0f0f0e",
    land: "#1f1f1d",
    border: "rgba(15,15,14,0.85)",
    dot: "rgba(239,238,233,0.42)",
    pin: "#efeee9",
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const params = new URLSearchParams(location.search);
  const mqReduced = matchMedia("(prefers-reduced-motion: reduce)");
  const mqCoarse = matchMedia("(pointer: coarse)");
  const $ = (s) => document.querySelector(s);

  const els = {
    stage: $("#stage"), card: $("#card"), chip: $("#chip"), panel: $("#panel"),
    name: $("#p-name"), asof: $("#p-asof"), line: $("#p-line"), sources: $("#p-sources"),
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
    places: [], manifestBase: null,
    pin: null,
    mapDirty: true,
    pointer: { x: -1e4, y: -1e4, inside: false, type: "mouse" },
    down: null,
    hole: { x: 0, y: 0, r: 0, vx: 0, vy: 0, hideAt: 0 },
    ripple: null,             // { x, y, t0 }
    cur: null, next: null,    // video slots
    reveal: null,             // { x, y, t0, rMax }
    closing: null,            // { x, y, t0, rMax, slot }
    muted: true,
    started: false,
    posterCache: new Map(),
    lastT: performance.now(),
  };
  const reduced = () => mqReduced.matches;

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

  // ---------- map canvas ----------
  const mapCv = document.createElement("canvas");
  const mctx = mapCv.getContext("2d");
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
    const period = 360 * v.s;
    mctx.fillStyle = COLORS.dot;
    for (const p of S.places) {
      if (S.pin && p.id === S.pin.id) continue;
      const q = project(p.lng, p.lat);
      for (let x = q.x - period * Math.ceil(q.x / period); x < W + 4; x += period) {
        if (x < -4) continue;
        mctx.beginPath(); mctx.arc(x, q.y, 1.8, 0, Math.PI * 2); mctx.fill();
      }
    }
    if (S.pin) {
      const q = project(S.pin.lng, S.pin.lat);
      for (let x = q.x - period * Math.ceil(q.x / period); x < W + 12; x += period) {
        if (x < -12) continue;
        mctx.fillStyle = COLORS.pin;
        mctx.beginPath(); mctx.arc(x, q.y, 3.5, 0, Math.PI * 2); mctx.fill();
        mctx.strokeStyle = "rgba(239,238,233,0.45)"; mctx.lineWidth = 1;
        mctx.beginPath(); mctx.arc(x, q.y, 9, 0, Math.PI * 2); mctx.stroke();
      }
    }
  }

  // ---------- WebGL ----------
  const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;
  const FS = `
precision highp float;
uniform sampler2D uMap, uPrev, uNext;
uniform vec2 uRes;
uniform float uDpr, uTime, uMotion, uPrevAsp, uNextAsp, uHasPrev, uHasNext;
uniform vec3 uReveal, uHole, uRipple;
uniform vec2 uVel;
vec2 cover(vec2 uv, float asp) {
  float A = uRes.x / uRes.y;
  vec2 s = A > asp ? vec2(1.0, asp / A) : vec2(A / asp, 1.0);
  return (uv - 0.5) * s + 0.5;
}
float wob(vec2 d, float t, float amp) {
  float a = atan(d.y, d.x);
  return amp * (0.5 * sin(3.0 * a + 1.1 * t) + 0.3 * sin(5.0 * a - 1.7 * t + 1.3) + 0.2 * sin(9.0 * a + 2.3 * t + 4.0));
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = p / uRes;
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
  vec2 muv = uv + disp / uRes;

  // cursor hole with a water-like, velocity-driven edge
  float holeM = 0.0, rim = 0.0, hs = 1e4;
  vec2 hn = vec2(0.0);
  if (uHole.z > 0.5) {
    vec2 hd = p - uHole.xy; float hr = length(hd); hn = hd / max(hr, 1.0);
    float vm = length(uVel);
    float amp = (2.0 * uDpr + min(vm * 0.45, 16.0 * uDpr)) * uMotion;
    float bulge = vm > 0.01 ? dot(hn, uVel / vm) * min(vm * 0.6, 20.0 * uDpr) * uMotion : 0.0;
    hs = hr - (uHole.z + wob(hd, uTime * 1.7, amp) + bulge);
    holeM = 1.0 - smoothstep(-f, f, hs);
    rim = smoothstep(-30.0 * uDpr, 0.0, hs) * holeM;
  }
  vec3 mapC = texture2D(uMap, muv).rgb;
  vec3 mapL = texture2D(uMap, muv - hn * rim * rim * 14.0 * uDpr / uRes).rgb;

  vec3 top = uHasPrev > 0.5 ? texture2D(uPrev, cover(muv, uPrevAsp)).rgb : mapC;
  if (uHasNext > 0.5) {
    vec2 rd = p - uReveal.xy;
    float rs = length(rd) - (uReveal.z + wob(rd, uTime * 1.3, 6.0 * uDpr * uMotion));
    float rm = 1.0 - smoothstep(-1.5 * f, 1.5 * f, rs);
    vec3 nx = texture2D(uNext, cover(muv, uNextAsp)).rgb;
    float edge = exp(-(rs * rs) / (2.0 * pow(3.0 * uDpr, 2.0))) * step(1.0, uReveal.z);
    top = mix(top, nx, rm) + edge * 0.06;
  }
  float shade = uHole.z > 0.5 ? (1.0 - smoothstep(0.0, 22.0 * uDpr, hs)) * (1.0 - holeM) : 0.0;
  top *= 1.0 - 0.3 * shade;
  vec3 col = mix(top, mapL, holeM);
  col += (uHole.z > 0.5 ? exp(-(hs * hs) / (2.0 * pow(1.1 * uDpr, 2.0))) : 0.0) * 0.12;
  col += glow * 0.03;
  gl_FragColor = vec4(col, 1.0);
}`;

  let gl = null, prog = null, U = {}, mapTex = null;
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
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.warn("atlas: WebGL shader failed, using 2D fallback", e); gl = null; return false; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["uMap", "uPrev", "uNext", "uRes", "uDpr", "uTime", "uMotion", "uPrevAsp", "uNextAsp", "uHasPrev", "uHasNext", "uReveal", "uHole", "uRipple", "uVel"]) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uMap, 0); gl.uniform1i(U.uPrev, 1); gl.uniform1i(U.uNext, 2);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    mapTex = makeTex();
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

  // ---------- video slots ----------
  const slots = [...document.querySelectorAll(".videos video")].map((el) => ({ el, tex: null, asp: 16 / 9, place: null, hasContent: false, tainted: false, failed: false }));
  const assetURL = (rel) => new URL(rel, S.manifestBase).href;

  function loadSlot(slot, place, autoplay) {
    if (slot.place && slot.place.id === place.id && slot.el.getAttribute("src")) {
      if (autoplay) slot.el.play().catch(() => {});
      return;
    }
    slot.place = place; slot.hasContent = false; slot.tainted = false; slot.failed = false;
    const el = slot.el;
    el.crossOrigin = "anonymous";
    el.muted = S.muted;
    el.preload = "auto";
    el.src = assetURL(place.video);
    if (autoplay) el.play().catch(() => {});
    const img = posterFor(place);
    const usePoster = () => {
      if (slot.place !== place || slot.hasContent || !img.naturalWidth) return;
      if (gl) { try { upload(slot.tex, img); } catch (_) { return; } }
      slot.asp = img.naturalWidth / img.naturalHeight; slot.hasContent = true;
    };
    if (img.complete) usePoster(); else img.addEventListener("load", usePoster, { once: true });
  }
  function unloadSlot(slot) {
    slot.el.pause();
    slot.el.removeAttribute("src");
    slot.el.load();
    slot.el.classList.remove("is-on");
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
  for (const slot of slots) {
    slot.el.addEventListener("error", () => {
      if (!slot.place) return;
      slot.failed = true;
      if (slot === S.next || slot === S.cur) els.line.textContent = "This film is not available right now.";
    });
  }
  const otherSlot = (slot) => (slot === slots[0] ? slots[1] : slots[0]);

  // ---------- selection ----------
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

  function select(place, x, y) {
    if (!place) return;
    S.started = true;
    if (S.cardOpen) { minimizeCard(false); S.panAfterReveal = !S.userMoved; }
    if (S.closing) { // resume from a close in progress
      S.cur = S.closing.slot; S.closing = null;
    }
    if (S.cur && S.cur.place && S.cur.place.id === place.id && !S.next) {
      S.ripple = reduced() ? null : { x, y, t0: performance.now() };
      return;
    }
    S.pin = place; S.mapDirty = true;
    S.ripple = reduced() ? null : { x, y, t0: performance.now() };
    const slot = S.next || (S.cur ? otherSlot(S.cur) : slots[0]);
    loadSlot(slot, place, true);
    S.next = slot;
    S.reveal = { x, y, t0: 0, rMax: Math.hypot(Math.max(x, S.W - x), Math.max(y, S.H - y)) + 80 };
    showPanel(place);
    document.body.classList.add("is-playing");
    updateHint();
  }

  function closeVideo() {
    if (!S.cur && !S.next) return;
    if (S.next) { unloadSlot(S.next); S.next = null; S.reveal = null; }
    if (!S.cur) { finishClose(); return; }
    const q = S.pin ? project(S.pin.lng, S.pin.lat) : { x: S.W / 2, y: S.H / 2 };
    const x = clamp(nearestCopyX(q.x, S.W / 2, S.view.s), 0, S.W), y = clamp(q.y, 0, S.H);
    S.closing = { slot: S.cur, x, y, t0: performance.now(), rMax: Math.hypot(Math.max(x, S.W - x), Math.max(y, S.H - y)) + 80 };
    S.cur = null;
    document.body.classList.remove("is-playing");
    if (reduced()) finishClose();
  }
  function finishClose() {
    if (S.closing) unloadSlot(S.closing.slot);
    S.closing = null;
    S.pin = null; S.mapDirty = true;
    document.body.classList.remove("is-playing");
    if (S.panAfterReveal) { S.panAfterReveal = false; setView(worldView(), true); }
    updateHint();
  }

  // ---------- panel / captions ----------
  function fmtDate(iso) {
    const [y, m, d] = (iso || "").split("-").map(Number);
    return y && m && d ? `as of ${MONTHS[m - 1]} ${d}, ${y}` : "";
  }
  let lineText = null;
  function showPanel(place) {
    els.name.textContent = place.country && place.country !== place.name ? `${place.name}, ${place.country}` : place.name;
    els.asof.textContent = fmtDate(place.asOf);
    setLine("");
    els.sources.replaceChildren(...(place.sources || []).slice(0, 4).map((s) => {
      const a = document.createElement("a");
      a.href = s.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = s.outlet || new URL(s.url).hostname.replace(/^www\./, "");
      if (s.title) a.title = s.title;
      return a;
    }));
  }
  function setLine(text) {
    if (text === lineText) return;
    lineText = text;
    if (reduced() || !text) { els.line.textContent = text; els.line.classList.remove("is-swap"); return; }
    els.line.classList.add("is-swap");
    setTimeout(() => { if (lineText === text) { els.line.textContent = text; els.line.classList.remove("is-swap"); } }, 180);
  }
  function updateCaption() {
    const slot = S.next || S.cur;
    if (!slot || !slot.place || slot.failed) return;
    const t = slot.el.currentTime;
    const c = (slot.place.captions || []).find((c) => t >= c.start && t < c.end);
    setLine(c ? c.text : "");
  }

  // ---------- card ----------
  function minimizeCard(pan = true) {
    if (!S.cardOpen) return;
    S.cardOpen = false;
    const hadFocus = els.card.contains(document.activeElement);
    els.card.classList.add("is-min");
    els.card.setAttribute("aria-hidden", "true");
    els.card.inert = true;
    els.chip.classList.add("is-on");
    els.chip.setAttribute("aria-expanded", "false");
    if (hadFocus) els.chip.focus({ preventScroll: true });
    if (pan && !S.cur && !S.next && !S.userMoved) setView(worldView(), true);
    updateHint();
  }
  function openCard() {
    if (S.cardOpen) return;
    S.cardOpen = true;
    els.card.inert = false;
    els.card.removeAttribute("aria-hidden");
    els.card.classList.remove("is-min");
    els.chip.classList.remove("is-on");
    els.chip.setAttribute("aria-expanded", "true");
    els.card.focus({ preventScroll: true });
    if (!S.cur && !S.next) { S.userMoved = false; setView(cardView(), true); }
    updateHint();
  }
  function updateHint() {
    els.hint.textContent = mqCoarse.matches ? "Tap any place on the map. Drag to look around." : "Choose any place on the map.";
    els.hint.classList.toggle("is-on", !S.cardOpen && !S.cur && !S.next && !S.closing && !S.started);
  }

  // ---------- input ----------
  function onDown(e) {
    const t = e.pointerType || "mouse";
    S.pointer = { x: e.clientX, y: e.clientY, inside: true, type: t };
    S.down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, type: t };
    try { els.stage.setPointerCapture(e.pointerId); } catch (_) {}
    if (t !== "mouse") { S.hole.hideAt = 0; if (S.hole.r < 1) { S.hole.x = e.clientX; S.hole.y = e.clientY; } }
    // Start fetching the likely pick before the tap resolves.
    if (!S.cur && !S.next && S.places.length) {
      const g = unproject(e.clientX, e.clientY);
      const p = nearestPlace(g.lng, g.lat);
      if (p) posterFor(p);
    }
  }
  function onMove(e) {
    const t = e.pointerType || "mouse";
    S.pointer = { x: e.clientX, y: e.clientY, inside: true, type: t };
    const d = S.down;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
    if (d.moved && !S.cur && !S.next && !S.closing) {
      if (S.cardOpen) minimizeCard(false);
      S.anim = null; S.userMoved = true;
      const v = S.view;
      const half = S.H / 2 / v.s;
      S.view = {
        ...v,
        c: wrap180(v.c - (e.clientX - d.lx) / v.s),
        y: clamp(v.y + (e.clientY - d.ly) / v.s, -YM_MAX + half, Math.max(-YM_MAX + half, YM_MAX - half)),
      };
      S.mapDirty = true;
    }
    d.lx = e.clientX; d.ly = e.clientY;
  }
  function onUp(e) {
    const d = S.down; S.down = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.type !== "mouse") S.hole.hideAt = performance.now() + 1400;
    if (d.moved) return;
    tap(e.clientX, e.clientY, d.type);
  }
  function tap(x, y, type) {
    if (S.cur && !S.cardOpen && type === "mouse") {
      // With a film playing, only a click inside the reveal picks a new place.
      if (Math.hypot(x - S.hole.x, y - S.hole.y) > S.hole.r + 8 || S.hole.r < 24) return;
    }
    const g = unproject(x, y);
    select(nearestPlace(g.lng, g.lat), x, y);
  }

  els.stage.addEventListener("pointerdown", onDown);
  els.stage.addEventListener("pointermove", onMove);
  els.stage.addEventListener("pointerup", onUp);
  els.stage.addEventListener("pointercancel", () => { S.down = null; S.hole.hideAt = performance.now() + 600; });
  els.stage.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") S.pointer.inside = false; });
  document.addEventListener("mouseleave", () => { S.pointer.inside = false; });
  els.chip.addEventListener("click", openCard);
  els.close.addEventListener("click", closeVideo);
  els.mute.addEventListener("click", () => {
    S.muted = !S.muted;
    for (const s of slots) s.el.muted = S.muted;
    els.mute.textContent = S.muted ? "Unmute" : "Mute";
    els.mute.setAttribute("aria-pressed", String(!S.muted));
    const s = S.next || S.cur; if (s && s.el.paused) s.el.play().catch(() => {});
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (S.cardOpen) minimizeCard(true); else if (S.cur || S.next) closeVideo();
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
    S.mapDirty = true;
  }

  function updateTip() {
    const p = S.pointer;
    let show = null;
    if (p.inside && p.type === "mouse" && !S.down && !S.closing && S.places.length) {
      const inHole = !!S.cur;
      if (!inHole || S.hole.r > 24) {
        const g = unproject(p.x, p.y), near = nearestPlace(g.lng, g.lat);
        if (near) {
          const q = project(near.lng, near.lat);
          const x = nearestCopyX(q.x, p.x, S.view.s);
          const d = Math.hypot(x - p.x, q.y - p.y);
          if (d < 140) posterFor(near);
          const within = inHole ? Math.hypot(x - S.hole.x, q.y - S.hole.y) < S.hole.r - 12 : d < 48;
          if (within && !(S.pin && S.pin.id === near.id && (S.cur || S.next))) show = { near, x, y: q.y };
        }
      }
    }
    if (show) {
      if (els.tip.dataset.id !== show.near.id) {
        els.tip.dataset.id = show.near.id;
        const span = document.createElement("span");
        span.textContent = show.near.name;
        if (show.near.country && show.near.country !== show.near.name) {
          const sm = document.createElement("small"); sm.textContent = show.near.country; span.append(sm);
        }
        els.tip.replaceChildren(span);
      }
      els.tip.style.transform = `translate(${show.x}px, ${show.y}px)`;
      els.tip.classList.add("is-on");
      els.stage.style.cursor = "pointer";
    } else {
      els.tip.classList.remove("is-on");
      els.stage.style.cursor = "";
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(64, now - S.lastT); S.lastT = now;
    const motion = !reduced();
    stepView(now);

    // video uploads + reveal start
    for (const slot of [S.cur, S.next, S.closing && S.closing.slot]) {
      if (!slot || !slot.place || slot.tainted) continue;
      const el = slot.el;
      if (el.readyState >= 2 && el.videoWidth) {
        if (gl) {
          try { upload(slot.tex, el); } catch (_) { slot.tainted = true; continue; }
        } else el.classList.add("is-on");
        slot.asp = el.videoWidth / el.videoHeight; slot.hasContent = true;
      }
    }
    if (S.next && S.next.hasContent && S.reveal && !S.reveal.t0) S.reveal.t0 = now;
    let revealR = 0;
    if (S.reveal && S.reveal.t0) {
      const t = motion ? clamp((now - S.reveal.t0) / 1150, 0, 1) : 1;
      revealR = easeOut(t) * S.reveal.rMax;
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

    // hole
    const H = S.hole, P = S.pointer;
    const touchHeld = P.type !== "mouse" && (S.down || now < H.hideAt);
    const want = S.cur && !S.closing && (P.type === "mouse" ? P.inside : touchHeld);
    const R0 = (S.W < 560 ? 88 : 128);
    const k = motion ? 1 - Math.exp(-dt / 70) : 1;
    const px = H.x, py = H.y;
    if (P.inside || touchHeld) { H.x += (P.x - H.x) * k; H.y += (P.y - H.y) * k; }
    H.r += ((want ? R0 : 0) - H.r) * (motion ? 1 - Math.exp(-dt / 110) : 1);
    if (H.r < 0.5 && !want) H.r = 0;
    const vk = 1 - Math.exp(-dt / 90);
    H.vx += ((H.x - px) / Math.max(dt, 1) * 16 - H.vx) * vk;
    H.vy += ((H.y - py) / Math.max(dt, 1) * 16 - H.vy) * vk;

    if (S.ripple && (now - S.ripple.t0) > 1800) S.ripple = null;
    updateCaption();
    updateTip();

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
    let prev = null, next = null, rv = [0, 0, 0];
    if (S.closing) { next = S.closing.slot; rv = [S.closing.x, S.closing.y, closeR]; }
    else {
      prev = S.cur && S.cur.hasContent ? S.cur : null;
      if (S.next && S.reveal && S.reveal.t0) { next = S.next; rv = [S.reveal.x, S.reveal.y, revealR]; }
    }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, prev ? prev.tex : mapTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, next ? next.tex : mapTex);
    gl.uniform1f(U.uHasPrev, prev ? 1 : 0);
    gl.uniform1f(U.uHasNext, next ? 1 : 0);
    gl.uniform1f(U.uPrevAsp, prev ? prev.asp : 1);
    gl.uniform1f(U.uNextAsp, next ? next.asp : 1);
    gl.uniform3f(U.uReveal, rv[0] * d, rv[1] * d, rv[2] * d);
    gl.uniform3f(U.uHole, H.x * d, H.y * d, prev ? H.r * d : 0);
    gl.uniform2f(U.uVel, motion ? H.vx * d : 0, motion ? H.vy * d : 0);
    if (S.ripple && motion) gl.uniform3f(U.uRipple, S.ripple.x * d, S.ripple.y * d, (now - S.ripple.t0) / 1000);
    else gl.uniform3f(U.uRipple, 0, 0, -1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- boot ----------
  async function loadManifest() {
    const url = params.get("manifest") || document.documentElement.dataset.manifest;
    const abs = new URL(url, location.href);
    const res = await fetch(abs);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const m = await res.json();
    S.manifestBase = new URL(m.cdn || "./", abs).href;
    S.places = (m.places || []).filter((p) => p && p.video && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }

  async function boot() {
    const hasGL = initGL();
    if (hasGL) for (const s of slots) s.tex = makeTex();
    else {
      document.documentElement.classList.add("no-gl");
      mapCv.id = "stage-2d";
      mapCv.style.cssText = "position:fixed;inset:0;z-index:1;touch-action:none";
      els.stage.replaceWith(mapCv);
      mapCv.addEventListener("pointerdown", onDown);
      mapCv.addEventListener("pointermove", onMove);
      mapCv.addEventListener("pointerup", onUp);
      els.stage = mapCv;
    }
    resize();
    window.addEventListener("resize", resize);
    const fontsReady = Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]);
    const [landRes, manRes] = await Promise.allSettled([loadLand(), loadManifest()]);
    if (landRes.status === "rejected") console.warn("atlas: land failed to load", landRes.reason);
    if (manRes.status === "rejected") console.warn("atlas: manifest failed to load", manRes.reason);
    await fontsReady;

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
      const q = project(debugPlace.lng, debugPlace.lat);
      select(debugPlace, nearestCopyX(q.x, S.W / 2, S.view.s), q.y);
    }
    if (params.has("hx")) {
      S.pointer = { x: +params.get("hx") * S.W, y: +(params.get("hy") || 0.5) * S.H, inside: true, type: "mouse" };
      S.hole.x = S.pointer.x; S.hole.y = S.pointer.y;
    }
  }

  // Debug surface for verification scripts.
  window.__atlas = {
    state: S, project, unproject, ym, latFromYm, cardView, worldView,
    cardRect: () => els.card.getBoundingClientRect(),
  };

  mqReduced.addEventListener("change", () => { S.ripple = null; });
  boot();
})();
