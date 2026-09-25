// One-off: simplify Natural Earth 50m countries into data/land.json.
// Usage: node tools/build-land.mjs <ne_50m_countries.geojson>
// Output: { q, polys: [[dx,dy,...] per outer ring (delta-encoded, x=lng*q, y=lat*q)] }
// Holes are dropped (in admin-0 they are enclaves filled by the neighbouring country),
// and specks under MIN_AREA square degrees are dropped to keep the map quiet.
import fs from "node:fs";
const src = process.argv[2];
const TOL = 0.035, MIN_AREA = 0.35, Q = 100;
const gj = JSON.parse(fs.readFileSync(src, "utf8"));
function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); };
const polys = []; let pts = 0;
for (const f of gj.features) {
  const g = f.geometry; if (!g) continue;
  const list = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of list) {
    let outer = poly[0];
    // Rings that touch both +180 and -180 are unwrapped into one continuous run (lng may exceed 180).
    const lngs = outer.map((c) => c[0]);
    if (Math.max(...lngs) - Math.min(...lngs) > 180) outer = outer.map(([x, y]) => [x < 0 ? x + 360 : x, y]);
    if (area(outer) < MIN_AREA) continue;
    // Split the closed ring at its farthest point so Douglas-Peucker has a real baseline.
    let k = 0, kd = -1; for (let i = 1; i < outer.length; i++) { const d = Math.hypot(outer[i][0] - outer[0][0], outer[i][1] - outer[0][1]); if (d > kd) { kd = d; k = i; } }
    let r = dp(outer.slice(0, k + 1), TOL).concat(dp(outer.slice(k), TOL).slice(1));
    if (r.length < 4) continue;
    if (r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]) r = r.slice(0, -1);
    const flat = []; let px = 0, py = 0;
    for (const [x, y] of r) { const qx = Math.round(x * Q), qy = Math.round(y * Q); flat.push(qx - px, qy - py); px = qx; py = qy; }
    polys.push(flat); pts += r.length;
  }
}
fs.writeFileSync(new URL("../data/land.json", import.meta.url), JSON.stringify({ q: Q, polys }));
console.log(`polys ${polys.length}, points ${pts}, bytes ${fs.statSync(new URL("../data/land.json", import.meta.url)).size}`);
