// MetroMate — graph model and route-finding algorithms
//
// Graph: one node per (station, line). Riding between neighbouring stops is a
// "ride" edge; changing line inside a station is a "transfer" edge; a few
// interchanges joined by a walkway are "walk" edges.

const MIN_PER_KM = 1.9;          // average speed ≈ 32 km/h on regular lines
const MIN_PER_KM_EXPRESS = 1.1;  // Airport Express ≈ 55 km/h
const DWELL_MIN = 0.5;           // stop time at every station
const TRANSFER_MIN = 5;          // change of line inside a station
const WALK_MIN = 8;              // walkway interchange between two stations

function haversineKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function buildGraph(data) {
  const nodes = [];               // { station, line, pos }
  const stationNodes = data.stations.map(() => []);
  data.lines.forEach((line, li) => line.stops.forEach(([s], pos) => {
    stationNodes[s].push(nodes.length);
    nodes.push({ station: s, line: li, pos });
  }));
  const adj = nodes.map(() => []);
  const link = (a, b, e) => { adj[a].push({ to: b, ...e }); adj[b].push({ to: a, ...e }); };
  let id = 0, rideEdges = 0;
  data.lines.forEach((line, li) => {
    const base = id;
    for (let p = 1; p < line.stops.length; p++) {
      const km = Math.abs(line.stops[p][1] - line.stops[p - 1][1]);
      const time = km * (line.express ? MIN_PER_KM_EXPRESS : MIN_PER_KM) + DWELL_MIN;
      link(base + p - 1, base + p, { type: "ride", line: li, km, time });
      rideEdges++;
    }
    id += line.stops.length;
  });
  let transfers = 0;
  stationNodes.forEach((list) => {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) { link(list[i], list[j], { type: "transfer", km: 0, time: TRANSFER_MIN }); transfers++; }
  });
  data.walkways.forEach(([a, b]) => {
    const km = haversineKm(data.stations[a], data.stations[b]);
    stationNodes[a].forEach((x) => stationNodes[b].forEach((y) => link(x, y, { type: "walk", km: 0, walkKm: km, time: WALK_MIN })));
  });
  const interchanges = stationNodes.map((l, s) => l.length > 1 || data.walkways.some((w) => w.includes(s)));
  const trackKm = data.lines.reduce((s, l) => s + (l.stops[l.stops.length - 1][1] - l.stops[0][1]), 0);
  return { data, nodes, adj, stationNodes, interchanges, rideEdges, transfers, trackKm };
}

// ---------- Binary min-heap (priority queue) ----------
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, key) {
    const a = this.a; a.push({ item, key });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].key <= a[i].key) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].key < a[m].key) m = l;
        if (r < a.length && a[r].key < a[m].key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// Edge weight for each route preference
const PREFERENCES = {
  fastest: { label: "Fastest", algo: "Dijkstra", weight: (e) => e.time },
  shortest: { label: "Shortest distance", algo: "Dijkstra", weight: (e) => (e.type === "ride" ? e.km : 0.001) },
  changes: { label: "Fewest changes", algo: "Dijkstra (lexicographic)", weight: (e) => (e.type === "ride" ? e.time : 1000 + e.time) },
  stops: { label: "Fewest stops", algo: "0-1 BFS", weight: (e) => (e.type === "ride" ? 1 : 0) },
};

// Dijkstra / A* from every node of station `src` to any node of station `dst`.
function dijkstra(G, src, dst, weight, heuristic = null) {
  const t0 = performance.now();
  const n = G.nodes.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), prevEdge = new Array(n);
  const done = new Uint8Array(n);
  const pq = new MinHeap();
  const explored = [];
  let relaxations = 0, pushes = 0;
  const h = heuristic || (() => 0);
  for (const v of G.stationNodes[src]) { dist[v] = 0; pq.push(v, h(v)); pushes++; }
  let goal = -1;
  while (pq.size) {
    const { item: v } = pq.pop();
    if (done[v]) continue;
    done[v] = 1;
    explored.push(v);
    if (G.nodes[v].station === dst) { goal = v; break; }
    for (const e of G.adj[v]) {
      relaxations++;
      const nd = dist[v] + weight(e);
      if (nd < dist[e.to]) {
        dist[e.to] = nd; prev[e.to] = v; prevEdge[e.to] = e;
        pq.push(e.to, nd + h(e.to)); pushes++;
      }
    }
  }
  return finishSearch(G, goal, dist, prev, prevEdge, explored, { relaxations, pushes, ms: performance.now() - t0 });
}

