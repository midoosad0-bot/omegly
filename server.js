'use strict';
// Omegly - random text chat. Zero dependencies: only Node's built-in modules.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex');
const DATA_FILE = path.join(__dirname, 'data.json');
// Pages live in ./public, but also work if the html files sit next to server.js (easier to upload from a phone)
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;

// ---------- persistent state ----------
let db = { genderFilterOpen: false, bans: [], reports: [], support: {}, codes: {}, unlocked: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch {}
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db, null, 1), () => {}), 300);
};

// ---------- helpers ----------
const clients = new Map(); // sid -> client
let queue = [];            // sids waiting for a partner
const newId = (n = 12) => crypto.randomBytes(n).toString('hex');
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 20000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
const sse = (c, ev, data) => { try { c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch {} };
const broadcast = (ev, data) => clients.forEach(c => c.res && sse(c, ev, data));
const clean = (t, max) => String(t || '').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim().slice(0, max);
const stripLinks = t => t.replace(/(https?:\/\/|www\.)\S+/gi, '[link removed]');

// ---------- matching ----------
const ROOMS = ['general', 'gaming', 'music', 'movies', 'sports', 'tech', 'languages'];
const compatible = (a, b) =>
  a.mode === b.mode && a.room === b.room &&
  (a.want === 'any' || b.gender === a.want) && (b.want === 'any' || a.gender === b.want);

function unpair(c, notify) {
  if (c.partner) {
    const p = clients.get(c.partner);
    c.partner = null;
    if (p) { p.partner = null; p.log = []; if (notify) sse(p, 'partner_left'); }
  }
  c.log = [];
  queue = queue.filter(id => id !== c.id);
}

function findPartner(c) {
  unpair(c, true);
  const i = queue.findIndex(id => { const o = clients.get(id); return o && o !== c && compatible(c, o); });
  if (i >= 0) {
    const o = clients.get(queue.splice(i, 1)[0]);
    c.partner = o.id; o.partner = c.id;
    const log = []; c.log = log; o.log = log;
    sse(c, 'matched', { mode: c.mode, initiator: true });
    sse(o, 'matched', { mode: o.mode, initiator: false });
  } else {
    queue.push(c.id);
    sse(c, 'waiting');
  }
}

// ---------- admin auth ----------
const failed = new Map(); // ip -> {n, until}
const redeemFails = new Map(); // ip -> {n, until}
function isAdmin(req, res) {
  const ip = ipOf(req);
  const f = failed.get(ip);
  if (f && f.until > Date.now()) { json(res, 429, { error: 'Too many attempts' }); return false; }
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) {
    const n = ((f && f.n) || 0) + 1;
    failed.set(ip, { n, until: n >= 8 ? Date.now() + 10 * 60 * 1000 : 0 });
    json(res, 401, { error: 'Wrong password' });
    return false;
  }
  failed.delete(ip);
  return true;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // static pages
  if (req.method === 'GET' && (p === '/' || p === '/admin' || p === '/terms')) {
    const file = path.join(PUB, p === '/' ? 'index.html' : p === '/admin' ? 'admin.html' : 'terms.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    return fs.createReadStream(file).pipe(res);
  }

  // new session
  if (req.method === 'POST' && p === '/api/session') {
    const ip = ipOf(req);
    if (db.bans.includes(ip)) return json(res, 403, { error: 'banned' });
    const id = newId();
    clients.set(id, { id, ip, res: null, gender: 'na', want: 'any', partner: null, log: [], last: 0, burst: [] });
    // drop sessions that never open the event stream
    setTimeout(() => { const c = clients.get(id); if (c && !c.res) clients.delete(id); }, 30000);
    return json(res, 200, { sid: id, genderFilterOpen: db.genderFilterOpen });
  }

  // event stream
  if (req.method === 'GET' && p === '/api/events') {
    const c = clients.get(url.searchParams.get('sid'));
    if (!c) return json(res, 404, { error: 'no session' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res = res;
    sse(c, 'config', { genderFilterOpen: db.genderFilterOpen });
    sse(c, 'online', { count: clients.size });
    req.on('close', () => { unpair(c, true); clients.delete(c.id); });
    return;
  }

  // support (user side)
  if (p === '/api/support/get' && req.method === 'GET') {
    const t = url.searchParams.get('token') || '';
    return json(res, 200, { msgs: (db.support[t] && db.support[t].msgs) || [], unlocked: !!db.unlocked[t] });
  }
  // redeem an unlock code (unlocks the Boys/Girls filter for this browser)
  if (p === '/api/redeem' && req.method === 'POST') {
    const ip = ipOf(req);
    const f = redeemFails.get(ip);
    if (f && f.n >= 10 && f.until > Date.now()) return json(res, 429, { error: 'Too many attempts' });
    const b = await readBody(req);
    const token = String(b.token || '');
    const code = clean(b.code, 40).toUpperCase();
    const c = db.codes[code];
    if (!/^[a-f0-9]{16,40}$/.test(token) || !c || c.used >= c.max) {
      const n = ((f && f.n) || 0) + 1;
      redeemFails.set(ip, { n, until: Date.now() + 10 * 60 * 1000 });
      return json(res, 400, { error: 'Invalid or used code' });
    }
    c.used++;
    db.unlocked[token] = { code, t: Date.now() };
    save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/support/send' && req.method === 'POST') {
    const b = await readBody(req);
    const token = String(b.token || '');
    if (!/^[a-f0-9]{16,40}$/.test(token)) return json(res, 400, { error: 'bad token' });
    const text = clean(b.text, 1000);
    if (!text) return json(res, 400, { error: 'empty' });
    if (!db.support[token]) {
      if (Object.keys(db.support).length > 2000) return json(res, 503, { error: 'busy' });
      db.support[token] = { msgs: [], unread: false, updated: 0 };
    }
    const th = db.support[token];
    if (th.msgs.length >= 200) return json(res, 429, { error: 'too many messages' });
    th.msgs.push({ from: 'user', text, t: Date.now() });
    th.unread = true; th.updated = Date.now();
    save();
    return json(res, 200, { ok: true });
  }

  // admin API
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req, res)) return;
    if (p === '/api/admin/overview') {
      return json(res, 200, {
        online: clients.size, waiting: queue.length,
        paired: [...clients.values()].filter(c => c.partner).length / 2,
        genderFilterOpen: db.genderFilterOpen, bans: db.bans, reports: db.reports.slice(-100).reverse(),
        codes: Object.entries(db.codes).map(([code, c]) => ({ code, ...c })).sort((a, b) => b.created - a.created),
        unlockedCount: Object.keys(db.unlocked).length,
        support: Object.entries(db.support).map(([token, th]) => ({ token, unread: th.unread, updated: th.updated, msgs: th.msgs, unlocked: !!db.unlocked[token] }))
          .sort((a, b) => b.updated - a.updated).slice(0, 100)
      });
    }
    const b = req.method === 'POST' ? await readBody(req) : {};
    if (p === '/api/admin/gender') {
      db.genderFilterOpen = !!b.open; save();
      broadcast('config', { genderFilterOpen: db.genderFilterOpen });
      return json(res, 200, { genderFilterOpen: db.genderFilterOpen });
    }
    if (p === '/api/admin/reply') {
      const th = db.support[String(b.token)];
      const text = clean(b.text, 1000);
      if (!th || !text) return json(res, 400, { error: 'bad request' });
      th.msgs.push({ from: 'admin', text, t: Date.now() }); th.unread = false; th.updated = Date.now(); save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/markread') {
      const th = db.support[String(b.token)]; if (th) { th.unread = false; save(); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/code') {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      db.codes[code] = { note: clean(b.note, 80), max: Math.min(Math.max(parseInt(b.max, 10) || 1, 1), 1000), used: 0, created: Date.now() };
      save(); return json(res, 200, { code });
    }
    if (p === '/api/admin/delcode') { delete db.codes[String(b.code)]; save(); return json(res, 200, { ok: true }); }
    if (p === '/api/admin/unlock') {
      const token = String(b.token || '');
      if (!/^[a-f0-9]{16,40}$/.test(token)) return json(res, 400, { error: 'bad token' });
      if (b.on) db.unlocked[token] = { code: 'admin', t: Date.now() }; else delete db.unlocked[token];
      save(); return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/ban') {
      const ip = clean(b.ip, 64);
      if (ip && !db.bans.includes(ip)) db.bans.push(ip);
      clients.forEach(c => { if (c.ip === ip) { sse(c, 'banned'); try { c.res.end(); } catch {} } });
      save(); return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/unban') { db.bans = db.bans.filter(x => x !== b.ip); save(); return json(res, 200, { ok: true }); }
    if (p === '/api/admin/dismiss') { db.reports = db.reports.filter(r => r.id !== b.id); save(); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'not found' });
  }

  // chat actions
  if (req.method === 'POST' && p.startsWith('/api/')) {
    const b = await readBody(req);
    const c = clients.get(String(b.sid || ''));
    if (!c || !c.res) return json(res, 404, { error: 'no session' });

    if (p === '/api/find') {
      const gender = ['boy', 'girl', 'na'].includes(b.gender) ? b.gender : 'na';
      const want = ['any', 'boy', 'girl'].includes(b.want) ? b.want : 'any';
      const tok = String(b.token || '');
      if (want !== 'any' && !(db.genderFilterOpen || db.unlocked[tok])) return json(res, 403, { error: 'locked' });
      if (want !== 'any' && gender === 'na') return json(res, 400, { error: 'choose your gender first' });
      c.gender = gender; c.want = want;
      c.mode = b.mode === 'video' ? 'video' : 'text';
      c.room = ROOMS.includes(b.room) ? b.room : 'general';
      findPartner(c);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/leave') { unpair(c, true); return json(res, 200, { ok: true }); }

    if (p === '/api/send') {
      const partner = c.partner && clients.get(c.partner);
      if (!partner) return json(res, 409, { error: 'not connected' });
      const now = Date.now();
      c.burst = c.burst.filter(t => now - t < 10000);
      if (now - c.last < 400 || c.burst.length >= 15) return json(res, 429, { error: 'slow down' });
      c.last = now; c.burst.push(now);
      const text = stripLinks(clean(b.text, 500));
      if (!text) return json(res, 400, { error: 'empty' });
      c.log.push({ ip: c.ip, text, t: now }); if (c.log.length > 40) c.log.shift();
      sse(partner, 'msg', { text });
      return json(res, 200, { ok: true, text });
    }
    if (p === '/api/signal') {
      // WebRTC signaling relay (offer / answer / ICE candidates) for video mode
      const partner = c.partner && clients.get(c.partner);
      if (!partner || c.mode !== 'video' || !b.data || typeof b.data !== 'object') return json(res, 409, { error: 'not connected' });
      sse(partner, 'signal', { data: b.data });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/typing') {
      const partner = c.partner && clients.get(c.partner);
      if (partner) sse(partner, 'typing');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/report') {
      const partner = c.partner && clients.get(c.partner);
      if (!partner) return json(res, 409, { error: 'not connected' });
      db.reports.push({
        id: newId(6), t: Date.now(), reason: clean(b.reason, 100) || 'other',
        reporterIp: c.ip, reportedIp: partner.ip, transcript: c.log.slice(-30)
      });
      if (db.reports.length > 500) db.reports.shift();
      save();
      return json(res, 200, { ok: true });
    }
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => { try { json(res, 500, { error: 'server error' }); } catch {} });
});

setInterval(() => broadcast('online', { count: clients.size }), 5000);
setInterval(() => clients.forEach(c => { try { c.res && c.res.write(': ping\n\n'); } catch {} }), 20000);

server.listen(PORT, () => {
  console.log(`Omegly running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Admin password: ${ADMIN_PASSWORD}${process.env.ADMIN_PASSWORD ? '' : '   (random - set ADMIN_PASSWORD to choose your own)'}`);
});
