"use strict";
// Itinerary page. The server owns the stop list (/api/itinerary) and the
// per-field edits (/api/edits/<kind>/<key>): start by day, dwell and notes by
// stop id, drive by leg key "<from id>><to id>".

// Rest stops have no location: they split the drive between the places either
// side. "before" edits hold the driving minutes since the previous stop.

const API_VERSION = 3;  // must match server.py
const DEFAULT_DWELL = 30, DEFAULT_REST = 15, DEFAULT_START = "08:00";
let DAYS = [];
let state = {start: {}, dwell: {}, drive: {}, notes: {}, before: {}};
// adding: {day, kind, q, results, pick, name, after, busy, error}; removing: stop id
const ui = {adding: null, removing: null};

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

function stopControls(s, i, n) {
  if (ui.removing === s.id) {
    return `<span class="ctl confirm">Remove this stop? <button type="button" data-remove-yes="${s.id}">Remove</button><button type="button" data-remove-no>Keep</button></span>`;
  }
  return `<span class="ctl">
    <button type="button" class="icon" data-move="${s.id}" data-step="-1" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(s.name)} earlier" title="Move earlier">↑</button>
    <button type="button" class="icon" data-move="${s.id}" data-step="1" ${i === n - 1 ? "disabled" : ""} aria-label="Move ${esc(s.name)} later" title="Move later">↓</button>
    <button type="button" class="icon" data-remove="${s.id}" aria-label="Remove ${esc(s.name)}" title="Remove">✕</button></span>`;
}

function whereSelect(day, a) {
  const opts = [`<option value="" ${a.after == null ? "selected" : ""}>At the start of the day</option>`]
    .concat(day.stops.map(s => `<option value="${s.id}" ${a.after === s.id ? "selected" : ""}>After ${esc(s.name)}</option>`));
  return `<label class="lbl" for="aa-${day.day}">Where</label><select id="aa-${day.day}">${opts.join("")}</select>`;
}

function addForm(day) {
  const a = ui.adding;
  const d = day.day;
  if (!a || a.day !== d) {
    return `<div class="addstop"><button type="button" class="addbtn" data-add="${d}">+ Add stop</button>
      <button type="button" class="addbtn" data-add-rest="${d}">+ Add rest stop</button></div>`;
  }
  if (a.kind === "rest") {
    return `<div class="addstop open"><div class="confirmrow">
      <label class="lbl" for="an-${d}">Rest stop name</label><input id="an-${d}" class="q" value="${esc(a.name)}">
      ${whereSelect(day, a)}
      <button type="button" class="primary" data-confirm="${d}" ${a.busy ? "disabled" : ""}>Add rest stop</button>
      <button type="button" data-cancel>Cancel</button></div>
      ${a.error ? `<p class="msg err">${esc(a.error)}</p>` : ""}</div>`;
  }
  let html = `<div class="addstop open">
    <form class="findrow" data-find="${d}">
      <label for="aq-${d}" class="lbl">Address or place</label>
      <input id="aq-${d}" class="q" value="${esc(a.q)}" placeholder="e.g. 1 Crossgates Mall Rd, Albany NY" autocomplete="off">
      <button type="submit" ${a.busy ? "disabled" : ""}>Find</button>
      <button type="button" data-cancel ${a.busy ? "disabled" : ""}>Cancel</button>
    </form>`;
  if (a.results && !a.results.length) html += `<p class="msg">No matches. Try adding the town or state.</p>`;
  if (a.results && a.results.length) {
    html += `<ul class="results">${a.results.map((r, i) => `<li><label><input type="radio" name="pick-${d}" data-pick="${i}" ${a.pick === i ? "checked" : ""}>
      <span><b>${esc(r.name)}</b><small>${esc(r.label)}</small></span></label></li>`).join("")}</ul>`;
  }
  if (a.pick != null) {
    html += `<div class="confirmrow">
      <label class="lbl" for="an-${d}">Name</label><input id="an-${d}" class="q" value="${esc(a.name)}">
      ${whereSelect(day, a)}
      <button type="button" class="primary" data-confirm="${d}" ${a.busy ? "disabled" : ""}>Check drive times and add</button></div>`;
  }
  if (a.busy) html += `<p class="msg">${esc(a.busy)}</p>`;
  if (a.error) html += `<p class="msg err">${esc(a.error)}</p>`;
  return html + `</div>`;
}

