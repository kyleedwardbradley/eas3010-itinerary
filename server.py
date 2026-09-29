#!/usr/bin/env python3
"""Serve the itinerary page and keep everything in a local SQLite database.

    python3 server.py            # http://localhost:8010
    python3 server.py --port 9000

On first run the stops are imported from data/itinerary.json. After that the
database is the itinerary: stops can be added, removed and reordered. Delete
data/itinerary.sqlite to import again.

New stops are found with Nominatim (the OpenStreetMap geocoder) and are only
added once Valhalla (the OpenStreetMap router) can drive to them from the
neighbouring stops. Every leg time is cached by its end coordinates, so the
times traced along the KML routes come back if a stop order is restored.
"""
import argparse
import json
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
ITINERARY = ROOT / "data" / "itinerary.json"
DB = ROOT / "data" / "itinerary.sqlite"
EDIT_KINDS = {"start", "dwell", "drive", "notes"}

NOMINATIM = "https://nominatim.openstreetmap.org/search"
VALHALLA = "https://valhalla1.openstreetmap.de"
UA = "eas3010-itinerary/1.0 (local field trip planner)"

LOCK = threading.Lock()      # one change to the stop list at a time
_last_call = {}              # host -> time of last request; both public servers ask for <= 1 req/s

SCHEMA = """
CREATE TABLE IF NOT EXISTS days(day INTEGER PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stops(
    id TEXT PRIMARY KEY, day INTEGER NOT NULL, pos REAL NOT NULL,
    name TEXT NOT NULL, address TEXT, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE IF NOT EXISTS legs(
    pair TEXT PRIMARY KEY, km REAL NOT NULL, minutes REAL NOT NULL, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edits(
    kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    updated REAL NOT NULL, PRIMARY KEY(kind, key));
"""


class RouteError(Exception):
    pass


# ---------------------------------------------------------------- outside services

