// MetroMate — accounts, QR tickets, admin console and live notifications (UI)

const Portal = { user: null, seen: new Set(), pending: null };
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const fmtTime = (ms) => new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const linePill = (li) => `<span class="linepill" style="background:${LINES[li].color}">${LINES[li].name}</span>`;
const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------- Toasts & system notifications ----------------
function toast(title, body, kind = "info", ms = 7000) {
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
    const u = loginMode === "register"
      ? await Auth.register($("lgName").value, $("lgEmail").value, $("lgPass").value)
      : await Auth.login($("lgEmail").value, $("lgPass").value);
    afterLogin(u);
  } catch (err) { $("lgErr").hidden = false; $("lgErr").textContent = err.message; }
}
function afterLogin(u) {
  Portal.user = u;
  $("loginModal").hidden = true;
  $("loginForm").reset();
  Portal.seen = new Set(Notes.forUser(u.id).map((n) => n.id));
  if (u.role === "user" && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  toast(`Welcome, ${u.name.split(" ")[0]}`, u.role === "admin" ? "You are signed in as administrator." : "You can now book QR tickets.", "ok", 3500);
  renderHeader();
  const p = Portal.pending; Portal.pending = null;
  if (u.role === "admin") location.hash = "#/admin";
  else if (p === "book") bookTicket();
  else showView();
}
function logout() {
  Auth.logout(); Portal.user = null; Portal.seen = new Set();
  $("notesPanel").hidden = true;
  renderHeader(); location.hash = "#/"; showView();
}

// ---------------- Notifications bell ----------------
function renderBell() {
  const u = Portal.user;
  if (!u || u.role !== "user") return;
  const notes = Notes.forUser(u.id);
  const unread = notes.filter((n) => !n.read).length;
  $("bellCount").hidden = !unread; $("bellCount").textContent = unread;
  $("notesList").innerHTML = notes.slice(0, 20).map((n) => `<li class="${n.read ? "" : "unread"}"><b>${escH(n.title)}</b><p>${escH(n.body)}</p><small>${fmtTime(n.at)}</small></li>`).join("")
    || '<li class="empty">No notifications yet.</li>';
}

// ---------------- Booking ----------------
function bookTicket() {
  const u = Portal.user;
  if (!u) return openLogin("book");
  if (u.role !== "user") return toast("Log in as a passenger to book", "Admin accounts cannot book tickets.", "warn");
  if (!state.route) return toast("Find a route first", "", "warn");
  try {
    const t = Tickets.book(G, u, state.from, state.to, +$("bkPax").value, $("bkDate").value || todayISO(), state.pref);
    Portal.seen = new Set(Notes.forUser(u.id).map((n) => n.id));
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
function showQR(t, fresh) {
  const cancelled = t.status === "Cancelled";
  $("qrBody").innerHTML = `${fresh ? '<div class="booked">✓ Ticket booked</div>' : ""}
    <div class="qr-big ${cancelled ? "void" : ""}">${qrSvg(t, 6)}${cancelled ? "<span>VOID</span>" : ""}</div>
    <div class="qr-id">${t.id} <span class="status ${t.status.toLowerCase()}">${t.status}</span></div>
    <div class="qr-route"><b>${escH(ST[t.from].name)}</b> → <b>${escH(ST[t.to].name)}</b></div>
    <div class="muted">${fmtDate(t.date)} · ${t.passengers} passenger${t.passengers > 1 ? "s" : ""} · ₹${t.fare} · about ${t.time} min</div>
    <ol class="legs">${legsHtml(t)}</ol>
    ${fresh ? '<a class="btn primary wide" href="#/tickets" data-close>View my tickets</a>' : ""}`;
  $("qrModal").hidden = false;
}

// ---------------- My tickets ----------------
function renderTickets() {
  const u = Portal.user; if (!u || u.role !== "user") return;
  const list = Tickets.forUser(u.id);
  const today = todayISO();
  $("ticketList").innerHTML = list.map((t) => {
    const past = t.date < today && t.status !== "Cancelled";
    const last = t.history[t.history.length - 1];
    return `<article class="ticket ${t.status.toLowerCase()}">
      <button class="t-qr ${t.status === "Cancelled" ? "void" : ""}" data-id="${t.id}" title="Show QR">${qrSvg(t, 3)}${t.status === "Cancelled" ? "<span>VOID</span>" : ""}</button>
      <div class="t-body">
        <div class="t-top"><span class="t-id">${t.id}</span><span class="status ${t.status.toLowerCase()}">${t.status}</span>${past ? '<span class="status past">Travel date passed</span>' : ""}</div>
        <div class="t-route">${escH(ST[t.from].name)} <span>→</span> ${escH(ST[t.to].name)}</div>
        <div class="t-meta">${fmtDate(t.date)} · ${t.passengers} passenger${t.passengers > 1 ? "s" : ""} · <b>₹${t.fare}</b> · about ${t.time} min · ${t.changes} change${t.changes === 1 ? "" : "s"}</div>
        <ol class="legs">${legsHtml(t)}</ol>
        <div class="t-hist">${escH(last.text)} <small>${fmtTime(last.at)}</small></div>
      </div>
    </article>`;
  }).join("") || `<div class="card empty-state"><b>No tickets yet.</b><p class="muted">Find a route on the planner and press “Book QR ticket”.</p><a class="btn primary" href="#/">Plan a journey</a></div>`;
  $("ticketList").querySelectorAll(".t-qr").forEach((b) => (b.onclick = () => showQR(Tickets.all().find((t) => t.id === b.dataset.id))));
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
  const tickets = Tickets.all(), dis = Disruptions.all(), notes = Notes.all();
  const users = Object.fromEntries(Auth.users().map((u) => [u.id, u]));
  const by = (s) => tickets.filter((t) => t.status === s).length;
  const revenue = tickets.filter((t) => t.status !== "Cancelled").reduce((s, t) => s + t.fare, 0);
  $("adStats").innerHTML = [
    ["Tickets booked", tickets.length], ["Active", by("Active")], ["Re-routed", by("Rerouted")], ["Cancelled & refunded", by("Cancelled")],
    ["Active cancellations", Disruptions.active().length], ["Ticket revenue", "₹" + revenue.toLocaleString("en-IN")],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("");
  const act = dis.filter((d) => d.active).sort((a, b) => b.at - a.at);
  $("disList").innerHTML = act.map((d) => `<li>${linePill(d.line)} <b>${escH(ST[d.from].name)} – ${escH(ST[d.to].name)}</b>
      <div class="muted">${escH(d.reason)} · by ${escH(d.by)} · ${fmtTime(d.at)} · ${(d.affected || []).length} ticket(s) affected</div>
      <button class="btn small" data-restore="${d.id}">Restore service</button></li>`).join("") || '<li class="empty">All lines running normally.</li>';
  $("disList").querySelectorAll("[data-restore]").forEach((b) => (b.onclick = () => {
    const s = Disruptions.restore(G, b.dataset.restore);
    afterNetworkChange();
    toast("Service restored", s ? `${s.notified} passenger(s) notified.` : "", "ok");
  }));
  $("adTickets").innerHTML = `<thead><tr><th>Ticket</th><th>Passenger</th><th>Journey</th><th>Date</th><th class="num">Pax</th><th class="num">Fare</th><th>Status</th></tr></thead><tbody>` +
    (tickets.sort((a, b) => b.createdAt - a.createdAt).map((t) => `<tr><td><b>${t.id}</b></td><td>${escH((users[t.userId] || {}).name || t.userName)}</td>
      <td>${escH(ST[t.from].name)} → ${escH(ST[t.to].name)}<div class="muted">${t.legs.filter((l) => l.kind === "ride").map((l) => LINES[l.line].name).join(" → ")}</div></td>
      <td>${fmtDate(t.date)}</td><td class="num">${t.passengers}</td><td class="num">₹${t.fare}</td><td><span class="status ${t.status.toLowerCase()}">${t.status}</span></td></tr>`).join("")
      || '<tr><td colspan="7" class="muted">No tickets booked yet.</td></tr>') + "</tbody>";
  $("adLog").innerHTML = notes.sort((a, b) => b.at - a.at).slice(0, 15).map((n) => `<li><b>${escH(n.title)}</b> → ${escH((users[n.userId] || {}).name || "passenger")}
      <p>${escH(n.body)}</p><small>${fmtTime(n.at)}</small></li>`).join("") || '<li class="empty">No notifications sent yet.</li>';
}
function cancelTrains() {
  const line = +$("adLine").value, L = LINES[line];
  const a = $("adWhole").checked ? 0 : +$("adFrom").value, b = $("adWhole").checked ? L.stops.length - 1 : +$("adTo").value;
  try {
    const s = Disruptions.cancel(G, Portal.user, line, a, b, $("adReason").value);
    afterNetworkChange();
    const msg = `${s.rerouted} ticket(s) re-routed · ${s.cancelled} cancelled with refund · ${s.notified} passenger(s) notified instantly.`;
    $("adResult").hidden = false; $("adResult").textContent = "Trains cancelled. " + msg;
    toast(`${L.name} trains cancelled`, msg, "warn");
  } catch (err) { $("adResult").hidden = false; $("adResult").textContent = err.message; }
}

// ---------------- Live updates ----------------
function quietRun() { const anim = $("animate").checked; $("animate").checked = false; run(); $("animate").checked = anim; }
function afterNetworkChange() {
  Disruptions.apply(G);
  drawDisruptions();
  if (state.route && !$("view-planner").hidden) quietRun();
  renderHeader();
  if (!$("view-tickets").hidden) renderTickets();
  if (!$("view-admin").hidden) renderAdmin();
}
function onStoreChange() {
  afterNetworkChange();
  const u = Portal.user;
  if (u && u.role === "user") {
    Notes.forUser(u.id).filter((n) => !Portal.seen.has(n.id)).reverse().forEach((n) => {
      Portal.seen.add(n.id);
      toast(n.title, n.body, n.title.startsWith("Service restored") ? "ok" : "warn", 12000);
      systemNotify(n);
    });
  }
}

// ---------------- Init ----------------
(async function initPortal() {
  await Auth.seed();
  Portal.user = Auth.current();
  if (Portal.user) Portal.seen = new Set(Notes.forUser(Portal.user.id).map((n) => n.id));
  Disruptions.apply(G);
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
  $("btnBell").onclick = (e) => { e.stopPropagation(); $("notesPanel").hidden = !$("notesPanel").hidden; };
  $("btnReadAll").onclick = () => Notes.markRead(Portal.user.id);
  document.addEventListener("click", (e) => { if (!e.target.closest("#bellWrap")) $("notesPanel").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => (m.hidden = true)); });
  $("btnCancelTrains").onclick = cancelTrains;
  Store.onChange(onStoreChange);
  window.addEventListener("hashchange", showView);
  renderHeader();
  showView();
})();
