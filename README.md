# EAS3010 field trip itinerary

A local planner for the EAS3010 field trip. It lays out each day's stops with
arrival and departure times, worked out from the day's start time, the drive
time of each leg and how long you stay at each stop. Edits are kept in a
local SQLite database.

## Run

    python3 server.py

Then open http://localhost:8010. Python 3.8 or later, standard library only.
Use `--port` for a different port.

## Editing

- **Leave at**: each day's departure time (`8`, `830`, `8:30`, `3:30pm`).
- **At stop**: time spent at a stop (`45`, `1:15`, `1h 15m`). Defaults to 30 min.
- **Drive**: type over a leg's routed time to replace it; *use OSM* puts it back.
- **Notes**: free text per stop, saved as you type.

Edits live in `data/edits.sqlite` (not committed), one row per field.
Delete the file to start over.

## Drive times

`data/itinerary.json` is built from the Google My Maps KML export:

    python3 tools/build_itinerary.py "data/EAS3010 field trip.kml"

Each folder with a route line becomes a day and its points become the stops.
Legs are measured along the KML route and timed by Valhalla, the public
OpenStreetMap router, following the same line. Valhalla uses posted speeds,
so long highway legs come out about 10% slower than Google.

Edits are keyed by day and stop position, so if a rebuilt itinerary adds or
reorders stops, check the at-stop and drive edits afterwards.
