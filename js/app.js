// MetroMate — map rendering, interaction and journey display

const G = buildGraph(METRO);
const ST = METRO.stations, LINES = METRO.lines;
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const byName = new Map(ST.map((s, i) => [s.name.toLowerCase(), i]));
const linesOf = ST.map(() => []);
LINES.forEach((l, li) => l.stops.forEach(([s]) => linesOf[s].includes(li) || linesOf[s].push(li)));

const state = { pref: "fastest", from: -1, to: -1, route: null, anim: 0, view: null, base: null };

// ---------------- Projection ----------------
const lat0 = ST.reduce((s, x) => s + x.lat, 0) / ST.length;
const kx = Math.cos((lat0 * Math.PI) / 180);
const minLon = Math.min(...ST.map((s) => s.lon)), maxLon = Math.max(...ST.map((s) => s.lon));
const minLat = Math.min(...ST.map((s) => s.lat)), maxLat = Math.max(...ST.map((s) => s.lat));
const W = 1000, PAD = 40, scale = (W - 2 * PAD) / ((maxLon - minLon) * kx);
const H = (maxLat - minLat) * scale + 2 * PAD;
const P = ST.map((s) => ({ x: PAD + (s.lon - minLon) * kx * scale, y: PAD + (maxLat - s.lat) * scale }));

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
const pts = (ids) => ids.map((s) => `${P[s].x.toFixed(1)},${P[s].y.toFixed(1)}`).join(" ");

// ---------------- Draw map ----------------
function drawMap() {
  const svg = $("map");
  svg.innerHTML = "";
  state.base = { x: 0, y: 0, w: W, h: H };
  setView({ ...state.base });
  const gTracks = el("g", { id: "gTracks" }, svg);
  LINES.forEach((l) => el("polyline", { class: "track", points: pts(l.stops.map((x) => x[0])), stroke: l.color }, gTracks));
  METRO.walkways.forEach(([a, b]) => el("line", { class: "walk", x1: P[a].x, y1: P[a].y, x2: P[b].x, y2: P[b].y }, gTracks));
  el("g", { id: "gDis" }, svg);
  el("g", { id: "gHeat" }, svg);
  el("g", { id: "gRoute" }, svg);
  el("g", { id: "gExplore" }, svg);
  const gSt = el("g", { id: "gStations" }, svg);
  ST.forEach((s, i) => {
    const ix = G.interchanges[i];
    const g = el("g", { class: "st" + (ix ? " ix" : ""), "data-i": i, transform: `translate(${P[i].x.toFixed(1)},${P[i].y.toFixed(1)})` }, gSt);
    el("circle", { r: ix ? 5 : 3.2, stroke: LINES[linesOf[i][0]].color }, g);
    g.addEventListener("mouseenter", (e) => showTip(e, i));
    g.addEventListener("mouseleave", () => ($("tip").hidden = true));
    g.addEventListener("click", (e) => { e.stopPropagation(); pickStation(i); });
  });
  const gLab = el("g", { id: "gLabels" }, svg);
  ST.forEach((s, i) => {
    if (!G.interchanges[i]) return;
    const t = el("text", { class: "label", "data-i": i }, gLab);
    t.textContent = s.name;
  });
  el("g", { id: "gEnds" }, svg);
  rescale();
}

function showTip(e, i) {
  const s = ST[i], tip = $("tip"), wrap = $("mapWrap").getBoundingClientRect();
  const r = e.currentTarget.getBoundingClientRect();
  tip.innerHTML = `<b>${s.name}</b><br><span style="opacity:.75">${s.layout || ""}${s.opened ? " · opened " + s.opened.slice(-4) : ""}</span>
    <div class="tl">${linesOf[i].map((li) => `<span class="linepill" style="background:${LINES[li].color}">${LINES[li].name}</span>`).join("")}</div>`;
  tip.hidden = false;
  tip.style.left = Math.min(r.left - wrap.left + 14, wrap.width - 250) + "px";
  tip.style.top = Math.max(8, r.top - wrap.top - 64) + "px";
}