function render() {
  const root = document.getElementById("days");
  const focusId = document.activeElement?.id;
  root.innerHTML = DAYS.map(day => {
    const d = day.day, n = day.stops.length;
    const start = state.start[d] || DEFAULT_START;
    const places = day.stops.filter(s => s.kind === "place");
    const legFrom = Object.fromEntries(day.legs.map(l => [l.from, l]));
    let t = toMin(start), drive = 0, dwellTot = 0, rows = "", noRoute = 0;
    let cur = null;  // the drive in progress: {total, used, restsLeft}
    day.stops.forEach((s, i) => {
      if (s.kind === "rest") {
        let beforeCell = "", over = false;
        if (cur) {
          const even = Math.max(0, Math.round((cur.total - cur.used) / (cur.restsLeft + 1)));
          const before = state.before[s.id] ?? even;
          t += before; cur.used += before; cur.restsLeft--;
          over = cur.used > cur.total;
          beforeCell = `<label class="dwell" for="bf-${s.id}">after <input class="t" id="bf-${s.id}" data-before="${s.id}" value="${fmt(before)}" aria-label="Driving before ${esc(s.name)}"> driving</label>`;
        }
        const dwell = state.dwell[s.id] ?? DEFAULT_REST;
        dwellTot += dwell;
        rows += `<li class="stop rest"><div class="times">${clock(t)}<small>to ${clock(t + dwell)}</small></div>
          <div><div class="namerow"><div class="name"><span class="chip rest">rest</span> ${esc(s.name)}</div>${stopControls(s, i, n)}</div>
          ${over ? `<div class="msg err">Placed past the end of this drive</div>` : ""}
          <textarea class="note" id="nt-${s.id}" data-note="${s.id}" rows="1" placeholder="Notes">${esc(state.notes[s.id] || "")}</textarea></div>
          <div class="restcells">${beforeCell}<label class="dwell" for="dw-${s.id}">stop <input class="t" id="dw-${s.id}" data-dwell="${s.id}" value="${fmt(dwell)}" aria-label="Time at ${esc(s.name)}"></label></div></li>`;
        t += dwell;
        return;
      }
      if (cur) { t += Math.max(0, cur.total - cur.used); cur = null; }
      const first = s === places[0], last = s === places[places.length - 1];
      const dwell = first || last ? 0 : (state.dwell[s.id] ?? DEFAULT_DWELL);
      const arr = t, dep = t + dwell;
      dwellTot += dwell;
      const timeCell = first ? `<div class="times">${clock(dep)}<small>depart</small></div>`
        : last ? `<div class="times">${clock(arr)}<small>arrive</small></div>`
        : `<div class="times">${clock(arr)}<small>to ${clock(dep)}</small></div>`;
      const dwellCell = first || last ? `<span class="endtag">${first ? "start" : "end of day"}</span>`
        : `<label class="dwell" for="dw-${s.id}">at stop <input class="t" id="dw-${s.id}" data-dwell="${s.id}" value="${fmt(dwell)}" aria-label="Time at ${esc(s.name)}"></label>`;
      rows += `<li class="stop">${timeCell}<div><div class="namerow"><div class="name"><a href="${placeUrl(s)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>${stopControls(s, i, n)}</div>
        ${s.address ? `<div class="addr">${esc(s.address)}</div>` : ""}
        <textarea class="note" id="nt-${s.id}" data-note="${s.id}" rows="1" placeholder="Notes">${esc(state.notes[s.id] || "")}</textarea></div>${dwellCell}</li>`;
      t = dep;
      const leg = legFrom[s.id];
      if (leg) {
        const next = places[places.indexOf(s) + 1];
        const edited = state.drive[leg.key];
        const mins = edited ?? leg.minutes;
        if (mins == null) noRoute++; else drive += mins;
        const restsLeft = day.stops.slice(i + 1, day.stops.indexOf(next)).length;
        cur = {total: mins ?? 0, used: 0, restsLeft};
        const chip = edited != null
          ? `<span class="chip goog">edited</span>${leg.minutes != null ? `<button class="reset" type="button" data-unset="${leg.key}">use OSM (${fmt(leg.minutes)})</button>` : ""}`
          : leg.minutes != null ? `<span class="chip est">OSM</span>` : `<span class="chip warn" title="${esc(leg.error || "")}">no route</span>`;
        rows += `<li class="leg"><div class="line"><span></span></div><div class="legbody">
          <label for="dr-${leg.key}" style="display:flex;align-items:center;gap:6px">drive <input class="t" id="dr-${leg.key}" data-drive="${leg.key}" value="${mins != null ? fmt(mins) : ""}" placeholder="?" aria-label="Drive time to ${esc(next.name)}"></label>
          ${chip}
          ${leg.km != null ? `<span class="km">${leg.km.toFixed(1)} km · ${(leg.km * 0.621371).toFixed(1)} mi</span>` : ""}
          <a href="${dirUrl(s, next)}" target="_blank" rel="noopener">Open route ↗</a></div></li>`;
      }
    });
    const km = day.legs.reduce((a, l) => a + (l.km || 0), 0);
    return `<section class="day" aria-labelledby="h-${d}">
      <div class="dayhead"><div><h2 id="h-${d}">${esc(day.title)}</h2>
        <div class="route">${places.length} stop${places.length === 1 ? "" : "s"}${n > places.length ? ` + ${n - places.length} rest` : ""} · ${km.toFixed(0)} km${places.length > 1 ? ` · <a href="${dayUrl(places)}" target="_blank" rel="noopener">Whole day on a map ↗</a>` : ""}</div></div>
        <label class="startbox" for="st-${d}">Leave at <input class="t" id="st-${d}" data-start="${d}" value="${start}" aria-label="${esc(day.title)} departure time"></label></div>
      <div class="totals"><span>Driving <b>${fmt(drive)}</b>${noRoute ? ` <span class="chip warn">${noRoute} leg${noRoute > 1 ? "s" : ""} missing</span>` : ""}</span><span>At stops <b>${fmt(dwellTot)}</b></span><span>Back / arrive <b>${clock(t)}</b></span><span>Day length <b>${fmt(t - toMin(start))}</b></span></div>
      <ol class="plan">${rows || `<li class="stop"><span class="endtag">No stops</span></li>`}</ol>
      ${addForm(day)}</section>`;
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

// stop-list changes: the server answers with the whole itinerary
async function changeStops(method, path, body) {
  const res = await fetch(path, {method, headers: {"Content-Type": "application/json"}, body: body && JSON.stringify(body)});
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `The server refused the change (${res.status}).`);
  checkVersion(out.itinerary.version);
  DAYS = out.itinerary.days;
  state = out.edits;
}

async function stopAction(method, path, body, busyText) {
  setStatus(busyText);
  try { await changeStops(method, path, body); setStatus("Saved"); }
  catch (e) { setStatus(e.message); }
  ui.removing = null;
  render();
}

// a rest stop most likely belongs in the day's longest drive
function longestLegFrom(day) {
  const legs = day.legs.filter(l => l.minutes != null);
  if (!legs.length) return defaultAfter(day);
  return legs.reduce((a, b) => (state.drive[b.key] ?? b.minutes) > (state.drive[a.key] ?? a.minutes) ? b : a).from;
}

function checkVersion(v) {
  if (v === API_VERSION) return;
  document.getElementById("days").innerHTML = "";
  throw new Error("The server is running an older version of this app. Stop it with Ctrl-C, start it again with python3 server.py, then reload this page.");
}

function defaultAfter(day) {
  const n = day.stops.length;
  return n >= 2 ? day.stops[n - 2].id : n ? day.stops[0].id : null;
}

document.addEventListener("change", e => {
  const el = e.target;
  if (el.id?.startsWith("aa-")) { ui.adding.after = el.value || null; return; }
  if (el.dataset.pick != null) {
    const a = ui.adding, r = a.results[+el.dataset.pick];
    a.pick = +el.dataset.pick; a.name = r.name; a.error = null;
    render(); return;
  }
  const kind = ["start", "dwell", "drive", "before"].find(k => el.dataset[k] != null);
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

// notes save after a pause in typing; the add-stop fields just track their text
const noteTimers = {};
document.addEventListener("input", e => {
  const el = e.target;
  if (el.id?.startsWith("aq-")) { ui.adding.q = el.value; return; }
  if (el.id?.startsWith("an-")) { ui.adding.name = el.value; return; }
  const key = el.dataset.note; if (key == null) return;
  const value = el.value;
  state.notes[key] = value;
  clearTimeout(noteTimers[key]);
  noteTimers[key] = setTimeout(() => value ? save("notes", key, value) : unset("notes", key), 600);
});

document.addEventListener("submit", async e => {
  const d = e.target.dataset.find; if (d == null) return;
  e.preventDefault();
  const a = ui.adding;
  if (!a.q.trim()) return;
  Object.assign(a, {busy: "Looking up the address…", error: null, results: null, pick: null});
  render();
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(a.q)}`);
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Address lookup failed.");
    a.results = out.results;
    if (a.results.length === 1) { a.pick = 0; a.name = a.results[0].name; }
  } catch (err) { a.error = err.message; }
  a.busy = null;
  render();
});

// select the whole value so typing replaces it
document.addEventListener("focusin", e => { if (e.target.matches("input.t")) setTimeout(() => e.target.select(), 0); });
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input.t")) e.target.blur(); });

document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const ds = b.dataset;
  if (ds.unset != null) { delete state.drive[ds.unset]; render(); unset("drive", ds.unset); }
  else if (ds.move != null) stopAction("POST", `/api/stops/${ds.move}/move`, {step: +ds.step}, "Checking drive times…");
  else if (ds.remove != null) { ui.removing = ds.remove; render(); }
  else if (ds.removeNo != null) { ui.removing = null; render(); }
  else if (ds.removeYes != null) stopAction("DELETE", `/api/stops/${ds.removeYes}`, undefined, "Removing…");
  else if (ds.add != null) {
    const day = DAYS.find(x => x.day === +ds.add);
    ui.adding = {day: day.day, kind: "place", q: "", results: null, pick: null, name: "", after: defaultAfter(day), busy: null, error: null};
    render();
    document.getElementById(`aq-${day.day}`)?.focus();
  }
  else if (ds.addRest != null) {
    const day = DAYS.find(x => x.day === +ds.addRest);
    ui.adding = {day: day.day, kind: "rest", name: "Rest stop", after: longestLegFrom(day), busy: null, error: null};
    render();
    document.getElementById(`an-${day.day}`)?.select();
  }
  else if (ds.cancel != null) { ui.adding = null; render(); }
  else if (ds.confirm != null && ui.adding.kind === "rest") {
    const a = ui.adding;
    if (!a.name.trim()) { a.error = "Give the rest stop a name."; render(); return; }
    try {
      await changeStops("POST", "/api/stops", {day: a.day, kind: "rest", after: a.after, name: a.name.trim()});
      ui.adding = null;
      setStatus("Rest stop added");
    } catch (err) { a.error = err.message; }
    render();
  }
  else if (ds.confirm != null) {
    const a = ui.adding, r = a.results[a.pick];
    if (!a.name.trim()) { a.error = "Give the stop a name."; render(); return; }
    a.busy = "Checking drive times with the routing server…"; a.error = null;
    render();
    try {
      await changeStops("POST", "/api/stops", {day: a.day, after: a.after, name: a.name.trim(), address: r.label, lat: r.lat, lon: r.lon});
      ui.adding = null;
      setStatus("Stop added");
    } catch (err) { a.busy = null; a.error = err.message; }
    render();
  }
});

const conf = document.getElementById("confirmReset"), resetBtn = document.getElementById("resetAll");
resetBtn.onclick = () => { conf.hidden = false; resetBtn.hidden = true; };
document.getElementById("resetNo").onclick = () => { conf.hidden = true; resetBtn.hidden = false; };
document.getElementById("resetYes").onclick = () => {
  state = {start: {}, dwell: {}, drive: {}, notes: {}, before: {}};
  conf.hidden = true; resetBtn.hidden = false;
  render(); send("DELETE", "/api/edits");
};

(async () => {
  try {
    const [it, edits] = await Promise.all([fetch("/api/itinerary").then(r => r.json()), fetch("/api/edits").then(r => r.json())]);
    checkVersion(it.version);
    DAYS = it.days;
    state = {...edits, before: edits.before || {}};
    render();
    setStatus("Saved");
  } catch (e) {
    setStatus(e.message.includes("older version") ? e.message : "Couldn't load the itinerary. Start it with: python3 server.py");
  }
})();
