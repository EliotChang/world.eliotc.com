#!/usr/bin/env python3
"""Validate data/anchors.json (see data/CONTRACT.md) and optionally render a preview.

Checks: JSON shape, sorted + unique kebab ids, required ids, lat/lng ranges and
2-decimal rounding, land points on land (point-in-polygon against Natural Earth
ne_50m countries, ~25 km coastal tolerance), ocean points in water, minimum
spacing between points (~15 km, with an explicit allow-list for twin capitals),
every sovereign country present, and a per-continent / per-kind summary.

Usage:
  python3 data/validate-anchors.py [--geojson PATH] [--preview .review/anchors-preview.png]

Stdlib only; --preview additionally needs Pillow.
"""
import argparse
import json
import math
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_GEOJSON_CANDIDATES = [
    os.path.join(HERE, "ne_50m_countries.geojson"),
    os.path.expanduser("~/Local/Github/Figment/sonder.gg/public/data/ne_50m_countries.geojson"),
]

KINDS = {"country", "region", "city", "ocean"}
REQUIRED_IDS = ["jp-tokyo", "ng-lagos", "br-sao-paulo", "fr-paris", "in-mumbai",
                "mx-mexico-city", "eg-cairo", "kr-seoul", "ar-buenos-aires", "is-reykjavik"]
COAST_TOLERANCE_KM = 25.0
MIN_SPACING_KM = 15.0
# Capitals that physically sit next to each other; both points are intentional.
SPACING_ALLOW = {frozenset(["it-rome", "va-vatican-city"]),
                 frozenset(["cd-kinshasa", "cg-congo"])}
# Sovereign states with no polygon in ne_50m (too small at that scale).
NO_POLYGON_OK = {"tv"}

# Natural Earth names that are not independent states (or are disputed areas
# folded into a neighbour) - everything else in the file must be covered.
NE_NON_SOVEREIGN = {
    "American Samoa", "Anguilla", "Aruba", "Ashmore and Cartier Is.", "Bermuda",
    "Br. Indian Ocean Ter.", "British Virgin Is.", "Cayman Is.", "Cook Is.", "Curaçao",
    "Faeroe Is.", "Falkland Is.", "Fr. Polynesia", "Fr. S. Antarctic Lands", "Greenland",
    "Guam", "Guernsey", "Heard I. and McDonald Is.", "Hong Kong", "Indian Ocean Ter.",
    "Isle of Man", "Jersey", "Macao", "Montserrat", "N. Cyprus", "N. Mariana Is.",
    "New Caledonia", "Niue", "Norfolk Island", "Pitcairn Is.", "Puerto Rico",
    "S. Geo. and the Is.", "Saint Helena", "Siachen Glacier", "Sint Maarten", "Somaliland",
    "St-Barthélemy", "St-Martin", "St. Pierre and Miquelon", "Turks and Caicos Is.",
    "U.S. Virgin Is.", "Wallis and Futuna Is.", "Åland", "Antarctica",
}
# Natural Earth name -> display country used in anchors.json (only where they differ).
NE_TO_DISPLAY = {
    "Antigua and Barb.": "Antigua and Barbuda", "Bosnia and Herz.": "Bosnia and Herzegovina",
    "Central African Rep.": "Central African Republic", "Congo": "Congo",
    "Côte d'Ivoire": "Ivory Coast", "Dem. Rep. Congo": "DR Congo",
    "Dominican Rep.": "Dominican Republic", "Eq. Guinea": "Equatorial Guinea",
    "Macedonia": "North Macedonia", "Marshall Is.": "Marshall Islands",
    "S. Sudan": "South Sudan", "Solomon Is.": "Solomon Islands",
    "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "St. Vin. and Gren.": "Saint Vincent and the Grenadines",
    "São Tomé and Principe": "Sao Tome and Principe",
    "United States of America": "United States", "Vatican": "Vatican City",
    "W. Sahara": "Western Sahara", "eSwatini": "Eswatini",
}
EXTRA_SOVEREIGN_DISPLAY = {"Tuvalu"}  # not in ne_50m

