#!/usr/bin/env python3
"""Write a read-only snapshot of the itinerary to docs/ for GitHub Pages.

    python3 tools/publish.py          # write docs/
    python3 tools/publish.py --push   # write docs/, commit it and push

The snapshot holds the stops, drive times, stop times and notes as they are
in data/itinerary.sqlite now. The published page shows them without editing
controls; editing stays with server.py.
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402

DOCS = ROOT / "docs"


def main():
    ap = argparse.ArgumentParser(description="Publish a read-only snapshot to docs/.")
    ap.add_argument("--push", action="store_true", help="commit docs/ and push")
    args = ap.parse_args()

    if not server.DB.exists():
        sys.exit("No data/itinerary.sqlite yet. Run server.py once first.")
    with server.connect() as con:
        cols = [r[1] for r in con.execute("PRAGMA table_info(stops)")]
        if "kind" not in cols:
            sys.exit("The database is in an older layout. Restart server.py once to convert it, then publish.")
        snapshot = {
            "published": time.strftime("%Y-%m-%d %H:%M"),
            "itinerary": server.itinerary(con),
            "edits": server.read_edits(con),
        }

    DOCS.mkdir(exist_ok=True)
    for name in ("index.html", "app.js", "style.css", "sw.js"):
        shutil.copy2(server.WEB / name, DOCS / name)
    (DOCS / "snapshot.json").write_text(json.dumps(snapshot, indent=1) + "\n")
    (DOCS / ".nojekyll").touch()
    print(f"Wrote docs/ (snapshot {snapshot['published']})")

    if args.push:
        git = lambda *a: subprocess.run(["git", "-C", str(ROOT), *a], check=True)
        git("add", "docs")
        if subprocess.run(["git", "-C", str(ROOT), "diff", "--cached", "--quiet", "--", "docs"]).returncode == 0:
            print("Nothing changed since the last publish.")
            return
        git("commit", "-m", f"Publish itinerary snapshot {snapshot['published']}", "--", "docs")
        git("push")


if __name__ == "__main__":
    main()
