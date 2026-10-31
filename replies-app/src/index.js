// lemlist reply alerts: tiny installable web app + push notifications.
// Routes (SECRET is generated on first /setup call and stored in KV):
//   GET  /setup                 -> claims the app once, returns the secret links
//   POST /hook/SECRET           -> lemlist webhook target
//   GET  /a/SECRET/             -> the phone app
//   GET  /a/SECRET/replies      -> recent replies (JSON)
//   POST /a/SECRET/subscribe    -> save this phone's push subscription
//   POST /a/SECRET/test         -> fake reply, to test notifications

const MAX_REPLIES = 100;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const secret = await env.KV.get("secret");

    if (parts[0] === "setup") {
      if (secret) return new Response("Already set up.", { status: 404 });
      const s = randomId();
      await env.KV.put("secret", s);
      return json({
        app: `${url.origin}/a/${s}/`,
        webhook: `${url.origin}/hook/${s}`,
      });
    }

    if (!secret || parts[1] !== secret) return new Response("Not found", { status: 404 });

    if (parts[0] === "hook" && req.method === "POST") {
      let data = {};
      try { data = await req.json(); } catch {}
      await addReply(env, toReply(data));
      await pushAll(env, url.origin);
      return new Response("ok");
    }

    if (parts[0] !== "a") return new Response("Not found", { status: 404 });
    const page = parts[2] || "";

    if (page === "") return html(APP_HTML);
    if (page === "sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript" } });
    if (page === "manifest.json") return json(manifest(url.pathname.replace(/manifest\.json$/, "")));
    if (page === "icon.svg") return new Response(ICON, { headers: { "content-type": "image/svg+xml" } });
    if (page === "replies") return json(await getReplies(env));
    if (page === "vapid") return json({ key: (await getVapid(env)).publicKey });

    if (page === "subscribe" && req.method === "POST") {
      const sub = await req.json();
      const subs = JSON.parse((await env.KV.get("subs")) || "[]").filter((s) => s.endpoint !== sub.endpoint);
      subs.push(sub);
      await env.KV.put("subs", JSON.stringify(subs));
      return json({ ok: true, devices: subs.length });
    }

    if (page === "test" && req.method === "POST") {
      await addReply(env, { name: "Test", email: "", company: "", campaign: "", subject: "", text: "If you see this, alerts work.", at: new Date().toISOString() });
      const r = await pushAll(env, url.origin);
      return json(r);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------- replies ----------

function pick(o, ...keys) {
  for (const k of keys) if (o && o[k]) return String(o[k]);
  return "";
}

function toReply(d) {
  const name = [pick(d, "leadFirstName", "firstName"), pick(d, "leadLastName", "lastName")].filter(Boolean).join(" ");
  let text = pick(d, "text", "message", "body", "replyText");
  text = cleanText(text);
  return {
    name: name || pick(d, "leadEmail", "email") || "Someone",
    email: pick(d, "leadEmail", "email"),
    company: pick(d, "leadCompanyName", "companyName"),
    campaign: pick(d, "campaignName"),
    subject: pick(d, "subject", "emailSubject"),
    text,
    at: pick(d, "createdAt", "date") || new Date().toISOString(),
  };
}

async function getReplies(env) {
  // Clean on read too, so replies saved before this change also look tidy
  return JSON.parse((await env.KV.get("replies")) || "[]").map((r) => {
    const text = cleanText(r.text);
    return { ...r, text, auto: isAuto(text, r.subject) };
  });
}

// Only what the person newly wrote: drop the quoted email chain, signatures and HTML
function cleanText(t) {
  t = String(t || "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  t = t.split(/\s(?:On\s.{5,120}?wrote:|-{2,}\s*Original Message|From:\s.{3,80}?Sent:|Sent from my |Get Outlook for )/i)[0];
  t = t.replace(/^new customer calls for .*?(?=Hi|Hello|Hey|Thank|$)/i, "");
  t = t.replace(/\s*(?:iPhone|Android)?\s*>\s*$/, "");
  t = t.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return t.slice(0, 2000);
}

function isAuto(text, subject) {
  return /automatic reply|auto(-|\s)?reply|out of (the )?office|we have received your (message|email)|has received your message|thank(s| you) for (contacting|reaching out to|your (email|message))|ticket (#|number)|do not reply/i.test((subject || "") + " " + text);
}

async function addReply(env, r) {
  const list = await getReplies(env);
  list.unshift(r);
  await env.KV.put("replies", JSON.stringify(list.slice(0, MAX_REPLIES)));
}

// ---------- web push (empty payload; the phone fetches the latest reply) ----------

async function pushAll(env, origin) {
  const subs = JSON.parse((await env.KV.get("subs")) || "[]");
  const vapid = await getVapid(env);
  const keep = [];
  let sent = 0;
  for (const s of subs) {
    const aud = new URL(s.endpoint).origin;
    const jwt = await vapidJwt(vapid, aud, origin);
    const res = await fetch(s.endpoint, {
      method: "POST",
      headers: { TTL: "86400", Urgency: "high", Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`, "Content-Length": "0" },
    });
    if (res.status === 404 || res.status === 410) continue; // phone unsubscribed
    if (res.ok) sent++;
    keep.push(s);
  }
  if (keep.length !== subs.length) await env.KV.put("subs", JSON.stringify(keep));
  return { devices: subs.length, sent };
}

async function getVapid(env) {
  const saved = await env.KV.get("vapid");
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const v = { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await env.KV.put("vapid", JSON.stringify(v));
  return v;
}

async function vapidJwt(v, aud, origin) {
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: origin })}`;
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId() {
  return b64url(crypto.getRandomValues(new Uint8Array(18)));
}

const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const html = (s) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

// ---------- phone app ----------

const manifest = (scope) => ({
  name: "Replies",
  short_name: "Replies",
  start_url: scope,
  scope,
  display: "standalone",
  background_color: "#f4f6fb",
  theme_color: "#0f2a44",
  icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a6faf"/><stop offset="1" stop-color="#37bc6d"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#g)"/><path d="M26 30h48a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H46l-14 11V66h-6a6 6 0 0 1-6-6V36a6 6 0 0 1 6-6Z" fill="#fff"/><circle cx="38" cy="48" r="4" fill="#1a6faf"/><circle cx="50" cy="48" r="4" fill="#2a8f8f"/><circle cx="62" cy="48" r="4" fill="#37bc6d"/></svg>`;

const SW_JS = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  e.waitUntil(
    fetch("replies").then((r) => r.json()).catch(() => []).then((list) => {
      const r = list[0] || {};
      const who = (r.name || "Someone") + (r.company && r.company !== r.name ? " · " + r.company : "");
      return self.registration.showNotification(r.auto ? "Auto-reply from " + who : "💬 " + who + " replied", {
        body: r.text || "Open to read it.",
        icon: "icon.svg",
        badge: "icon.svg",
        tag: "reply-" + (r.at || Date.now()),
      });
    })
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow("./"));
});
`;

const INBOX_URL = "https://outreach-0csl.onrender.com/inbox";

const APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f2a44">
<title>Replies</title><link rel="manifest" href="manifest.json"><link rel="icon" href="icon.svg">
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#0f172a;--soft:#64748b;--line:#e6eaf2;--brand:#1a6faf;--ok:#37bc6d;--chip:#eef3fa}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#131c2e;--ink:#e8edf6;--soft:#8a97ad;--line:#1f2a40;--chip:#1a2740}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:5;background:linear-gradient(135deg,#0f2a44,#1a6faf);color:#fff;padding:calc(18px + env(safe-area-inset-top)) 18px 18px}
.top{display:flex;align-items:center;justify-content:space-between}
h1{margin:0;font-size:24px;font-weight:700;letter-spacing:-.02em}
.sub{opacity:.8;font-size:14px;margin-top:2px}
.iconbtn{background:rgba(255,255,255,.15);border:0;color:#fff;width:40px;height:40px;border-radius:12px;font-size:18px}
.tabs{display:flex;gap:8px;margin-top:14px}
.tab{border:0;background:rgba(255,255,255,.14);color:#fff;padding:7px 14px;border-radius:999px;font-size:14px;font-weight:600}
.tab.on{background:#fff;color:#0f2a44}
main{padding:14px 14px calc(30px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto}
.banner{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin-bottom:14px;display:flex;gap:12px;align-items:center}
.banner b{display:block}.banner span{color:var(--soft);font-size:14px}
.btn{border:0;border-radius:12px;padding:11px 16px;font-size:15px;font-weight:600;background:var(--brand);color:#fff;white-space:nowrap}
.btn.ghost{background:var(--chip);color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 2px rgba(15,23,42,.04);position:relative}
.card.new{border-color:color-mix(in srgb,var(--ok) 55%,var(--line))}
.card.new:before{content:"";position:absolute;left:-1px;top:18px;bottom:18px;width:4px;border-radius:0 4px 4px 0;background:var(--ok)}
.card.auto{opacity:.6}
.row{display:flex;gap:12px;align-items:flex-start}
.av{flex:none;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:15px}
.who{flex:1;min-width:0}
.name{font-weight:650;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.co{color:var(--soft);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{color:var(--soft);font-size:13px;white-space:nowrap}
.msg{margin:10px 0 0;font-size:16px;white-space:pre-wrap;word-wrap:break-word}
.msg.clip{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.more{color:var(--brand);font-size:14px;font-weight:600;background:none;border:0;padding:4px 0 0}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{background:var(--chip);color:var(--soft);font-size:12px;font-weight:600;padding:4px 9px;border-radius:999px}
.chip.auto{background:#fef3c7;color:#92400e}
.acts{display:flex;gap:8px;margin-top:12px}
.acts a{flex:1;text-align:center;text-decoration:none}
.empty{text-align:center;color:var(--soft);padding:60px 20px}
.empty div{font-size:44px}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 16px;border-radius:12px;font-size:14px;opacity:0;transition:.25s;pointer-events:none}
#toast.show{opacity:1}
#menu{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10;align-items:flex-end}
#menu.show{display:flex}
#menu .sheet{background:var(--card);width:100%;border-radius:22px 22px 0 0;padding:18px 18px calc(22px + env(safe-area-inset-bottom))}
#menu .btn{display:block;width:100%;margin-top:10px;text-align:center;text-decoration:none}
</style></head><body>
<header>
  <div class="top">
    <div><h1>Replies</h1><div class="sub" id="sum">Loading…</div></div>
    <div><button class="iconbtn" id="ref" aria-label="Refresh">↻</button> <button class="iconbtn" id="opt" aria-label="Options">⋯</button></div>
  </div>
  <div class="tabs"><button class="tab on" data-f="real">People</button><button class="tab" data-f="all">Everything</button></div>
</header>
<main>
  <div class="banner" id="alerts" hidden>
    <div style="font-size:28px">🔔</div>
    <div style="flex:1"><b>Get a ping for every reply</b><span>Turn on alerts for this phone.</span></div>
    <button class="btn" id="on">Turn on</button>
  </div>
  <div id="list"></div>
</main>
<div id="menu"><div class="sheet">
  <b>Options</b>
  <a class="btn" href="${INBOX_URL}" target="_blank">Open the inbox to reply</a>
  <button class="btn ghost" id="t">Send me a test alert</button>
  <button class="btn ghost" id="close">Close</button>
</div></div>
<div id="toast"></div>
<script>
var INBOX = "${INBOX_URL}";
var filter = "real", data = [];
var seen = 0; try { seen = +localStorage.getItem("seen") || 0; } catch (e) {}
var $ = function (id) { return document.getElementById(id); };
var esc = function (x) { return String(x || "").replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); };
var COLORS = ["#1a6faf","#37bc6d","#8b5cf6","#e11d48","#f59e0b","#0891b2","#db2777","#4f46e5"];
function color(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return COLORS[Math.abs(h) % COLORS.length]; }
function initials(n) { var p = String(n || "?").replace(/@.*/, "").split(/[\\s._-]+/).filter(Boolean); return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); }
function ago(t) {
  var s = (Date.now() - new Date(t)) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago"; return new Date(t).toLocaleDateString();
}
function toast(m) { var t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(function () { t.classList.remove("show"); }, 2500); }
function render() {
  var list = filter === "real" ? data.filter(function (r) { return !r.auto; }) : data;
  var fresh = data.filter(function (r) { return !r.auto && new Date(r.at) > seen; }).length;
  var people = data.filter(function (r) { return !r.auto; }).length;
  $("sum").textContent = fresh ? fresh + " new since you last looked" : people + " people replied · all caught up";
  if (!list.length) { $("list").innerHTML = '<div class="empty"><div>📭</div><p>No replies yet.<br>New ones show up here and on your lock screen.</p></div>'; return; }
  $("list").innerHTML = list.map(function (r, i) {
    var name = r.name || r.email || "Someone";
    // No first name on file: lead with the company, show the email underneath
    if (name.indexOf("@") > 0 && r.company) { var co = r.company; r = Object.assign({}, r, { company: name }); name = co; }
    var isNew = !r.auto && new Date(r.at) > seen;
    var long = (r.text || "").length > 220;
    return '<div class="card' + (isNew ? " new" : "") + (r.auto ? " auto" : "") + '">' +
      '<div class="row"><div class="av" style="background:' + color(name) + '">' + esc(initials(name)) + '</div>' +
      '<div class="who"><div class="name">' + esc(name) + '</div>' + (r.company && r.company !== name ? '<div class="co">' + esc(r.company) + '</div>' : "") + '</div>' +
      '<div class="time">' + ago(r.at) + '</div></div>' +
      '<p class="msg' + (long ? " clip" : "") + '" id="m' + i + '">' + esc(r.text || "(no text)") + '</p>' +
      (long ? '<button class="more" data-i="' + i + '">Read all</button>' : "") +
      '<div class="meta">' + (r.auto ? '<span class="chip auto">Auto-reply</span>' : "") + (isNew ? '<span class="chip" style="color:var(--ok)">New</span>' : "") +
      (r.campaign ? '<span class="chip">' + esc(r.campaign) + '</span>' : "") + '</div>' +
      (r.auto ? "" : '<div class="acts"><a class="btn" href="' + INBOX + '" target="_blank">Reply</a>' +
        (r.email ? '<a class="btn ghost" href="#" data-copy="' + esc(r.email) + '">Copy email</a>' : "") + '</div>') +
      '</div>';
  }).join("");
}
async function load(quiet) {
  try { data = await fetch("replies").then(function (r) { return r.json(); }); render(); if (!quiet) toast("Up to date"); }
  catch (e) { $("sum").textContent = "Offline, pull again later"; }
}
function markSeen() { try { localStorage.setItem("seen", Date.now()); } catch (e) {} }
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-i]"); if (b) { $("m" + b.dataset.i).classList.remove("clip"); b.remove(); }
  var c = e.target.closest("[data-copy]"); if (c) { e.preventDefault(); navigator.clipboard.writeText(c.dataset.copy).then(function () { toast("Email copied"); }); }
  var t = e.target.closest(".tab"); if (t) { document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("on", x === t); }); filter = t.dataset.f; render(); }
});
$("ref").onclick = function () { load(); };
$("opt").onclick = function () { $("menu").classList.add("show"); };
$("close").onclick = $("menu").onclick = function (e) { if (e.target.id === "menu" || e.target.id === "close") $("menu").classList.remove("show"); };
function key(b64) {
  var p = (b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p), function (c) { return c.charCodeAt(0); });
}
async function checkAlerts() {
  try { var reg = await navigator.serviceWorker.ready; $("alerts").hidden = !!(await reg.pushManager.getSubscription()) && Notification.permission === "granted"; }
  catch (e) { $("alerts").hidden = true; }
}
$("on").onclick = async function () {
  try {
    if (await Notification.requestPermission() !== "granted") { toast("Alerts are blocked. Allow them in phone settings."); return; }
    var reg = await navigator.serviceWorker.ready;
    var k = (await fetch("vapid").then(function (r) { return r.json(); })).key;
    var sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(k) });
    await fetch("subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
    $("alerts").hidden = true; toast("Alerts are on 🎉");
  } catch (e) { toast("Couldn't turn on: " + e.message); }
};
$("t").onclick = async function () {
  $("menu").classList.remove("show");
  var r = await fetch("test", { method: "POST" }).then(function (r) { return r.json(); });
  toast(r.sent ? "Test sent, check your lock screen" : "No phone has alerts on yet");
  load(true);
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").then(checkAlerts);
load(true).then(function () { setTimeout(markSeen, 4000); });
document.addEventListener("visibilitychange", function () { if (document.hidden) markSeen(); else load(true); });
setInterval(function () { load(true); }, 60000);
</script></body></html>`;