CONTINENTS = {
    "Africa": "dz ao bj bw bf bi cv cm cf td km cg cd ci dj eg gq er sz et ga gm gh gn gw ke ls lr ly "
              "mg mw ml mr mu ma mz na ne ng rw st sn sc sl so za ss sd tz tg tn ug eh zm zw",
    "Europe": "al ad at by be ba bg hr cy cz dk ee fo fi fr de gr hu is ie it xk lv li lt lu mt md mc "
              "me nl mk no pl pt ro sm rs sk si es se ch ua gb va",
    "Asia": "af am az bh bd bt bn kh cn ge hk in id ir iq il jp jo kz kw kg la lb mo my mv mn mm np "
            "kp om pk ps ph qa sa sg kr lk sy tw tj th tl tr tm ae uz vn ye",
    "North America": "ag bs bb bz bm ca ky cr cu cw dm do sv gl gd gt ht hn jm mx ni pa pr kn lc vc "
                     "tt tc us vi aw",
    "South America": "ar bo br cl co ec fk gy py pe sr uy ve",
    "Oceania": "au fj ki mh fm nr nz pw pg ws sb to tv vu nc pf gu as ck",
    "Antarctica": "aq",
}
ISO_CONTINENT = {iso: cont for cont, s in CONTINENTS.items() for iso in s.split()}


def continent_of(entry):
    if entry["kind"] == "ocean":
        return "Ocean"
    iso = entry["id"].split("-", 1)[0]
    if iso == "ru":  # Urals split
        return "Asia" if entry["lng"] > 60 else "Europe"
    if iso == "tr" and entry["lng"] < 29.5 and entry["lat"] > 40.5:
        return "Europe"  # Istanbul / Thrace
    if iso == "us" and entry["name"] == "Hawaii":
        return "Oceania"
    return ISO_CONTINENT.get(iso, "?")


# ---------------------------------------------------------------- geometry
def load_polygons(path):
    """Return list of (name, bbox, rings, mode); rings[0] is the outer ring.

    mode "shift": the ring crosses the antimeridian (Russia/Chukotka, Fiji, ...);
    its negative longitudes are shifted by +360 so it is planar, and points are
    tested at lng and lng+360.
    mode "southpolar": Antarctica's coastline ring wraps all longitudes (this
    ne_50m copy stores it as a hole of a degenerate ring at -89.999); land is
    what lies south of it, tested with a northward ray.
    """
    with open(path) as f:
        gj = json.load(f)
    polys = []
    for feat in gj["features"]:
        name = feat["properties"].get("name")
        g = feat["geometry"]
        parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for rings in parts:
            rings = [[(p[0], p[1]) for p in r] for r in rings]
            for r in list(rings):
                ys = [p[1] for p in r]
                if max(ys) - min(ys) < 1e-6:  # degenerate sliver ring
                    rings.remove(r)
            if not rings:
                continue
            xs = [p[0] for r in rings for p in r]
            ys = [p[1] for r in rings for p in r]
            jumps = any(abs(r[i + 1][0] - r[i][0]) > 180 for r in rings for i in range(len(r) - 1))
            if max(ys) < -60 and max(xs) - min(xs) > 350:
                for r in rings:
                    polys.append((name, (-180, -90, 180, max(p[1] for p in r)), [r], "southpolar"))
                continue
            if jumps:
                rings = [[(x + 360 if x < 0 else x, y) for x, y in r] for r in rings]
                xs = [p[0] for r in rings for p in r]
                polys.append((name, (min(xs), min(ys), max(xs), max(ys)), rings, "shift"))
            else:
                xo = [p[0] for p in rings[0]]
                yo = [p[1] for p in rings[0]]
                polys.append((name, (min(xo), min(yo), max(xo), max(yo)), rings, "plain"))
    return polys


def ring_contains(ring, x, y):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def south_of_ring(ring, x, y):
    """Odd number of ring crossings on a ray going north from (x, y)."""
    inside = False
    for i in range(len(ring) - 1):
        (xi, yi), (xj, yj) = ring[i], ring[i + 1]
        if abs(xj - xi) > 180:
            continue
        if (xi > x) != (xj > x):
            if y < (yj - yi) * (x - xi) / (xj - xi) + yi:
                inside = not inside
    return inside


def containing_polygon(polys, lat, lng):
    for name, (x0, y0, x1, y1), rings, mode in polys:
        if mode == "southpolar":
            if lat <= y1 and south_of_ring(rings[0], lng, lat):
                return name
            continue
        for x in ((lng, lng + 360) if mode == "shift" else (lng,)):
            if x0 <= x <= x1 and y0 <= lat <= y1:
                if ring_contains(rings[0], x, lat) and not any(ring_contains(h, x, lat) for h in rings[1:]):
                    return name
    return None