def polite(host):
    wait = 1.1 - (time.time() - _last_call.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    _last_call[host] = time.time()


def valhalla(path, body):
    polite("valhalla")
    req = urllib.request.Request(VALHALLA + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error", "")
        except ValueError:
            msg = ""
        raise RouteError(msg or f"HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise RouteError(f"can't reach the drive-time server ({e})")


def route(a, b):
    """(minutes, km) driving from a to b, each {'lat','lon'}."""
    out = valhalla("/route", {"locations": [{"lat": a["lat"], "lon": a["lon"]}, {"lat": b["lat"], "lon": b["lon"]}],
                              "costing": "auto", "units": "kilometers"})
    s = out["trip"]["summary"]
    return s["time"] / 60, s["length"]


def reachable(p):
    """True when Valhalla finds a drivable road near p."""
    out = valhalla("/locate", {"locations": [{"lat": p["lat"], "lon": p["lon"]}], "costing": "auto", "verbose": False})
    return bool(out and out[0].get("edges"))


def geocode(q):
    polite("nominatim")
    url = NOMINATIM + "?" + urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": 6})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        hits = json.load(resp)
    return [{"name": h.get("name") or h["display_name"].split(",")[0],
             "label": h["display_name"], "lat": float(h["lat"]), "lon": float(h["lon"])} for h in hits]


# ---------------------------------------------------------------- database

def pair_key(a, b):
    return f"{a['lat']:.5f},{a['lon']:.5f}>{b['lat']:.5f},{b['lon']:.5f}"


def connect():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def seed(con):
    """Import data/itinerary.json into an empty database."""
    if con.execute("SELECT 1 FROM days").fetchone():
        return
    data = json.loads(ITINERARY.read_text())
    for d, day in enumerate(data["days"]):
        con.execute("INSERT INTO days VALUES(?,?)", (d, day["title"]))
        ids = []
        for i, s in enumerate(day["stops"]):
            ids.append(secrets.token_hex(4))
            con.execute("INSERT INTO stops VALUES(?,?,?,?,?,?,?)",
                        (ids[-1], d, i, s["name"], None, s["lat"], s["lon"]))
        for i, leg in enumerate(day["legs"]):
            con.execute("INSERT OR IGNORE INTO legs VALUES(?,?,?,?)",
                        (pair_key(day["stops"][i], day["stops"][i + 1]), leg["km"], leg["minutes"], "route line"))


def renumber(con, day):
    rows = con.execute("SELECT id FROM stops WHERE day=? ORDER BY pos", (day,)).fetchall()
    for i, r in enumerate(rows):
        con.execute("UPDATE stops SET pos=? WHERE id=?", (i, r["id"]))


def stops_of(con, day):
    return [dict(r) for r in con.execute("SELECT * FROM stops WHERE day=? ORDER BY pos", (day,))]


def leg_for(con, a, b):
    key = pair_key(a, b)
    row = con.execute("SELECT * FROM legs WHERE pair=?", (key,)).fetchone()
    if row:
        return {"key": f"{a['id']}>{b['id']}", "km": row["km"], "minutes": row["minutes"], "source": row["source"]}
    try:
        minutes, km = route(a, b)
    except RouteError as e:
        return {"key": f"{a['id']}>{b['id']}", "km": None, "minutes": None, "source": "none", "error": str(e)}
    con.execute("INSERT OR REPLACE INTO legs VALUES(?,?,?,?)", (key, round(km, 1), round(minutes), "routed"))
    return {"key": f"{a['id']}>{b['id']}", "km": round(km, 1), "minutes": round(minutes), "source": "routed"}


def itinerary(con):
    days = []
    for d in con.execute("SELECT * FROM days ORDER BY day").fetchall():
        stops = stops_of(con, d["day"])
        legs = [leg_for(con, stops[i], stops[i + 1]) for i in range(len(stops) - 1)]
        days.append({"day": d["day"], "title": d["title"], "stops": stops, "legs": legs})
    con.commit()
    return {"days": days}


def read_edits(con):
    state = {k: {} for k in EDIT_KINDS}
    for r in con.execute("SELECT kind, key, value FROM edits"):
        state[r["kind"]][r["key"]] = json.loads(r["value"])
    return state


def add_stop(con, body):
    day = int(body["day"])
    name = str(body.get("name") or "").strip()
    new = {"lat": float(body["lat"]), "lon": float(body["lon"])}
    if not name:
        raise RouteError("give the stop a name")
    stops = stops_of(con, day)
    after = body.get("after")  # stop id, or None for the start of the day
    if after is None:
        i = 0
    else:
        ids = [s["id"] for s in stops]
        if after not in ids:
            raise RouteError("the stop to insert after no longer exists")
        i = ids.index(after) + 1
    prev = stops[i - 1] if i > 0 else None
    nxt = stops[i] if i < len(stops) else None

    # confirm with the drive-time server before anything is written
    legs = []
    try:
        if prev:
            legs.append((prev, new, route(prev, new)))
        if nxt:
            legs.append((new, nxt, route(new, nxt)))
        if not legs and not reachable(new):
            raise RouteError("no drivable road near it")
    except RouteError as e:
        raise RouteError(f"The drive-time server can't route to this address: {e}. Nothing was added.")

    sid = secrets.token_hex(4)
    pos = (prev["pos"] + 0.5) if prev else -0.5
    con.execute("INSERT INTO stops VALUES(?,?,?,?,?,?,?)",
                (sid, day, pos, name, body.get("address"), new["lat"], new["lon"]))
    for a, b, (minutes, km) in legs:
        con.execute("INSERT OR REPLACE INTO legs VALUES(?,?,?,?)", (pair_key(a, b), round(km, 1), round(minutes), "routed"))
    renumber(con, day)


def remove_stop(con, sid):
    row = con.execute("SELECT day FROM stops WHERE id=?", (sid,)).fetchone()
    if not row:
        return
    con.execute("DELETE FROM stops WHERE id=?", (sid,))
    con.execute("DELETE FROM edits WHERE kind IN ('dwell','notes') AND key=?", (sid,))
    con.execute("DELETE FROM edits WHERE kind='drive' AND (key LIKE ? OR key LIKE ?)", (sid + ">%", "%>" + sid))
    renumber(con, row["day"])


def move_stop(con, sid, step):
    row = con.execute("SELECT day, pos FROM stops WHERE id=?", (sid,)).fetchone()
    if not row:
        return
    stops = stops_of(con, row["day"])
    i = [s["id"] for s in stops].index(sid)
    j = i + step
    if 0 <= j < len(stops):
        con.execute("UPDATE stops SET pos=? WHERE id=?", (j, sid))
        con.execute("UPDATE stops SET pos=? WHERE id=?", (i, stops[j]["id"]))


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def parts(self):
        return self.path.split("?")[0].strip("/").split("/")

    def do_GET(self):
        p = self.parts()
        if p == ["api", "itinerary"]:
            with LOCK, connect() as con:
                return self.send_json(itinerary(con))
        if p == ["api", "edits"]:
            with connect() as con:
                return self.send_json(read_edits(con))
        if p == ["api", "geocode"]:
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0].strip()
            if not q:
                return self.send_json({"results": []})
            try:
                return self.send_json({"results": geocode(q)})
            except (urllib.error.URLError, TimeoutError, ValueError) as e:
                return self.send_json({"error": f"address lookup failed ({e})"}, 502)
        return super().do_GET()

    def do_POST(self):
        p = self.parts()
        try:
            body = self.body()
        except ValueError:
            return self.send_json({"error": "body must be JSON"}, 400)
        with LOCK, connect() as con:
            try:
                if p == ["api", "stops"]:
                    add_stop(con, body)
                elif len(p) == 4 and p[:2] == ["api", "stops"] and p[3] == "move":
                    move_stop(con, p[2], -1 if body.get("step", 1) < 0 else 1)
                else:
                    return self.send_json({"error": "unknown path"}, 404)
            except RouteError as e:
                con.rollback()
                return self.send_json({"error": str(e)}, 422)
            except (KeyError, TypeError, ValueError):
                con.rollback()
                return self.send_json({"error": "missing or malformed fields"}, 400)
            con.commit()
            self.send_json({"itinerary": itinerary(con), "edits": read_edits(con)})

    def do_PUT(self):
        p = self.parts()
        if not (len(p) == 4 and p[:2] == ["api", "edits"] and p[2] in EDIT_KINDS):
            return self.send_json({"error": "unknown path"}, 404)
        try:
            value = self.body()["value"]
        except (ValueError, KeyError):
            return self.send_json({"error": 'body must be {"value": ...}'}, 400)
        with connect() as con:
            con.execute("INSERT OR REPLACE INTO edits VALUES(?,?,?,?)",
                        (p[2], urllib.parse.unquote(p[3]), json.dumps(value), time.time()))
        self.send_json({"ok": True})

    def do_DELETE(self):
        p = self.parts()
        if p == ["api", "edits"]:
            with connect() as con:
                con.execute("DELETE FROM edits")
            return self.send_json({"ok": True})
        if len(p) == 4 and p[:2] == ["api", "edits"] and p[2] in EDIT_KINDS:
            with connect() as con:
                con.execute("DELETE FROM edits WHERE kind=? AND key=?", (p[2], urllib.parse.unquote(p[3])))
            return self.send_json({"ok": True})
        if len(p) == 3 and p[:2] == ["api", "stops"]:
            with LOCK, connect() as con:
                remove_stop(con, p[2])
                con.commit()
                return self.send_json({"itinerary": itinerary(con), "edits": read_edits(con)})
        self.send_json({"error": "unknown path"}, 404)


def main():
    ap = argparse.ArgumentParser(description="Serve the field trip itinerary.")
    ap.add_argument("--port", type=int, default=8010)
    args = ap.parse_args()
    with connect() as con:
        seed(con)
    print(f"Itinerary at http://localhost:{args.port}  (data in {DB.relative_to(ROOT)})")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