// ---------------- Pan & zoom ----------------
function setView(v) {
  const svg = $("map"), changed = !state.view || state.view.w !== v.w;
  state.view = v;
  svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  if (changed) rescale();
}
// Keep stations, labels and strokes the same size on screen at every zoom level
function rescale() {
  const svg = $("map"), r = svg.getBoundingClientRect(), v = state.view;
  const u = Math.max(v.w / (r.width || 1000), v.h / (r.height || 800));
  svg.style.setProperty("--u", u);
  svg.querySelectorAll("#gStations .st").forEach((g) => {
    const i = +g.dataset.i; g.setAttribute("transform", `translate(${P[i].x.toFixed(1)},${P[i].y.toFixed(1)}) scale(${u})`);
  });
  svg.querySelectorAll("#gLabels text").forEach((t) => {
    const i = +t.dataset.i; t.setAttribute("x", P[i].x + 8 * u); t.setAttribute("y", P[i].y - 7 * u);
  });
}
function zoom(f, cx, cy) {
  const v = state.view;
  if (cx == null) { cx = v.x + v.w / 2; cy = v.y + v.h / 2; }
  const w = Math.min(state.base.w * 1.2, Math.max(80, v.w * f)), h = (w * v.h) / v.w;
  setView({ x: cx - ((cx - v.x) * w) / v.w, y: cy - ((cy - v.y) * h) / v.h, w, h });
}
function fitTo(ids) {
  if (!ids.length) return setView({ ...state.base });
  const xs = ids.map((s) => P[s].x), ys = ids.map((s) => P[s].y);
  const pad = 60, rect = $("map").getBoundingClientRect(), aspect = rect.width / rect.height || W / H;
  let x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < aspect) { const nw = h * aspect; x0 -= (nw - w) / 2; w = nw; } else { const nh = w / aspect; y0 -= (nh - h) / 2; h = nh; }
  setView({ x: x0, y: y0, w, h });
}
function svgPoint(evt) {
  const r = $("map").getBoundingClientRect(), v = state.view;
  // preserveAspectRatio "xMidYMid meet": map client coords into the viewBox
  const s = Math.max(v.w / r.width, v.h / r.height);
  return { x: v.x + v.w / 2 + (evt.clientX - r.left - r.width / 2) * s, y: v.y + v.h / 2 + (evt.clientY - r.top - r.height / 2) * s, s };
}
function initPanZoom() {
  const svg = $("map");
  svg.addEventListener("wheel", (e) => { e.preventDefault(); const p = svgPoint(e); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y); }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => { if (e.target.closest(".st")) return; drag = { x: e.clientX, y: e.clientY, v: { ...state.view }, s: svgPoint(e).s }; svg.classList.add("dragging"); svg.setPointerCapture(e.pointerId); });
  svg.addEventListener("pointermove", (e) => { if (!drag) return; setView({ ...drag.v, x: drag.v.x - (e.clientX - drag.x) * drag.s, y: drag.v.y - (e.clientY - drag.y) * drag.s }); });
  svg.addEventListener("pointerup", () => { drag = null; svg.classList.remove("dragging"); });
  $("zoomIn").onclick = () => zoom(1 / 1.3);
  $("zoomOut").onclick = () => zoom(1.3);
  $("zoomReset").onclick = () => fitTo(state.route ? routeStations() : []);
}

// ---------------- Picking stations ----------------
function pickStation(i) {
  if (state.from < 0 || (state.from >= 0 && state.to >= 0)) {
    state.from = i; state.to = -1; $("fromInput").value = ST[i].name; $("toInput").value = "";
    clearRoute(); drawEnds(); if ($("heat").checked) drawHeat();
  } else {
    state.to = i; $("toInput").value = ST[i].name; run();
  }
}
function readInputs() {
  const f = byName.get($("fromInput").value.trim().toLowerCase()), t = byName.get($("toInput").value.trim().toLowerCase());
  const err = $("err");
  if (f == null || t == null) { err.hidden = false; err.textContent = "Pick both stations from the list."; return false; }
  if (f === t) { err.hidden = false; err.textContent = "Start and destination are the same station."; return false; }
  err.hidden = true; state.from = f; state.to = t; return true;
}

// ---------------- Route ----------------
function clearRoute() {
  cancelAnimationFrame(state.anim);
  state.route = null;
  ["gRoute", "gExplore"].forEach((id) => ($(id).innerHTML = ""));
  $("map").classList.remove("has-route");
  document.querySelectorAll("#map .on-route").forEach((n) => n.classList.remove("on-route"));
  $("summary").hidden = true;
}
function routeStations() { return state.route.desc.legs.filter((l) => l.kind === "ride").flatMap((l) => l.stations); }

function run() {
  if (!readInputs()) return;
  clearRoute();
  const r = findRoute(G, state.from, state.to, state.pref);
  if (!r.found) { $("err").hidden = false; $("err").textContent = "No route available — trains on this section are cancelled."; return; }
  state.route = { r, desc: describeRoute(G, r) };
  drawEnds();
  if ($("heat").checked) drawHeat();
  fitTo(routeStations());
  renderSummary();
  if ($("animate").checked) animateSearch(r, drawRoute); else drawRoute();
}

