#!/usr/bin/env python3
"""Build data/itinerary.json from a Google My Maps KML export.

Each folder that holds a route line becomes one day; its points, in order,
are the stops. Every leg is measured along the KML route line and timed by
Valhalla (the public OpenStreetMap router at valhalla1.openstreetmap.de),
following that same line. Valhalla assumes posted speeds, so long highway
legs come out roughly 10% slower than Google.

    python3 tools/build_itinerary.py "path/to/trip.kml" [-o data/itinerary.json]
"""
import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

K = "{http://www.opengis.net/kml/2.2}"
VALHALLA = "https://valhalla1.openstreetmap.de"
HEADERS = {"Content-Type": "application/json", "User-Agent": "eas3010-itinerary/1.0"}
MAX_TRACE_KM = 190  # the public server refuses traces over 200 km
PAUSE_S = 1.1       # the public server allows about one request a second


def km_between(a, b):
    r = 6371.0088
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def line_km(pts):
    return sum(km_between(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def post(path, body):
    req = urllib.request.Request(VALHALLA + path, data=json.dumps(body).encode(), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as resp:
        out = json.load(resp)
    time.sleep(PAUSE_S)
    return out["trip"]["summary"]


def trace(pts):
    """Minutes and km along pts, split into chunks the server accepts."""
    thin = [pts[0]]
    for p in pts[1:]:
        if km_between(thin[-1], p) > 0.05:
            thin.append(p)
    if thin[-1] != pts[-1]:
        thin.append(pts[-1])
    chunks, cur, run = [], [thin[0]], 0.0
    for p in thin[1:]:
        run += km_between(cur[-1], p)
        cur.append(p)
        if run > MAX_TRACE_KM:
            chunks.append(cur)
            cur, run = [p], 0.0
    if len(cur) > 1:
        chunks.append(cur)
    minutes = km = 0.0
    for c in chunks:
        s = post("/trace_route", {
            "shape": [{"lat": p[1], "lon": p[0]} for p in c],
            "costing": "auto", "shape_match": "map_snap", "units": "kilometers"})
        minutes += s["time"] / 60
        km += s["length"]
    return minutes, km


def route(a, b):
    s = post("/route", {
        "locations": [{"lat": a[1], "lon": a[0]}, {"lat": b[1], "lon": b[0]}],
        "costing": "auto", "units": "kilometers"})
    return s["time"] / 60, s["length"]


def read_days(kml_path):
    root = ET.parse(kml_path).getroot()
    days = []
    for folder in root.iter(K + "Folder"):
        line, stops = None, []
        for pm in folder.findall(K + "Placemark"):
            ls = pm.find(f".//{K}LineString/{K}coordinates")
            pt = pm.find(f".//{K}Point/{K}coordinates")
            if ls is not None:
                line = [tuple(map(float, c.split(",")[:2])) for c in ls.text.split()]
            if pt is not None:
                lon, lat = map(float, pt.text.strip().split(",")[:2])
                stops.append({"name": pm.find(K + "name").text.strip(), "lat": lat, "lon": lon})
        if line and len(stops) >= 2:
            days.append((stops, line))
    return days


def split_line(stops, line):
    """Index of the line vertex nearest each stop, walking forward."""
    idx, start = [0], 0
    for s in stops[1:-1]:
        c = (s["lon"], s["lat"])
        best = min(range(start, len(line)), key=lambda j: km_between(line[j], c))
        idx.append(best)
        start = best
    idx.append(len(line) - 1)
    return idx


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("kml")
    ap.add_argument("-o", "--out", default=str(Path(__file__).resolve().parent.parent / "data" / "itinerary.json"))
    args = ap.parse_args()

    out = {"source": Path(args.kml).name, "days": []}
    for n, (stops, line) in enumerate(read_days(args.kml), 1):
        idx = split_line(stops, line)
        legs = []
        for i in range(len(stops) - 1):
            seg = line[idx[i]:idx[i + 1] + 1]
            km = line_km(seg)
            try:
                minutes, matched_km = trace(seg)
                # a partial match means Valhalla lost the line; time the stop pair instead
                if abs(matched_km - km) > 0.15 * km:
                    minutes, _ = route((stops[i]["lon"], stops[i]["lat"]), (stops[i + 1]["lon"], stops[i + 1]["lat"]))
            except urllib.error.URLError as e:
                sys.exit(f"Valhalla request failed for {stops[i]['name']} -> {stops[i + 1]['name']}: {e}")
            legs.append({"km": round(km, 1), "minutes": round(minutes)})
            print(f"Day {n}: {stops[i]['name']} -> {stops[i + 1]['name']}: {km:.1f} km, {round(minutes)} min")
        out["days"].append({"title": f"Day {n}", "stops": stops, "legs": legs})

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=1) + "\n")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