// 0-1 BFS with a deque: ride edges cost 1 stop, transfers cost 0.
function zeroOneBfs(G, src, dst) {
  const t0 = performance.now();
  const n = G.nodes.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), prevEdge = new Array(n);
  const done = new Uint8Array(n);
  const dq = new Array(2 * n + 8);
  let head = n + 4, tail = n + 4; // deque inside a fixed array
  const explored = [];
  let relaxations = 0, pushes = 0;
  for (const v of G.stationNodes[src]) { dist[v] = 0; dq[tail++] = v; pushes++; }
  let goal = -1;
  while (head < tail) {
    const v = dq[head++];
    if (done[v]) continue;
    done[v] = 1; explored.push(v);
    if (G.nodes[v].station === dst) { goal = v; break; }
    for (const e of G.adj[v]) {
      relaxations++;
      const w = e.type === "ride" ? 1 : 0;
      if (dist[v] + w < dist[e.to]) {
        dist[e.to] = dist[v] + w; prev[e.to] = v; prevEdge[e.to] = e; pushes++;
        if (w === 0) dq[--head] = e.to; else dq[tail++] = e.to;
      }
    }
  }
  return finishSearch(G, goal, dist, prev, prevEdge, explored, { relaxations, pushes, ms: performance.now() - t0 });
}

// A* for the fastest route: straight-line distance × fastest possible pace never overestimates.
function aStar(G, src, dst) {
  const target = G.data.stations[dst];
  const h = (v) => haversineKm(G.data.stations[G.nodes[v].station], target) * MIN_PER_KM_EXPRESS * 0.9;
  return dijkstra(G, src, dst, PREFERENCES.fastest.weight, h);
}

function finishSearch(G, goal, dist, prev, prevEdge, explored, stats) {
  if (goal < 0) return { found: false, explored, stats };
  const path = [], edges = [];
  for (let v = goal; v !== -1; v = prev[v]) { path.push(v); if (prevEdge[v]) edges.push(prevEdge[v]); }
  path.reverse(); edges.reverse();
  // drop leading transfers inside the origin station
  while (edges.length && edges[0].type === "transfer") { edges.shift(); path.shift(); }
  const exploredStations = [...new Set(explored.map((v) => G.nodes[v].station))];
  return { found: true, path, edges, cost: dist[goal], explored, exploredStations, stats: { ...stats, settled: explored.length } };
}

function findRoute(G, src, dst, pref) {
  if (pref === "stops") return zeroOneBfs(G, src, dst);
  return dijkstra(G, src, dst, PREFERENCES[pref].weight);
}

// Single-source Dijkstra over everything: minutes to every station (isochrone map)
function travelTimesFrom(G, src) {
  const n = G.nodes.length, dist = new Float64Array(n).fill(Infinity), pq = new MinHeap();
  for (const v of G.stationNodes[src]) { dist[v] = 0; pq.push(v, 0); }
  while (pq.size) {
    const { item: v, key } = pq.pop();
    if (key > dist[v]) continue;
    for (const e of G.adj[v]) if (key + e.time < dist[e.to]) { dist[e.to] = key + e.time; pq.push(e.to, dist[e.to]); }
  }
  return G.stationNodes.map((list) => Math.min(...list.map((v) => dist[v])));
}

// ---------- Turn a node path into journey legs ----------
function describeRoute(G, r) {
  const { data } = G;
  const legs = [];
  let rideKm = 0, time = 0, changes = 0, stops = 0;
  for (let i = 0; i < r.edges.length; i++) {
    const e = r.edges[i], from = G.nodes[r.path[i]], to = G.nodes[r.path[i + 1]];
    time += e.time;
    if (e.type === "ride") {
      rideKm += e.km; stops++;
      const last = legs[legs.length - 1];
      if (last && last.kind === "ride" && last.line === e.line) {
        last.to = to.station; last.stops++; last.km += e.km; last.time += e.time; last.stations.push(to.station);
      } else {
        const line = data.lines[e.line];
        const forward = to.pos > from.pos;
        const terminal = forward ? line.stops[line.stops.length - 1][0] : line.stops[0][0];
        legs.push({ kind: "ride", line: e.line, from: from.station, to: to.station, stops: 1, km: e.km, time: e.time, towards: terminal, stations: [from.station, to.station] });
      }
    } else {
      changes++;
      legs.push({ kind: e.type, at: from.station, to: to.station, time: e.time, walkKm: e.walkKm || 0 });
    }
  }
  return { legs, rideKm, time, changes, stops };
}

// DMRC distance-based fare slabs (revised 25 Aug 2025)
const FARE_SLABS = [
  { upto: 2, week: 11, sun: 11 }, { upto: 5, week: 21, sun: 11 }, { upto: 12, week: 32, sun: 21 },
  { upto: 21, week: 43, sun: 32 }, { upto: 32, week: 54, sun: 43 }, { upto: Infinity, week: 64, sun: 54 },
];
function fareFor(km, sunday) {
  const s = FARE_SLABS.find((x) => km <= x.upto);
  return sunday ? s.sun : s.week;
}
