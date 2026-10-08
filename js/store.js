// MetroMate — accounts, tickets, check-in, train cancellations and notifications.
//
// Every action (register, book, check in, end journey, cancel trains, restore
// service) is an *event* published to a shared live feed (ntfy.sh, a free
// publish/subscribe service). Every open MetroMate page — on any device —
// receives each event instantly over Server-Sent Events, stores it locally and
// replays the full event list to rebuild the same state: tickets, re-routes and
// notifications. If the feed cannot be reached, events stay in this browser and
// are shared between its tabs only.

// ?feed=<name> switches to a separate test feed (handy for trying things without touching the demo data)
const FEED_PARAM = new URLSearchParams(location.search).get("feed");
const FEED = window.MM_FEED || "https://ntfy.sh/" + (FEED_PARAM && /^[\w-]{6,64}$/.test(FEED_PARAM) ? FEED_PARAM : "metromate-dmrc-live-7k3p9x");
const EVENTS_KEY = "mm_events_v2:" + FEED;
const READ_KEY = "mm_read_v2";

const DEMO_ACCOUNTS = [
  { id: "u_admin", name: "Metro Admin", email: "admin@metromate.in", role: "admin", hash: "b449fbb7333d1d87e90b347370fe043244169402a399aa1266977abd5c8edf76" },
  { id: "u_rahul", name: "Rahul Sharma", email: "user@metromate.in", role: "user", hash: "b5d3564f40ff88645d8c4041c26d5bf3ab45a68bbd4b66f62c36420750e141a5" },
  { id: "u_priya", name: "Priya Verma", email: "priya@metromate.in", role: "user", hash: "632d67efcd0169c034bb0f66e3629f328b0268d775fc7b99ac78f2514635410f" },
];
const REASONS = ["Technical fault", "Signal failure", "Track maintenance", "Security alert", "Heavy rain / waterlogging", "Power failure"];

const uid = (p) => p + Math.random().toString(36).slice(2, 8).toUpperCase();
const isoOf = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const todayISO = () => isoOf(Date.now());
const isSunday = (iso) => new Date(iso + "T00:00:00").getDay() === 0;
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ======================= Live event feed =======================
const Live = {
  events: [], keys: new Set(), online: false, listeners: [], es: null,
  channel: "BroadcastChannel" in window ? new BroadcastChannel("metromate:" + FEED) : null,
  state: null,

  init() {
    try { this.events = JSON.parse(localStorage.getItem(EVENTS_KEY)) || []; } catch { this.events = []; }
    this.events.forEach((e) => this.keys.add(e.p.eid));
    if (this.channel) this.channel.onmessage = (m) => this.merge(m.data || [], false);
    window.addEventListener("storage", (e) => { if (e.key === EVENTS_KEY) { try { this.merge(JSON.parse(e.newValue) || [], false); } catch { /* ignore */ } } });
    this.rebuild();
    this.connect();
    setInterval(() => this.poll(), 20000); // safety net if the live stream drops
  },
  onChange(f) { this.listeners.push(f); },
  emit() { this.listeners.forEach((f) => f()); },

  parse(msg) {
    try { const p = JSON.parse(msg.message); return p && p.k && p.eid ? { id: msg.id, p } : null; } catch { return null; }
  },
  merge(list, share = true) {
    let added = 0;
    for (const e of list) if (e && !this.keys.has(e.p.eid)) { this.keys.add(e.p.eid); this.events.push(e); added++; }
    if (!added) return 0;
    try { localStorage.setItem(EVENTS_KEY, JSON.stringify(this.events.slice(-3000))); } catch { /* storage full */ }
    if (share && this.channel) this.channel.postMessage(list);
    this.rebuild(); this.emit();
    return added;
  },
  async poll() {
    try {
      const r = await fetch(FEED + "/json?poll=1&since=all", { cache: "no-store" });
      const text = await r.text();
      this.setOnline(true);
      this.merge(text.split("\n").filter(Boolean).map((l) => { try { return this.parse(JSON.parse(l)); } catch { return null; } }));
    } catch { this.setOnline(false); }
  },
  async connect() {
    await this.poll();
    if (this.es) this.es.close();
    try {
      this.es = new EventSource(FEED + "/sse");
      this.es.onopen = () => this.setOnline(true);
      this.es.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.event === "message") this.merge([this.parse(d)]);
      };
      this.es.onerror = () => { this.setOnline(false); this.es.close(); setTimeout(() => this.connect(), 4000); };
    } catch { this.setOnline(false); }
  },
  setOnline(v) { if (this.online !== v) { this.online = v; this.emit(); } },

  async publish(payload) {
    const p = { ...payload, eid: uid("E"), at: Date.now() };
    try {
      const r = await fetch(FEED, { method: "POST", body: JSON.stringify(p) });
      if (!r.ok) throw new Error("feed " + r.status);
      const msg = await r.json();
      this.setOnline(true);
      this.merge([{ id: msg.id, p }]);
    } catch {
      this.setOnline(false);
      this.merge([{ id: "local-" + p.eid, p }]); // offline: this browser only
    }
    return p;
  },

  rebuild() { this.state = replay(this.events); },
};