def dist_to_land_km(polys, lat, lng, search_km=200.0):
    """Approximate distance from a point to the nearest polygon edge (local equirectangular)."""
    kx = 111.32 * max(math.cos(math.radians(lat)), 0.01)
    ky = 110.57
    pad_lat = search_km / ky
    pad_lng = min(search_km / kx, 180)
    best = float("inf")
    best_name = None
    for name, (x0, y0, x1, y1), rings, mode in polys:
        for px in ((lng, lng + 360) if mode == "shift" else (lng,)):
            if px < x0 - pad_lng or px > x1 + pad_lng or lat < y0 - pad_lat or lat > y1 + pad_lat:
                continue
            for ring in rings:
                for i in range(len(ring) - 1):
                    if abs(ring[i + 1][0] - ring[i][0]) > 180:
                        continue
                    ax, ay = (ring[i][0] - px) * kx, (ring[i][1] - lat) * ky
                    bx, by = (ring[i + 1][0] - px) * kx, (ring[i + 1][1] - lat) * ky
                    dx, dy = bx - ax, by - ay
                    L = dx * dx + dy * dy
                    t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
                    d = math.hypot(ax + t * dx, ay + t * dy)
                    if d < best:
                        best, best_name = d, name
    return best, best_name


def haversine_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lng"], b["lat"], b["lng"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


