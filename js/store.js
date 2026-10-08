// MetroMate — accounts, tickets, train cancellations and notifications.
//
// Demo storage: everything is kept in the browser's localStorage so the site
// stays a static website. Changes are broadcast to every open MetroMate tab
// (BroadcastChannel + storage events), so a cancellation made by the admin
// reaches a passenger's open tab instantly.

const DEMO_ACCOUNTS = [
  { id: "u_admin", name: "Metro Admin", email: "admin@metromate.in", password: "Admin@123", role: "admin" },
  { id: "u_rahul", name: "Rahul Sharma", email: "user@metromate.in", password: "User@123", role: "user" },
  { id: "u_priya", name: "Priya Verma", email: "priya@metromate.in", password: "User@123", role: "user" },
];
const REASONS = ["Technical fault", "Signal failure", "Track maintenance", "Security alert", "Heavy rain / waterlogging", "Power failure"];
const KEY = { users: "mm_users", tickets: "mm_tickets", dis: "mm_disruptions", notes: "mm_notifications", seeded: "mm_seeded_v1" };

const Store = {
  channel: "BroadcastChannel" in window ? new BroadcastChannel("metromate") : null,
  listeners: [],
  read(k, d = []) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  write(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  emit() { this.channel && this.channel.postMessage({ t: Date.now() }); this.listeners.forEach((f) => f()); },
  onChange(f) { this.listeners.push(f); },
};
if (Store.channel) Store.channel.onmessage = () => Store.listeners.forEach((f) => f());
window.addEventListener("storage", (e) => { if (e.key && e.key.startsWith("mm_")) Store.listeners.forEach((f) => f()); });

async function sha256(text) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0; return "x" + h; // very old browsers
}
const uid = (p) => p + Math.random().toString(36).slice(2, 8).toUpperCase();
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

// ---------------- Accounts ----------------
const Auth = {
  async seed() {
    if (localStorage.getItem(KEY.seeded)) return;
    const users = [];
    for (const a of DEMO_ACCOUNTS) users.push({ id: a.id, name: a.name, email: a.email, role: a.role, hash: await sha256(a.email + ":" + a.password) });
    Store.write(KEY.users, users);
    Store.write(KEY.tickets, []); Store.write(KEY.dis, []); Store.write(KEY.notes, []);
    localStorage.setItem(KEY.seeded, "1");
  },
  users() { return Store.read(KEY.users); },
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
    const users = this.users();
    if (users.some((u) => u.email === email)) throw new Error("An account with this email already exists.");
    const u = { id: uid("u_"), name: name.trim(), email, role: "user", hash: await sha256(email + ":" + password) };
    users.push(u); Store.write(KEY.users, users);
    sessionStorage.setItem("mm_session", u.id);
    return u;
  },
  logout() { sessionStorage.removeItem("mm_session"); },
};

// ---------------- Tickets ----------------
function journeyFrom(G, r) {
  const d = describeRoute(G, r);
  return {
    legs: d.legs.map((l) => (l.kind === "ride"
      ? { kind: "ride", line: l.line, from: l.from, to: l.to, towards: l.towards, stops: l.stops }
      : { kind: l.kind, at: l.at, to: l.to })),
    segments: routeSegments(G, r), km: +d.rideKm.toFixed(2), time: Math.round(d.time), changes: d.changes, stops: d.stops,
  };
}
const isSunday = (iso) => new Date(iso + "T00:00:00").getDay() === 0;

const Tickets = {
  all() { return Store.read(KEY.tickets); },
  save(list) { Store.write(KEY.tickets, list); },
  forUser(id) { return this.all().filter((t) => t.userId === id).sort((a, b) => b.createdAt - a.createdAt); },
  book(G, user, from, to, passengers, date, pref = "fastest") {
    const r = findRoute(G, from, to, pref);
    if (!r.found) throw new Error("No route is available right now because of cancelled trains.");
    const j = journeyFrom(G, r);
    const perHead = fareFor(j.km, isSunday(date));
    const t = {
      id: uid("MM"), userId: user.id, userName: user.name, from, to, passengers, date, ...j,
      fare: perHead * passengers, status: "Active", version: 1, createdAt: Date.now(),
      history: [{ at: Date.now(), text: "Ticket booked" }],
    };
    const list = this.all(); list.push(t); this.save(list);
    Store.emit();
    return t;
  },
  qrText(t) { return `METROMATE|${t.id}|${t.from}>${t.to}|${t.date}|P${t.passengers}|V${t.version}|${t.status}`; },
};

