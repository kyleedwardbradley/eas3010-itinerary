#!/usr/bin/env python3
"""Serve the itinerary page and keep edits in a local SQLite database.

    python3 server.py            # http://localhost:8010
    python3 server.py --port 9000

Each edit is one row (kind, key) -> value, so saving one field never
overwrites another.
"""
import argparse
import json
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
ITINERARY = ROOT / "data" / "itinerary.json"
DB = ROOT / "data" / "edits.sqlite"
KINDS = {"start", "dwell", "drive", "notes"}


def connect():
    con = sqlite3.connect(DB)
    con.execute("""CREATE TABLE IF NOT EXISTS edits(
        kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        updated REAL NOT NULL, PRIMARY KEY(kind, key))""")
    return con


def read_state():
    state = {k: {} for k in KINDS}
    with connect() as con:
        for kind, key, value in con.execute("SELECT kind, key, value FROM edits"):
            state[kind][key] = json.loads(value)
    return state


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):
            return
        super().log_message(fmt, *args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def edit_target(self):
        # /api/edits/<kind>/<key>
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "edits"] and parts[2] in KINDS and parts[3]:
            return parts[2], parts[3]
        return None

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/itinerary":
            return self.send_json(json.loads(ITINERARY.read_text()))
        if path == "/api/edits":
            return self.send_json(read_state())
        return super().do_GET()

    def do_PUT(self):
        target = self.edit_target()
        if not target:
            return self.send_json({"error": "unknown path"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            value = json.loads(self.rfile.read(n))["value"]
        except (ValueError, KeyError):
            return self.send_json({"error": "body must be {\"value\": ...}"}, 400)
        with connect() as con:
            con.execute("INSERT OR REPLACE INTO edits VALUES(?,?,?,?)",
                        (*target, json.dumps(value), time.time()))
        self.send_json({"ok": True})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        with connect() as con:
            if path == "/api/edits":
                con.execute("DELETE FROM edits")
            elif (target := self.edit_target()):
                con.execute("DELETE FROM edits WHERE kind=? AND key=?", target)
            else:
                return self.send_json({"error": "unknown path"}, 404)
        self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser(description="Serve the field trip itinerary.")
    ap.add_argument("--port", type=int, default=8010)
    args = ap.parse_args()
    connect().close()
    print(f"Itinerary at http://localhost:{args.port}  (edits in {DB.relative_to(ROOT)})")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