// ======================= Replay (rebuild state from events) =======================
function journeyFrom(r) {
  const d = describeRoute(G, r);
  const steps = r.edges.map((e, i) => ({
    from: G.nodes[r.path[i]].station, to: G.nodes[r.path[i + 1]].station, time: e.time,
    seg: e.type === "ride" ? e.line + ":" + Math.min(G.nodes[r.path[i]].pos, G.nodes[r.path[i + 1]].pos) : null,
  }));
  return {
    legs: d.legs.map((l) => (l.kind === "ride"
      ? { kind: "ride", line: l.line, from: l.from, to: l.to, towards: l.towards, stops: l.stops }
      : { kind: l.kind, at: l.at, to: l.to })),
    steps, km: +d.rideKm.toFixed(2), time: Math.round(d.time), changes: d.changes, stops: d.stops,
  };
}

// index of the next step not yet completed, `now` minutes after check-in
function stepIndexAt(t, now) {
  let elapsed = (now - t.checkInAt) / 60000, i = 0;
  while (i < t.steps.length && elapsed >= t.steps[i].time) { elapsed -= t.steps[i].time; i++; }
  return i;
}
function positionAt(t, now) {
  const i = stepIndexAt(t, now);
  return { index: i, station: i < t.steps.length ? t.steps[i].from : t.to, arrived: i >= t.steps.length };
}

