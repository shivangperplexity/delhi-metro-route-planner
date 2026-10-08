// MetroMate — accounts, QR tickets, check-in, admin console and live notifications (UI)

const Portal = { user: null, toasted: new Set(), pending: null };
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const fmtTime = (ms) => new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtClock = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
const linePill = (li) => `<span class="linepill" style="background:${LINES[li].color}">${LINES[li].name}</span>`;
const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PHASE = { booked: "Not started", travelling: "On journey", completed: "Completed" };

// ---------------- Toasts & system notifications ----------------
function toast(title, body, kind = "info", ms = 8000) {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.innerHTML = `<b>${escH(title)}</b>${body ? `<p>${escH(body)}</p>` : ""}<button aria-label="Dismiss">×</button>`;
  t.querySelector("button").onclick = () => t.remove();
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function systemNotify(n) {
  try { if ("Notification" in window && Notification.permission === "granted") new Notification(n.title, { body: n.body, tag: n.id }); } catch { /* ignore */ }
}
async function busy(btn, fn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Please wait…";
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}

// ---------------- Header, views ----------------
function renderHeader() {
  const u = Portal.user;
  $("btnLogin").hidden = !!u;
  $("meBox").hidden = !u;
  $("bellWrap").hidden = !u || u.role !== "user";
  document.querySelectorAll("#mainNav [data-role]").forEach((a) => (a.hidden = !u || a.dataset.role !== u.role));
  if (u) {
    $("meName").textContent = u.name;
    $("meRole").textContent = u.role === "admin" ? "Administrator" : "Passenger";
    $("meAvatar").textContent = u.name.split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase();
    $("meAvatar").className = "avatar" + (u.role === "admin" ? " adm" : "");
  }
  const live = $("liveDot");
  live.className = "live " + (Live.online ? "on" : "off");
  live.title = Live.online ? "Connected: updates reach every device instantly" : "Offline: changes are kept in this browser only";
  live.querySelector("span").textContent = Live.online ? "Live" : "Offline";
  renderBell();
}

function showView() {
  const h = location.hash.replace(/^#\/?/, "") || "planner";
  let view = ["tickets", "admin"].includes(h) ? h : "planner";
  const u = Portal.user;
  if (view === "tickets" && (!u || u.role !== "user")) { view = "planner"; if (!u) openLogin(); }
  if (view === "admin" && (!u || u.role !== "admin")) { view = "planner"; if (!u) openLogin(); }
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
  document.querySelectorAll("#mainNav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  if (view === "tickets") renderTickets();
  if (view === "admin") renderAdmin();
  if (view === "planner") requestAnimationFrame(() => { rescale(); if (state.route) quietRun(); });
}

// ---------------- Login / register ----------------
let loginMode = "login";
function openLogin(pending) {
  if (pending) Portal.pending = pending;
  $("loginModal").hidden = false;
  $("lgErr").hidden = true;
  setTimeout(() => $("lgEmail").focus(), 50);
}
function setLoginMode(m) {
  loginMode = m;
  document.querySelectorAll("#loginModal .tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === m));
  document.querySelectorAll(".reg-only").forEach((x) => (x.hidden = m !== "register"));
  $("lgSubmit").textContent = m === "register" ? "Create account" : "Log in";
}
async function submitLogin(e) {
  e.preventDefault();
  try {
    const u = await busy($("lgSubmit"), () => (loginMode === "register"
      ? Auth.register($("lgName").value, $("lgEmail").value, $("lgPass").value)
      : Auth.login($("lgEmail").value, $("lgPass").value)));
    afterLogin(u);
  } catch (err) { $("lgErr").hidden = false; $("lgErr").textContent = err.message; }
}
function afterLogin(u) {
  Portal.user = u; Portal.toasted = new Set();
  $("loginModal").hidden = true;
  $("loginForm").reset();
  if (u.role === "user" && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  toast(`Welcome, ${u.name.split(" ")[0]}`, u.role === "admin" ? "You are signed in as administrator." : "You can book QR tickets and check in to start a journey.", "ok", 3500);
  renderHeader();
  deliverNotifications(true);
  const p = Portal.pending; Portal.pending = null;
  if (u.role === "admin") location.hash = "#/admin";
  else if (p === "book") bookTicket();
  else showView();
}
function logout() {
  Auth.logout(); Portal.user = null; Portal.toasted = new Set();
  $("notesPanel").hidden = true;
  renderHeader(); location.hash = "#/"; showView();
}

// ---------------- Notifications ----------------
function unreadFor(u) { const read = Notes.readSet(); return Notes.forUser(u.id).filter((n) => !read.has(n.id)); }
function renderBell() {
  const u = Portal.user;
  if (!u || u.role !== "user") return;
  const notes = Notes.forUser(u.id), read = Notes.readSet();
  const unread = notes.filter((n) => !read.has(n.id)).length;
  $("bellCount").hidden = !unread; $("bellCount").textContent = unread;
  $("notesList").innerHTML = notes.slice(0, 25).map((n) => `<li class="${read.has(n.id) ? "" : "unread"}"><b>${escH(n.title)}</b><p>${escH(n.body)}</p><small>${fmtTime(n.at)}</small></li>`).join("")
    || '<li class="empty">No notifications yet.</li>';
}
// Pop up every unread notification of the logged-in passenger that has not been shown in this tab yet.
function deliverNotifications(onLogin) {
  const u = Portal.user;
  if (!u || u.role !== "user") return;
  const fresh = unreadFor(u).filter((n) => !Portal.toasted.has(n.id));
  fresh.forEach((n) => Portal.toasted.add(n.id));
  if (onLogin && fresh.length > 3) toast(`You have ${fresh.length} new notifications`, "Open the bell to read them all.", "warn", 10000);
  fresh.slice(0, 3).reverse().forEach((n) => {
    toast(n.title, n.body, n.title.startsWith("Service restored") ? "ok" : "warn", 15000);
    systemNotify(n);
  });
}

// ---------------- Booking ----------------
async function bookTicket() {
  const u = Portal.user;
  if (!u) return openLogin("book");
  if (u.role !== "user") return toast("Log in as a passenger to book", "Admin accounts cannot book tickets.", "warn");
  if (!state.route) return toast("Find a route first", "", "warn");
  try {
    const t = await busy($("btnBook"), () => Tickets.book(u, state.from, state.to, +$("bkPax").value, $("bkDate").value || todayISO(), state.pref));
    showQR(t, true);
  } catch (err) { toast("Booking failed", err.message, "bad"); }
}

function qrSvg(t, cell = 4) {
  const q = qrcode(0, "M");
  q.addData(Tickets.qrText(t)); q.make();
  return q.createSvgTag(cell, 2);
}
function legsHtml(t) {
  return t.legs.map((l) => (l.kind === "ride"
    ? `<li>${linePill(l.line)} ${escH(ST[l.from].name)} → ${escH(ST[l.to].name)} <span class="muted">· ${l.stops} stop${l.stops > 1 ? "s" : ""}</span></li>`
    : `<li class="chg">${l.kind === "walk" ? `Walk ${escH(ST[l.at].name)} → ${escH(ST[l.to].name)}` : `Change at ${escH(ST[l.at].name)}`}</li>`)).join("");
}
function statusPills(t) {
  let s = `<span class="status ${t.status.toLowerCase()}">${t.status === "Rerouted" ? "Re-routed" : t.status}</span>`;
  if (t.status !== "Cancelled") s += `<span class="status ph-${t.phase}">${PHASE[t.phase]}</span>`;
  return s;
}
function showQR(t, fresh) {
  const cancelled = t.status === "Cancelled";
  $("qrBody").innerHTML = `${fresh ? '<div class="booked-msg">✓ Ticket booked</div>' : ""}
    <div class="qr-big ${cancelled ? "void" : ""}">${qrSvg(t, 6)}${cancelled ? "<span>VOID</span>" : ""}</div>
    <div class="qr-id">${t.id} ${statusPills(t)}</div>
    <div class="qr-route"><b>${escH(ST[t.start].name)}</b> → <b>${escH(ST[t.to].name)}</b></div>
    <div class="muted">${fmtDate(t.date)} · ${t.pax} passenger${t.pax > 1 ? "s" : ""} · ₹${t.fare} · about ${t.time} min</div>
    <ol class="legs">${legsHtml(t)}</ol>
    ${fresh ? '<a class="btn primary wide" href="#/tickets" data-close>View my tickets</a>' : ""}`;
  $("qrModal").hidden = false;
}

// ---------------- My tickets ----------------
function journeyBox(t) {
  const today = todayISO();
  if (t.status === "Cancelled") return "";
  if (t.phase === "completed") return `<div class="jbox done">✓ Journey completed${t.endAt ? " at " + fmtClock(t.endAt) : ""}</div>`;
  if (t.phase === "travelling") {
    const pos = positionAt(t, Date.now());
    const total = t.steps.reduce((s, x) => s + x.time, 0) || 1;
    const done = Math.min(1, (Date.now() - t.checkInAt) / 60000 / total);
    const eta = t.checkInAt + total * 60000;
    return `<div class="jbox live"><div class="jrow"><b>● On journey</b><span>${pos.arrived ? "Arrived at " + escH(ST[t.to].name) : "Now near <b>" + escH(ST[pos.station].name) + "</b>"} · arrives ~${fmtClock(eta)}</span></div>
      <div class="jbar"><i style="width:${(done * 100).toFixed(1)}%"></i></div>
      <button class="btn small" data-end="${t.id}">End journey</button></div>`;
  }
  if (t.date === today) return `<div class="jbox"><span>Ready to travel. Check in at the gate to start your journey.</span><button class="btn go small" data-checkin="${t.id}">Check in · start journey</button></div>`;
  if (t.date > today) return `<div class="jbox"><span>Check-in opens on ${fmtDate(t.date)}.</span></div>`;
  return `<div class="jbox"><span>Travel date passed — ticket not used.</span></div>`;
}
function renderTickets() {
  const u = Portal.user; if (!u || u.role !== "user") return;
  const list = Tickets.forUser(u.id);
  $("ticketList").innerHTML = list.map((t) => {
    const last = t.history[t.history.length - 1];
    return `<article class="ticket ${t.status.toLowerCase()} ph-${t.phase}">
      <button class="t-qr ${t.status === "Cancelled" ? "void" : ""}" data-id="${t.id}" title="Show QR">${qrSvg(t, 3)}${t.status === "Cancelled" ? "<span>VOID</span>" : ""}</button>
      <div class="t-body">
        <div class="t-top"><span class="t-id">${t.id}</span>${statusPills(t)}</div>
        <div class="t-route">${escH(ST[t.from].name)} <span>→</span> ${escH(ST[t.to].name)}</div>
        <div class="t-meta">${fmtDate(t.date)} · ${t.pax} passenger${t.pax > 1 ? "s" : ""} · <b>₹${t.fare}</b> · about ${t.time} min · ${t.changes} change${t.changes === 1 ? "" : "s"}</div>
        ${t.start !== t.from ? `<div class="t-meta">Current route starts at <b>${escH(ST[t.start].name)}</b></div>` : ""}
        <ol class="legs">${legsHtml(t)}</ol>
        ${journeyBox(t)}
        <div class="t-hist">${escH(last.text)} <small>${fmtTime(last.at)}</small></div>
      </div>
    </article>`;
  }).join("") || `<div class="card empty-state"><b>No tickets yet.</b><p class="muted">Find a route on the planner and press “Book QR ticket”.</p><a class="btn primary" href="#/">Plan a journey</a></div>`;
  $("ticketList").querySelectorAll(".t-qr").forEach((b) => (b.onclick = () => showQR(Tickets.get(b.dataset.id))));
  $("ticketList").querySelectorAll("[data-checkin]").forEach((b) => (b.onclick = () => busy(b, async () => {
    try { await Tickets.checkIn(Tickets.get(b.dataset.checkin)); toast("Checked in", "Journey started. If trains are cancelled on your route, you will be re-routed automatically.", "ok"); }
    catch (err) { toast("Check-in failed", err.message, "bad"); }
  })));
  $("ticketList").querySelectorAll("[data-end]").forEach((b) => (b.onclick = () => busy(b, () => Tickets.end(Tickets.get(b.dataset.end)))));
}

// ---------------- Admin console ----------------
function fillAdminForm() {
  $("adLine").innerHTML = LINES.map((l, i) => `<option value="${i}">${l.name}</option>`).join("");
  $("adReason").innerHTML = REASONS.map((r) => `<option>${r}</option>`).join("");
  const fillStops = () => {
    const L = LINES[+$("adLine").value];
    const opts = L.stops.map(([s], p) => `<option value="${p}">${ST[s].name}</option>`).join("");
    $("adFrom").innerHTML = opts; $("adTo").innerHTML = opts;
    $("adTo").value = String(Math.min(L.stops.length - 1, 4));
  };
  $("adLine").onchange = fillStops;
  $("adWhole").onchange = () => { $("adFrom").disabled = $("adTo").disabled = $("adWhole").checked; };
  fillStops();
}
function renderAdmin() {
  const tickets = Tickets.all().slice().sort((a, b) => b.createdAt - a.createdAt), dis = Disruptions.all(), notes = Notes.all();
  const users = Object.fromEntries(Auth.users().map((u) => [u.id, u]));
  const by = (s) => tickets.filter((t) => t.status === s).length;
  const revenue = tickets.filter((t) => t.status !== "Cancelled").reduce((s, t) => s + t.fare, 0);
  $("adStats").innerHTML = [
    ["Tickets booked", tickets.length], ["On journey now", tickets.filter((t) => t.phase === "travelling").length], ["Re-routed", by("Rerouted")],
    ["Cancelled & refunded", by("Cancelled")], ["Active cancellations", Disruptions.active().length], ["Ticket revenue", "₹" + revenue.toLocaleString("en-IN")],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("");
  const act = dis.filter((d) => d.active).sort((a, b) => b.at - a.at);
  $("disList").innerHTML = act.map((d) => `<li>${linePill(d.line)} <b>${escH(ST[d.from].name)} – ${escH(ST[d.to].name)}</b>
      <div class="muted">${escH(d.reason)} · by ${escH(d.by)} · ${fmtTime(d.at)} · ${d.affected.length} ticket(s) affected</div>
      <button class="btn small" data-restore="${d.id}">Restore service</button></li>`).join("") || '<li class="empty">All lines running normally.</li>';
  $("disList").querySelectorAll("[data-restore]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const s = await Disruptions.restore(b.dataset.restore);
    toast("Service restored", `${s.notified} passenger(s) notified.`, "ok");
  })));
  $("adTickets").innerHTML = `<thead><tr><th>Ticket</th><th>Passenger</th><th>Journey</th><th>Date</th><th class="num">Pax</th><th class="num">Fare</th><th>Status</th></tr></thead><tbody>` +
    (tickets.map((t) => `<tr><td><b>${t.id}</b></td><td>${escH((users[t.uid] || {}).name || t.uname)}</td>
      <td>${escH(ST[t.from].name)} → ${escH(ST[t.to].name)}<div class="muted">${t.legs.filter((l) => l.kind === "ride").map((l) => LINES[l.line].name).join(" → ")}</div></td>
      <td>${fmtDate(t.date)}</td><td class="num">${t.pax}</td><td class="num">₹${t.fare}</td><td>${statusPills(t)}</td></tr>`).join("")
      || '<tr><td colspan="7" class="muted">No tickets booked yet.</td></tr>') + "</tbody>";
  $("adLog").innerHTML = notes.slice(0, 15).map((n) => `<li><b>${escH(n.title)}</b> → ${escH((users[n.uid] || {}).name || "passenger")}
      <p>${escH(n.body)}</p><small>${fmtTime(n.at)}</small></li>`).join("") || '<li class="empty">No notifications sent yet.</li>';
}
async function cancelTrains() {
  const line = +$("adLine").value, L = LINES[line];
  const a = $("adWhole").checked ? 0 : +$("adFrom").value, b = $("adWhole").checked ? L.stops.length - 1 : +$("adTo").value;
  try {
    const s = await busy($("btnCancelTrains"), () => Disruptions.cancel(Portal.user, line, a, b, $("adReason").value));
    const msg = s.affected
      ? `${s.rerouted} ticket(s) re-routed · ${s.cancelled} cancelled with refund · ${s.notified} passenger(s) notified instantly.`
      : "No booked or ongoing journeys use this section, so no passenger needed a notification.";
    $("adResult").hidden = false; $("adResult").textContent = "Trains cancelled. " + msg;
    toast(`${L.name} trains cancelled`, msg, "warn");
  } catch (err) { $("adResult").hidden = false; $("adResult").textContent = err.message; }
}

// ---------------- Live updates ----------------
function quietRun() { const anim = $("animate").checked; $("animate").checked = false; run(); $("animate").checked = anim; }
function onLiveChange() {
  Disruptions.apply();
  drawDisruptions();
  if (state.route && !$("view-planner").hidden) quietRun();
  if (Portal.user) Portal.user = Auth.users().find((u) => u.id === Portal.user.id) || Portal.user;
  renderHeader();
  if (!$("view-tickets").hidden) renderTickets();
  if (!$("view-admin").hidden) renderAdmin();
  deliverNotifications(false);
}

// ---------------- Init ----------------
(function initPortal() {
  Live.onChange(onLiveChange);
  Live.init();
  Portal.user = Auth.current();
  Disruptions.apply();
  drawDisruptions();
  fillAdminForm();
  $("bkDate").value = todayISO(); $("bkDate").min = todayISO();
  $("btnBook").onclick = bookTicket;
  $("btnLogin").onclick = () => openLogin();
  $("btnLogout").onclick = logout;
  $("loginForm").onsubmit = submitLogin;
  document.querySelectorAll("#loginModal .tabs button").forEach((b) => (b.onclick = () => setLoginMode(b.dataset.tab)));
  document.querySelectorAll(".demo button").forEach((b) => (b.onclick = () => { setLoginMode("login"); $("lgEmail").value = b.dataset.email; $("lgPass").value = b.dataset.pass; }));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; }));
  $("btnBell").onclick = (e) => {
    e.stopPropagation();
    const open = $("notesPanel").hidden;
    $("notesPanel").hidden = !open;
    if (open) setTimeout(() => { Notes.markRead(Notes.forUser(Portal.user.id).map((n) => n.id)); $("bellCount").hidden = true; }, 1500);
  };
  $("btnReadAll").onclick = () => { Notes.markRead(Notes.forUser(Portal.user.id).map((n) => n.id)); renderBell(); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#bellWrap")) $("notesPanel").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => (m.hidden = true)); });
  $("btnCancelTrains").onclick = cancelTrains;
  window.addEventListener("hashchange", showView);
  setInterval(() => { if (!$("view-tickets").hidden) renderTickets(); }, 15000); // journey progress
  renderHeader();
  showView();
  deliverNotifications(true);
})();