function animateSearch(r, done) {
  const g = $("gExplore"), order = r.exploredStations, total = order.length;
  const dur = Math.min(1600, 300 + total * 6), t0 = performance.now();
  let shown = 0;
  const step = (now) => {
    const k = Math.min(total, Math.floor(((now - t0) / dur) * total));
    for (; shown < k; shown++) { const s = order[shown]; el("circle", { class: "explored", cx: P[s].x, cy: P[s].y }, g); }
    if (shown < total) state.anim = requestAnimationFrame(step);
    else { done(); }
  };
  state.anim = requestAnimationFrame(step);
}

function drawRoute() {
  const { desc, r } = state.route;
  const g = $("gRoute");
  g.innerHTML = "";
  $("map").classList.add("has-route");
  $("gExplore").querySelectorAll("circle").forEach((c) => (c.style.opacity = 0.22));
  for (const leg of desc.legs) {
    if (leg.kind === "ride") {
      el("polyline", { class: "route-casing", points: pts(leg.stations) }, g);
      el("polyline", { class: "route", points: pts(leg.stations), stroke: LINES[leg.line].color }, g);
    } else if (leg.kind === "walk") {
      el("line", { class: "walk walk-route", x1: P[leg.at].x, y1: P[leg.at].y, x2: P[leg.to].x, y2: P[leg.to].y }, g);
    }
  }
  const on = new Set(routeStations());
  document.querySelectorAll("#gStations .st").forEach((n) => n.classList.toggle("on-route", on.has(+n.dataset.i)));
  const gl = $("gLabels");
  gl.querySelectorAll("text.extra").forEach((t) => t.remove());
  on.forEach((s) => {
    const existing = gl.querySelector(`text[data-i="${s}"]`);
    if (existing) existing.classList.add("on-route");
    else if (s === state.from || s === state.to || desc.legs.some((l) => l.kind === "ride" && (l.from === s || l.to === s))) {
      const t = el("text", { class: "label extra on-route", "data-i": s }, gl); t.textContent = ST[s].name;
    }
  });
  rescale();
  drawEnds();
}

function drawEnds() {
  const g = $("gEnds"); g.innerHTML = "";
  if (state.from >= 0) el("circle", { class: "endpoint", cx: P[state.from].x, cy: P[state.from].y, fill: "#16a34a" }, g);
  if (state.to >= 0) el("circle", { class: "endpoint", cx: P[state.to].x, cy: P[state.to].y, fill: "#dc2626" }, g);
}

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
function renderSummary() {
  const { desc } = state.route;
  const fare = fareFor(desc.rideKm, $("sunday").checked);
  $("summary").hidden = false;
  $("sTime").textContent = desc.time >= 60 ? `${Math.floor(desc.time / 60)}h ${Math.round(desc.time % 60)}m` : `${Math.round(desc.time)} min`;
  $("sFare").textContent = "₹" + fare;
  $("sKm").textContent = desc.rideKm.toFixed(1) + "km";
  $("sStops").textContent = desc.stops;
  $("sChanges").textContent = desc.changes;
  const items = [];
  desc.legs.forEach((leg) => {
    if (leg.kind === "ride") {
      const L = LINES[leg.line];
      const mids = leg.stations.slice(1, -1).map((s) => ST[s].name);
      items.push(`<li style="--c:${L.color}"><span class="dot"></span><span class="st">${ST[leg.from].name}</span>
        <span class="meta"><span class="linepill" style="background:${L.color}">${L.name}</span> towards ${ST[leg.towards].name}</span>
        <span class="meta">${leg.stops} stop${leg.stops > 1 ? "s" : ""} · ${leg.km.toFixed(1)} km · ${fmtMin(leg.time)}</span>
        ${mids.length ? `<details><summary>${mids.length} stations in between</summary>${mids.join(" → ")}</details>` : ""}</li>`);
    } else {
      items.push(`<li class="change"><span class="dot"></span><span class="st">${leg.kind === "walk" ? `Walk ${ST[leg.at].name} → ${ST[leg.to].name}` : `Change at ${ST[leg.at].name}`}</span>
        <span class="meta">${leg.kind === "walk" ? "walkway interchange · " : ""}about ${leg.time} min</span></li>`);
    }
  });
  items.push(`<li class="end" style="--c:#dc2626"><span class="dot" style="border-color:#dc2626"></span><span class="st">Arrive at ${ST[state.to].name}</span></li>`);
  $("journey").innerHTML = items.join("");
}