// ---------------- Notifications ----------------
const Notes = {
  all() { return Store.read(KEY.notes); },
  forUser(id) { return this.all().filter((n) => n.userId === id).sort((a, b) => b.at - a.at); },
  push(list, userId, title, body, ticketId) { list.push({ id: uid("N"), userId, title, body, ticketId, at: Date.now(), read: false }); },
  markRead(userId) { const l = this.all(); l.forEach((n) => { if (n.userId === userId) n.read = true; }); Store.write(KEY.notes, l); Store.emit(); },
};

// ---------------- Train cancellations (admin) ----------------
const Disruptions = {
  all() { return Store.read(KEY.dis); },
  active() { return this.all().filter((d) => d.active); },
  apply(G) { setBlocked(G, this.active()); },

  // Cancel trains on `line` between stop positions a..b, then re-route every affected ticket.
  cancel(G, admin, line, a, b, reason) {
    if (a > b) [a, b] = [b, a];
    if (a === b) throw new Error("Choose two different stations.");
    const L = METRO.lines[line];
    const d = { id: uid("D"), line, a, b, from: L.stops[a][0], to: L.stops[b][0], reason, by: admin.name, at: Date.now(), active: true, affected: [] };
    const list = this.all(); list.push(d); Store.write(KEY.dis, list);
    this.apply(G);
    const keys = new Set(); for (let p = a; p < b; p++) keys.add(line + ":" + p);
    const summary = this.reroute(G, (t) => t.segments.some((k) => keys.has(k)), d, false);
    const all = this.all(); const me = all.find((x) => x.id === d.id); me.affected = summary.ids; Store.write(KEY.dis, all);
    Store.emit();
    return summary;
  },

  restore(G, id) {
    const all = this.all(); const d = all.find((x) => x.id === id);
    if (!d || !d.active) return null;
    d.active = false; d.restoredAt = Date.now(); Store.write(KEY.dis, all);
    this.apply(G);
    const ids = new Set(d.affected || []);
    const summary = this.reroute(G, (t) => ids.has(t.id) && t.status !== "Cancelled", d, true);
    Store.emit();
    return summary;
  },

  // Re-plan the matching tickets with the current network and notify the passengers.
  reroute(G, match, d, restoring) {
    const tickets = Tickets.all(), notes = Notes.all();
    const L = METRO.lines[d.line], st = (i) => METRO.stations[i].name;
    const section = `${L.name} between ${st(d.from)} and ${st(d.to)}`;
    const out = { rerouted: 0, cancelled: 0, notified: 0, ids: [] };
    for (const t of tickets) {
      if (t.status === "Cancelled" || t.date < todayISO() || !match(t)) continue;
      out.ids.push(t.id);
      const r = findRoute(G, t.from, t.to, "fastest");
      if (!r.found) {
        t.status = "Cancelled"; t.version++;
        t.history.push({ at: Date.now(), text: `Trains cancelled on ${section}. No other route — ₹${t.fare} refunded.` });
        Notes.push(notes, t.userId, `Ticket ${t.id} cancelled`, `Trains on the ${section} are cancelled (${d.reason}) and there is no other route for ${st(t.from)} → ${st(t.to)}. ₹${t.fare} will be refunded to your original payment method.`, t.id);
        out.cancelled++; out.notified++; continue;
      }
      const j = journeyFrom(G, r);
      const newFare = fareFor(j.km, isSunday(t.date)) * t.passengers;
      const via = j.legs.filter((l) => l.kind === "ride").map((l) => METRO.lines[l.line].name).join(" → ");
      Object.assign(t, j);
      t.version++;
      let money = "";
      if (newFare < t.fare) { money = ` ₹${t.fare - newFare} refunded.`; t.fare = newFare; }
      else if (newFare > t.fare) money = " No extra charge.";
      if (restoring) {
        t.status = "Active";
        t.history.push({ at: Date.now(), text: `Service restored on ${section}. Back on the normal route.` });
        Notes.push(notes, t.userId, `Service restored · ${t.id}`, `Trains are running again on the ${section}. Your ticket ${st(t.from)} → ${st(t.to)} is back on the usual route (${via}, about ${j.time} min). Your QR code has been updated.`, t.id);
      } else {
        t.status = "Rerouted";
        t.history.push({ at: Date.now(), text: `Trains cancelled on ${section} (${d.reason}). Re-routed via ${via}.${money}` });
        Notes.push(notes, t.userId, `Train cancelled · ticket ${t.id} re-routed`, `Trains on the ${section} are cancelled (${d.reason}). Your journey ${st(t.from)} → ${st(t.to)} now goes via ${via} and takes about ${j.time} min.${money} Your QR code has been updated.`, t.id);
      }
      out.rerouted++; out.notified++;
    }
    Tickets.save(tickets); Store.write(KEY.notes, notes);
    return out;
  },
};