function replay(events) {
  const S = { users: DEMO_ACCOUNTS.map((u) => ({ ...u })), tickets: [], byId: {}, dis: [], notes: [] };
  const st = (i) => METRO.stations[i].name;
  const block = () => setBlocked(G, S.dis.filter((d) => d.active));
  const note = (p, t, title, body, did) => S.notes.push({ id: p.eid + ":" + t.id, uid: t.uid, title, body, at: p.at, ticketId: t.id, did });
  block();

  // re-plan ticket t from its current point; returns true when notified
  function replan(t, p, d, restoring) {
    const travelling = t.phase === "travelling";
    const pos = travelling ? positionAt(t, p.at) : { station: t.start, index: 0, arrived: false };
    if (pos.arrived) return false;
    const section = `${METRO.lines[d.line].name} between ${st(d.from)} and ${st(d.to)}`;
    if (!restoring) {
      const keys = new Set(); for (let q = d.a; q < d.b; q++) keys.add(d.line + ":" + q);
      if (!t.steps.slice(pos.index).some((s) => s.seg && keys.has(s.seg))) return false;
      d.affected.push(t.id);
    }
    const r = findRoute(G, pos.station, t.to, "fastest");
    if (!r.found) {
      t.status = "Cancelled"; t.version++;
      if (travelling) { t.phase = "completed"; t.endAt = p.at; }
      t.history.push({ at: p.at, text: `Trains cancelled on ${section}. No other route${travelling ? " from " + st(pos.station) : ""} — ₹${t.fare} refunded.` });
      note(p, t, `Ticket ${t.id} cancelled`, `Trains on the ${section} are cancelled (${d.reason}) and there is no other route ${travelling ? "from " + st(pos.station) : "for " + st(t.from) + " → " + st(t.to)}. ₹${t.fare} will be refunded.`, d.id);
      return true;
    }
    const j = journeyFrom(r);
    const via = j.legs.filter((l) => l.kind === "ride").map((l) => METRO.lines[l.line].name).join(" → ");
    let money = "";
    if (!travelling) {
      const newFare = fareFor(j.km, isSunday(t.date)) * t.pax;
      if (newFare < t.fare) { money = ` ₹${t.fare - newFare} refunded.`; t.fare = newFare; }
      else if (newFare > t.fare) money = " No extra charge.";
    }
    Object.assign(t, j);
    t.start = pos.station;
    if (travelling) t.checkInAt = p.at; // journey continues from the current station
    t.version++;
    const where = travelling ? `from ${st(pos.station)} ` : "";
    if (restoring) {
      t.status = "Active";
      t.history.push({ at: p.at, text: `Service restored on ${section}. Back on the normal route ${where}(${via}).` });
      note(p, t, `Service restored · ${t.id}`, `Trains are running again on the ${section}. Your journey ${where}to ${st(t.to)} is back on the usual route: ${via}, about ${j.time} min. QR code updated.`, d.id);
    } else {
      t.status = "Rerouted";
      t.history.push({ at: p.at, text: `Trains cancelled on ${section} (${d.reason}). Re-routed ${where}via ${via}.${money}` });
      note(p, t, travelling ? `Journey re-routed · ${t.id}` : `Train cancelled · ticket ${t.id} re-routed`,
        `Trains on the ${section} are cancelled (${d.reason}). ${travelling ? `You are near ${st(pos.station)}. Continue` : `Your journey ${st(t.from)} → ${st(t.to)} now goes`} via ${via} — about ${j.time} min.${money} Your QR code has been updated.`, d.id);
    }
    return true;
  }

  for (const { p } of events) {
    switch (p.k) {
      case "reg":
        if (!S.users.some((u) => u.email === p.email)) S.users.push({ id: p.uid, name: p.name, email: p.email, role: "user", hash: p.hash });
        break;
      case "book": {
        if (S.byId[p.tid]) break;
        const r = findRoute(G, p.from, p.to, p.pref || "fastest");
        const t = { id: p.tid, uid: p.uid, uname: p.uname, from: p.from, to: p.to, start: p.from, pax: p.pax, date: p.date, pref: p.pref,
          phase: "booked", status: "Active", version: 1, createdAt: p.at, history: [{ at: p.at, text: "Ticket booked" }] };
        if (!r.found) { Object.assign(t, { legs: [], steps: [], km: 0, time: 0, changes: 0, stops: 0, fare: 0, status: "Cancelled" }); t.history.push({ at: p.at, text: "No route available at booking time." }); }
        else { Object.assign(t, journeyFrom(r)); t.fare = fareFor(t.km, isSunday(p.date)) * p.pax; }
        S.tickets.push(t); S.byId[t.id] = t;
        break;
      }
      case "checkin": {
        const t = S.byId[p.tid];
        if (!t || t.phase !== "booked" || t.status === "Cancelled") break;
        t.phase = "travelling"; t.checkInAt = p.at;
        t.history.push({ at: p.at, text: `Checked in at ${st(t.start)} — journey started.` });
        break;
      }
      case "end": {
        const t = S.byId[p.tid];
        if (!t || t.phase !== "travelling") break;
        t.phase = "completed"; t.endAt = p.at;
        t.history.push({ at: p.at, text: `Journey completed at ${st(t.to)}.` });
        break;
      }
      case "cancel": {
        if (S.dis.some((d) => d.id === p.did)) break;
        const L = METRO.lines[p.line];
        const d = { id: p.did, line: p.line, a: p.a, b: p.b, from: L.stops[p.a][0], to: L.stops[p.b][0], reason: p.reason, by: p.by, at: p.at, active: true, affected: [] };
        S.dis.push(d); block();
        const day = isoOf(p.at);
        for (const t of S.tickets) {
          if (t.status === "Cancelled" || t.phase === "completed" || t.date < day) continue;
          replan(t, p, d, false);
        }
        break;
      }
      case "restore": {
        const d = S.dis.find((x) => x.id === p.did);
        if (!d || !d.active) break;
        d.active = false; d.restoredAt = p.at; block();
        for (const id of d.affected) {
          const t = S.byId[id];
          if (t && t.status !== "Cancelled" && t.phase !== "completed") replan(t, p, d, true);
        }
        break;
      }
    }
  }
  block();
  return S;
}