// ---------------- Cancelled trains on the map ----------------
function drawDisruptions() {
  const g = $("gDis"); if (!g) return;
  g.innerHTML = "";
  const active = Disruptions.active();
  active.forEach((d) => {
    const ids = LINES[d.line].stops.slice(d.a, d.b + 1).map((x) => x[0]);
    el("polyline", { class: "dis-line", points: pts(ids) }, g);
    ids.forEach((s) => el("circle", { class: "dis-dot", cx: P[s].x, cy: P[s].y }, g));
  });
  const box = $("alerts");
  box.hidden = !active.length;
  box.innerHTML = active.map((d) => `<div class="alert"><b>⚠ Service alert</b> <span class="linepill" style="background:${LINES[d.line].color}">${LINES[d.line].name}</span>
    trains cancelled between <b>${ST[d.from].name}</b> and <b>${ST[d.to].name}</b> (${d.reason}). Journeys are planned around this section.</div>`).join("");
}

// ---------------- Travel-time map ----------------
function heatColor(t) { // 0..1 → green → yellow → red
  const stops = [[22, 163, 74], [234, 179, 8], [220, 38, 38], [127, 29, 29]];
  const x = Math.min(0.999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(x), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c.join(",")})`;
}
function drawHeat() {
  const g = $("gHeat"); g.innerHTML = "";
  const src = state.from >= 0 ? state.from : byName.get("rajiv chowk");
  const times = travelTimesFrom(G, src);
  const max = Math.ceil(Math.max(...times.filter(isFinite)) / 30) * 30;
  ST.forEach((s, i) => el("circle", { class: "heat", cx: P[i].x, cy: P[i].y, fill: heatColor(times[i] / max) }, g));
  const lg = $("heatLegend");
  lg.hidden = false;
  lg.innerHTML = `Minutes from <b>${ST[src].name}</b><div class="bar" style="background:linear-gradient(90deg,${[0, 0.33, 0.66, 1].map(heatColor).join(",")})"></div>
    <div class="ticks">${[0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${Math.round(f * max)}</span>`).join("")}</div>`;
}
function toggleHeat() {
  if ($("heat").checked) drawHeat(); else { $("gHeat").innerHTML = ""; $("heatLegend").hidden = true; }
}

// ---------------- Init ----------------
function init() {
  $("stationList").innerHTML = ST.map((s) => `<option value="${s.name}">`).join("");
  $("netStats").innerHTML = `<div><b>${ST.length}</b>stations</div><div><b>${LINES.length}</b>lines</div><div><b>${G.interchanges.filter(Boolean).length}</b>interchanges</div><div><b>${Math.round(G.trackKm)} km</b>network</div>`;
  $("lineLegend").innerHTML = LINES.map((l) => `<span><i style="background:${l.color}"></i>${l.name}</span>`).join("");
  const examples = [["Kashmere Gate", "Botanical Garden"], ["IGI Airport", "Rajiv Chowk"], ["Samaypur Badli", "Noida City Center"], ["Dwarka Sector 21", "Noida Sector 62"], ["Majlis Park", "Hauz Khas"], ["Rithala", "Millennium City Centre Gurugram"]];
  $("examples").innerHTML = examples.map(([a, b]) => `<button data-a="${a}" data-b="${b}">${a} → ${b}</button>`).join("");
  $("examples").querySelectorAll("button").forEach((b) => (b.onclick = () => { $("fromInput").value = b.dataset.a; $("toInput").value = b.dataset.b; run(); }));
  document.querySelectorAll("#prefs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("#prefs button").forEach((x) => x.classList.toggle("active", x === b));
    state.pref = b.dataset.pref;
    if ($("fromInput").value && $("toInput").value) run();
  }));
  $("btnFind").onclick = run;
  $("btnSwap").onclick = () => { const a = $("fromInput").value; $("fromInput").value = $("toInput").value; $("toInput").value = a; if (a) run(); };
  ["fromInput", "toInput"].forEach((id) => $(id).addEventListener("keydown", (e) => e.key === "Enter" && run()));
  $("sunday").onchange = () => state.route && renderSummary();
  $("heat").onchange = toggleHeat;
  drawMap();
  initPanZoom();
  window.addEventListener("resize", () => { state.route ? fitTo(routeStations()) : setView({ ...state.base }); rescale(); });
}
init();
