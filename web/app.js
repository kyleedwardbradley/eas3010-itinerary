"use strict";
// Itinerary page. Route data comes from /api/itinerary (built from the KML);
// edits are saved one field at a time to /api/edits/<kind>/<key>.

const DEFAULT_DWELL = 30, DEFAULT_START = "08:00";
let DAYS = [];
let state = {start: {}, dwell: {}, drive: {}, notes: {}};

const fmt = m => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${String(r).padStart(2, "0")}m` : `${r}m`; };
const clock = m => { const d = Math.floor(m / 1440); m = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}${d > 0 ? " +1d" : ""}`; };
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

// "8", "830", "0830", "8:30", "8.30", "8:30pm", "20:30" -> "HH:MM"
function parseClock(s) {
  s = String(s).trim().toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/); if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0), ap = m[3];
  if (ap) { if (h < 1 || h > 12) return null; h = h % 12 + (ap[0] === "p" ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
// "73", "1:13", "1h 13m", "45m" -> minutes
function parseDur(s) {
  s = String(s).trim().toLowerCase(); if (!s) return null;
  let m = s.match(/^(\d+):(\d{1,2})$/); if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(?:(\d+)\s*h(?:r|rs|ours?)?)?\s*(?:(\d+)\s*m(?:in|ins)?)?$/);
  if (m && (m[1] || m[2])) return (+(m[1] || 0)) * 60 + +(m[2] || 0);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(+s);
  return null;
}

const ll = s => `${s.lat},${s.lon}`;
const dirUrl = (a, b) => `https://www.google.com/maps/dir/?api=1&origin=${ll(a)}&destination=${ll(b)}&travelmode=driving`;
const dayUrl = st => `https://www.google.com/maps/dir/${st.map(ll).join("/")}`;
const placeUrl = s => `https://www.google.com/maps/search/?api=1&query=${ll(s)}`;

function render() {
  const root = document.getElementById("days");
  const focusId = document.activeElement?.id;
  root.innerHTML = DAYS.map((day, d) => {
    const start = state.start[d] || DEFAULT_START;
    let t = toMin(start), drive = 0, dwellTot = 0, rows = "";
    day.stops.forEach((s, i) => {
      const k = `${d}-${i}`, first = i === 0, last = i === day.stops.length - 1;
      const dwell = first || last ? 0 : (state.dwell[k] ?? DEFAULT_DWELL);
      const arr = t, dep = t + dwell;
      dwellTot += dwell;
      const timeCell = first ? `<div class="times">${clock(dep)}<small>depart</small></div>`
        : last ? `<div class="times">${clock(arr)}<small>arrive</small></div>`
        : `<div class="times">${clock(arr)}<small>to ${clock(dep)}</small></div>`;
      const dwellCell = first || last ? `<span class="endtag">${first ? "start" : "end of day"}</span>`
        : `<label class="dwell" for="dw-${k}">at stop <input class="t" id="dw-${k}" data-dwell="${k}" value="${fmt(dwell)}" aria-label="Time at ${esc(s.name)}"></label>`;
      rows += `<li class="stop">${timeCell}<div><div class="name"><a href="${placeUrl(s)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>
        <textarea class="note" id="nt-${k}" data-note="${k}" rows="1" placeholder="Notes">${esc(state.notes[k] || "")}</textarea></div>${dwellCell}</li>`;
      t = dep;
      if (!last) {
        const {km, minutes: est} = day.legs[i];
        const edited = state.drive[k];
        const mins = edited ?? est;
        drive += mins; t += mins;
        rows += `<li class="leg"><div class="line"><span></span></div><div class="legbody">
          <label for="dr-${k}" style="display:flex;align-items:center;gap:6px">drive <input class="t" id="dr-${k}" data-drive="${k}" value="${fmt(mins)}" aria-label="Drive time to ${esc(day.stops[i + 1].name)}"></label>
          ${edited != null ? `<span class="chip goog">edited</span><button class="reset" type="button" data-unset="${k}">use OSM (${fmt(est)})</button>` : `<span class="chip est">OSM</span>`}
          <span class="km">${km.toFixed(1)} km · ${(km * 0.621371).toFixed(1)} mi</span>
          <a href="${dirUrl(s, day.stops[i + 1])}" target="_blank" rel="noopener">Open route ↗</a></div></li>`;
      }
    });
    const km = day.legs.reduce((a, l) => a + l.km, 0);
    return `<section class="day" aria-labelledby="h-${d}">
      <div class="dayhead"><div><h2 id="h-${d}">${esc(day.title)}</h2>
        <div class="route">${day.stops.length} stops · ${km.toFixed(0)} km · <a href="${dayUrl(day.stops)}" target="_blank" rel="noopener">Whole day on a map ↗</a></div></div>
        <label class="startbox" for="st-${d}">Leave at <input class="t" id="st-${d}" data-start="${d}" value="${start}" aria-label="${esc(day.title)} departure time"></label></div>
      <div class="totals"><span>Driving <b>${fmt(drive)}</b></span><span>At stops <b>${fmt(dwellTot)}</b></span><span>Back / arrive <b>${clock(t)}</b></span><span>Day length <b>${fmt(t - toMin(start))}</b></span></div>
      <ol class="plan">${rows}</ol></section>`;
  }).join("");
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (el.matches("input.t")) el.select(); } }
}