// ======================= Public API used by the UI =======================
const Auth = {
  users() { return Live.state.users; },
  current() { const id = sessionStorage.getItem("mm_session"); return this.users().find((u) => u.id === id) || null; },
  async login(email, password) {
    email = email.trim().toLowerCase();
    const u = this.users().find((x) => x.email === email);
    if (!u || u.hash !== (await sha256(email + ":" + password))) throw new Error("Wrong email or password.");
    sessionStorage.setItem("mm_session", u.id);
    return u;
  },
  async register(name, email, password) {
    email = email.trim().toLowerCase();
    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter your name and a valid email.");
    if (password.length < 6) throw new Error("Password must be at least 6 characters.");
    if (this.users().some((u) => u.email === email)) throw new Error("An account with this email already exists.");
    const id = uid("u_");
    await Live.publish({ k: "reg", uid: id, name: name.trim(), email, hash: await sha256(email + ":" + password) });
    sessionStorage.setItem("mm_session", id);
    return this.users().find((u) => u.id === id);
  },
  logout() { sessionStorage.removeItem("mm_session"); },
};

const Tickets = {
  all() { return Live.state.tickets; },
  get(id) { return Live.state.byId[id]; },
  forUser(id) { return this.all().filter((t) => t.uid === id).sort((a, b) => b.createdAt - a.createdAt); },
  async book(user, from, to, pax, date, pref) {
    if (!findRoute(G, from, to, pref).found) throw new Error("No route is available right now because of cancelled trains.");
    const tid = uid("MM");
    await Live.publish({ k: "book", tid, uid: user.id, uname: user.name, from, to, pax, date, pref });
    return this.get(tid);
  },
  async checkIn(t) {
    if (t.date !== todayISO()) throw new Error("You can check in only on the travel date.");
    await Live.publish({ k: "checkin", tid: t.id });
  },
  async end(t) { await Live.publish({ k: "end", tid: t.id }); },
  qrText(t) { return `METROMATE|${t.id}|${t.start}>${t.to}|${t.date}|P${t.pax}|V${t.version}|${t.status}|${t.phase}`; },
};

const Notes = {
  forUser(id) { return Live.state.notes.filter((n) => n.uid === id).sort((a, b) => b.at - a.at); },
  all() { return Live.state.notes.slice().sort((a, b) => b.at - a.at); },
  readSet() { try { return new Set(JSON.parse(localStorage.getItem(READ_KEY)) || []); } catch { return new Set(); } },
  markRead(ids) { const s = this.readSet(); ids.forEach((i) => s.add(i)); localStorage.setItem(READ_KEY, JSON.stringify([...s].slice(-2000))); },
};

const Disruptions = {
  all() { return Live.state.dis; },
  active() { return Live.state.dis.filter((d) => d.active); },
  apply() { setBlocked(G, this.active()); },
  async cancel(admin, line, a, b, reason) {
    if (a > b) [a, b] = [b, a];
    if (a === b) throw new Error("Choose two different stations.");
    const did = uid("D");
    await Live.publish({ k: "cancel", did, line, a, b, reason, by: admin.name });
    return this.summary(did);
  },
  async restore(did) { await Live.publish({ k: "restore", did }); return this.summary(did, true); },
  summary(did, restoring) {
    const d = Live.state.dis.find((x) => x.id === did);
    const notes = Live.state.notes.filter((n) => n.did === did && (restoring ? n.title.startsWith("Service restored") : !n.title.startsWith("Service restored")));
    const cancelled = notes.filter((n) => n.title.includes("cancelled") && n.title.startsWith("Ticket")).length;
    return { notified: notes.length, cancelled, rerouted: notes.length - cancelled, affected: d ? d.affected.length : 0 };
  },
};