# ---------------------------------------------------------------- preview
def render_preview(polys, entries, out_path, width=2400):
    from PIL import Image, ImageDraw

    height = width // 2
    sx, sy = width / 360.0, height / 180.0
    img = Image.new("RGB", (width, height), (18, 24, 33))
    draw = ImageDraw.Draw(img)

    def px(lng, lat):
        return ((lng + 180) * sx, (90 - lat) * sy)

    land, edge, sea = (58, 64, 72), (88, 96, 106), (18, 24, 33)
    for _, _, rings, mode in polys:
        if mode == "southpolar":
            ring = [p for p in rings[0] if abs(p[0]) <= 180]
            draw.polygon([px(x, y) for x, y in ring] + [px(180, -90), px(-180, -90)], fill=land)
            continue
        offsets = (0, -360) if mode == "shift" else (0,)
        for off in offsets:
            draw.polygon([px(x + off, y) for x, y in rings[0]], fill=land, outline=edge)
            for hole in rings[1:]:
                draw.polygon([px(x + off, y) for x, y in hole], fill=sea)
    colors = {"country": (255, 196, 64), "region": (96, 200, 255), "city": (255, 96, 96), "ocean": (120, 255, 170)}
    radius = {"country": 5, "region": 4, "city": 3, "ocean": 6}
    for kind in ["region", "city", "country", "ocean"]:
        for e in entries:
            if e["kind"] != kind:
                continue
            x, y = px(e["lng"], e["lat"])
            r = radius[kind]
            draw.ellipse([x - r, y - r, x + r, y + r], fill=colors[kind], outline=(0, 0, 0))
    ly = 16
    for kind in ["country", "region", "city", "ocean"]:
        n = sum(1 for e in entries if e["kind"] == kind)
        draw.ellipse([16, ly, 28, ly + 12], fill=colors[kind])
        draw.text((36, ly), f"{kind} ({n})", fill=(230, 230, 230))
        ly += 20
    draw.text((16, ly + 4), f"{len(entries)} anchors", fill=(230, 230, 230))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    img.save(out_path)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--anchors", default=os.path.join(HERE, "anchors.json"))
    ap.add_argument("--geojson")
    ap.add_argument("--preview", help="write a PNG preview to this path")
    args = ap.parse_args()

    geo = args.geojson or next((p for p in DEFAULT_GEOJSON_CANDIDATES if os.path.exists(p)), None)
    if not geo:
        sys.exit("ne_50m_countries.geojson not found; pass --geojson")

    errors, warnings = [], []
    with open(args.anchors) as f:
        entries = json.load(f)
    if not isinstance(entries, list):
        sys.exit("anchors.json must be a JSON array")

    # --- shape
    allowed = {"id", "name", "country", "region", "lat", "lng", "kind", "query"}
    id_re = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)+$")
    for i, e in enumerate(entries):
        where = e.get("id", f"#{i}")
        if not isinstance(e, dict):
            errors.append(f"{where}: not an object"); continue
        extra = set(e) - allowed
        if extra:
            errors.append(f"{where}: unexpected keys {sorted(extra)}")
        need = ["id", "name", "lat", "lng", "kind", "query"] + (["country"] if e.get("kind") != "ocean" else [])
        for k in need:
            if k not in e:
                errors.append(f"{where}: missing {k}")
        for k in ["id", "name", "country", "region", "kind", "query"]:
            if k in e and (not isinstance(e[k], str) or not e[k].strip()):
                errors.append(f"{where}: {k} must be a non-empty string")
        if e.get("kind") not in KINDS:
            errors.append(f"{where}: bad kind {e.get('kind')!r}")
        if not id_re.match(str(e.get("id", ""))):
            errors.append(f"{where}: id is not kebab-case <prefix>-<place>")
        elif e.get("kind") == "ocean" and not e["id"].startswith("ocean-"):
            errors.append(f"{where}: ocean ids must start with ocean-")
        elif e.get("kind") != "ocean" and not re.match(r"^[a-z]{2}-", e["id"]):
            errors.append(f"{where}: land ids must start with <iso2>-")
        for k, lo, hi in (("lat", -90, 90), ("lng", -180, 180)):
            v = e.get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= v <= hi):
                errors.append(f"{where}: {k} out of range: {v!r}")
            elif round(v, 2) != v:
                errors.append(f"{where}: {k} not rounded to 2 decimals: {v}")
    if errors:
        print("\n".join(errors)); sys.exit(1)

    ids = [e["id"] for e in entries]
    dup = [i for i, n in Counter(ids).items() if n > 1]
    if dup:
        errors.append(f"duplicate ids: {dup}")
    if ids != sorted(ids):
        errors.append("entries are not sorted by id")
    for rid in REQUIRED_IDS:
        if rid not in ids:
            errors.append(f"required id missing: {rid}")

    # --- land / water
    polys = load_polygons(geo)
    coastal = []
    for e in entries:
        inside = containing_polygon(polys, e["lat"], e["lng"])
        iso = e["id"].split("-", 1)[0]
        if e["kind"] == "ocean":
            if inside:
                errors.append(f"{e['id']}: ocean point lies on land ({inside})")
            continue
        if inside:
            continue
        if iso in NO_POLYGON_OK:
            warnings.append(f"{e['id']}: no ne_50m polygon for this country (allowed)")
            continue
        d, near = dist_to_land_km(polys, e["lat"], e["lng"])
        if d <= COAST_TOLERANCE_KM:
            coastal.append((e["id"], d, near))
        else:
            errors.append(f"{e['id']}: {d:.1f} km from land (nearest {near})")

    # --- spacing
    close = []
    for i in range(len(entries)):
        a = entries[i]
        for j in range(i + 1, len(entries)):
            b = entries[j]
            if abs(a["lat"] - b["lat"]) > 0.3:
                continue
            d = haversine_km(a, b)
            if d < MIN_SPACING_KM:
                pair = frozenset([a["id"], b["id"]])
                if pair in SPACING_ALLOW:
                    warnings.append(f"{a['id']} / {b['id']}: {d:.1f} km apart (allow-listed twin capitals)")
                else:
                    close.append((a["id"], b["id"], d))
    for a, b, d in close:
        errors.append(f"{a} / {b}: only {d:.1f} km apart (< {MIN_SPACING_KM:.0f} km)")

    # --- sovereign coverage
    ne_names = {p[0] for p in polys}
    sovereign = {NE_TO_DISPLAY.get(n, n) for n in ne_names if n not in NE_NON_SOVEREIGN} | EXTRA_SOVEREIGN_DISPLAY
    country_points = {e["country"] for e in entries if e["kind"] == "country"}
    missing = sorted(sovereign - country_points)
    if missing:
        errors.append(f"sovereign countries without a country-level point: {missing}")

    # --- continent mapping sanity
    unknown = [e["id"] for e in entries if continent_of(e) == "?"]
    if unknown:
        errors.append(f"ids with no continent mapping: {unknown}")

    # --- summary
    kinds = Counter(e["kind"] for e in entries)
    conts = Counter(continent_of(e) for e in entries)
    print(f"anchors: {len(entries)}  ({args.anchors})")
    print("by kind:      " + ", ".join(f"{k} {kinds[k]}" for k in ["country", "region", "city", "ocean"]))
    print("by continent: " + ", ".join(f"{c} {n}" for c, n in conts.most_common()))
    print(f"sovereign states covered: {len(sovereign) - len(missing)}/{len(sovereign)}")
    print(f"coastal points accepted within {COAST_TOLERANCE_KM:.0f} km: {len(coastal)}"
          + (f" (max {max(d for _, d, _ in coastal):.1f} km)" if coastal else ""))
    for w in warnings:
        print("note: " + w)
    if args.preview:
        render_preview(polys, entries, args.preview)
        print(f"preview written: {args.preview}")
    if errors:
        print(f"\nFAILED with {len(errors)} error(s):")
        for m in errors:
            print("  - " + m)
        sys.exit(1)
    print("OK: all checks passed")


if __name__ == "__main__":
    main()