const setStatus = s => { document.getElementById("status").textContent = s; };

async function send(method, path, value) {
  setStatus("Saving…");
  try {
    const res = await fetch(path, {method, headers: {"Content-Type": "application/json"},
      body: value === undefined ? undefined : JSON.stringify({value})});
    if (!res.ok) throw new Error(res.status);
    setStatus("Saved");
  } catch {
    setStatus("Couldn't save. Is server.py still running?");
  }
}
const save = (kind, key, value) => send("PUT", `/api/edits/${kind}/${encodeURIComponent(key)}`, value);
const unset = (kind, key) => send("DELETE", `/api/edits/${kind}/${encodeURIComponent(key)}`);

document.addEventListener("change", e => {
  const el = e.target;
  const kind = el.dataset.start != null ? "start" : el.dataset.dwell != null ? "dwell" : el.dataset.drive != null ? "drive" : null;
  if (!kind) return;
  const key = el.dataset[kind];
  const v = kind === "start" ? parseClock(el.value) : parseDur(el.value);
  if (v == null) {
    el.classList.add("bad");
    el.title = kind === "start" ? "Use a time like 15:30 or 3:30pm" : "Use minutes like 45, 1:15 or 1h 15m";
    return;
  }
  el.classList.remove("bad"); el.title = "";
  state[kind][key] = v;
  render();
  save(kind, key, v);
});

// notes save after a pause in typing
const noteTimers = {};
document.addEventListener("input", e => {
  const key = e.target.dataset.note; if (key == null) return;
  const value = e.target.value;
  state.notes[key] = value;
  clearTimeout(noteTimers[key]);
  noteTimers[key] = setTimeout(() => value ? save("notes", key, value) : unset("notes", key), 600);
});

// select the whole value so typing replaces it
document.addEventListener("focusin", e => { if (e.target.matches("input.t")) setTimeout(() => e.target.select(), 0); });
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input.t")) e.target.blur(); });
document.addEventListener("click", e => {
  const k = e.target.dataset?.unset; if (k == null) return;
  delete state.drive[k]; render(); unset("drive", k);
});

const conf = document.getElementById("confirmReset"), resetBtn = document.getElementById("resetAll");
resetBtn.onclick = () => { conf.hidden = false; resetBtn.hidden = true; };
document.getElementById("resetNo").onclick = () => { conf.hidden = true; resetBtn.hidden = false; };
document.getElementById("resetYes").onclick = () => {
  state = {start: {}, dwell: {}, drive: {}, notes: {}};
  conf.hidden = true; resetBtn.hidden = false;
  render(); send("DELETE", "/api/edits");
};

(async () => {
  try {
    const [it, edits] = await Promise.all([fetch("/api/itinerary").then(r => r.json()), fetch("/api/edits").then(r => r.json())]);
    DAYS = it.days;
    state = edits;
    render();
    setStatus("Saved");
  } catch {
    setStatus("Couldn't load the itinerary. Start it with: python3 server.py");
  }
})();
