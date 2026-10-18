import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import generatePayload from 'promptpay-qr';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SITE_NAME = process.env.SITE_NAME || 'HYP TIP';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'slips');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------------- DB ---------------------------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  promptpay_id TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  min_amount INTEGER NOT NULL DEFAULT 20,
  alert_seconds INTEGER NOT NULL DEFAULT 8,
  accent TEXT NOT NULL DEFAULT '#ef2b2d',
  tts INTEGER NOT NULL DEFAULT 1,
  min_tts INTEGER NOT NULL DEFAULT 50,
  blocked_words TEXT DEFAULT '',
  overlay_token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  donor_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  ref TEXT UNIQUE NOT NULL,
  slip TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_don_user ON donations(user_id, status, created_at);
`);

// migration: columns added after first release
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('tts_rate')) db.exec('ALTER TABLE users ADD COLUMN tts_rate REAL NOT NULL DEFAULT 1');
  if (!cols.includes('tts_volume')) db.exec('ALTER TABLE users ADD COLUMN tts_volume REAL NOT NULL DEFAULT 1');
  if (!cols.includes('tts_pitch')) db.exec('ALTER TABLE users ADD COLUMN tts_pitch REAL NOT NULL DEFAULT 1');
}

const now = () => Date.now();
const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

/* -------------------------------- helpers ------------------------------- */
const RESERVED = new Set([
  'api', 'auth', 'login', 'register', 'dashboard', 'admin', 'overlay', 'css', 'js', 'img', 'uploads',
  'static', 'public', 'assets', 'favicon', 'robots', 'terms', 'privacy', 'about', 'help', 'support',
  'index', 'donate', 'settings', 'logout', 'null', 'undefined'
]);
const DEFAULT_BAD = ['เหี้ย', 'สัส', 'ควาย', 'fuck', 'shit', 'bitch', 'หี', 'เย็ด'];

function maskWords(text, extra = '') {
  const list = [...DEFAULT_BAD, ...extra.split(',').map(s => s.trim()).filter(Boolean)];
  let out = text;
  for (const w of list) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, m => '*'.repeat(m.length));
  }
  return out;
}
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// แปลงตัวเลขเป็นคำอ่านภาษาไทย เช่น 1500 -> "หนึ่งพันห้าร้อย"
function thaiNumber(input) {
  const n = Math.floor(Math.abs(Number(input) || 0));
  if (n === 0) return 'ศูนย์';
  if (n > 999999999999) return String(n);
  const dig = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const unit = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  const readChunk = x => {
    const s = String(x); let out = '';
    for (let i = 0; i < s.length; i++) {
      const d = +s[i], pos = s.length - i - 1;
      if (d === 0) continue;
      if (pos === 1) out += d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : dig[d] + 'สิบ';
      else if (pos === 0) out += (d === 1 && s.length > 1) ? 'เอ็ด' : dig[d];
      else out += dig[d] + unit[pos];
    }
    return out;
  };
  const groups = []; let x = n;
  while (x > 0) { groups.push(x % 1000000); x = Math.floor(x / 1000000); }
  let out = '';
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0 && !(i === 0 && out === '')) continue;
    out += readChunk(groups[i]) + (i > 0 ? 'ล้าน'.repeat(i) : '');
  }
  return out;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const buckets = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const t = now();
    const b = (buckets.get(key) || []).filter(x => t - x < windowMs);
    if (b.length >= max) return res.status(429).json({ error: 'ส่งคำขอถี่เกินไป โปรดลองใหม่ภายหลัง' });
    b.push(t);
    buckets.set(key, b);
    next();
  };
}
setInterval(() => { const t = now(); for (const [k, v] of buckets) if (!v.some(x => t - x < 3600e3)) buckets.delete(k); }, 600e3).unref();

const publicUser = u => ({
  id: u.id, email: u.email, username: u.username, displayName: u.display_name, role: u.role,
  promptpayId: u.promptpay_id, bio: u.bio, minAmount: u.min_amount, alertSeconds: u.alert_seconds,
  accent: u.accent, tts: !!u.tts, minTts: u.min_tts, blockedWords: u.blocked_words, overlayToken: u.overlay_token,
  ttsRate: u.tts_rate ?? 1, ttsVolume: u.tts_volume ?? 1, ttsPitch: u.tts_pitch ?? 1
});

/* --------------------------------- app ---------------------------------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ========================================================================== */
/*                   โหมดปิดปรับปรุงระบบ (Maintenance Mode)                    */
/* ========================================================================== */
// เปลี่ยนเป็น false เมื่อต้องการเปิดใช้งานเว็บไซต์ตามปกติ
const IS_MAINTENANCE = false;

app.use((req, res, next) => {
    if (IS_MAINTENANCE) {
        // ส่งไฟล์ HTML ปิดปรับปรุงสีแดง พร้อมสถานะ 503
        return res.status(503).sendFile(path.join(__dirname, 'maintenance.html'));
    }
    next();
});
/* ========================================================================== */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!req.path.startsWith('/overlay/')) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
const jsonParser = express.json({ limit: '50kb' });
app.use((req, res, next) => (req.path === '/api/webhook/payment' ? next() : jsonParser(req, res, next)));

// auth
app.use((req, res, next) => {
  const sid = parseCookies(req).sid;
  req.user = null;
  if (sid) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires > ?').get(sid, now());
    if (s) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      if (u && !u.banned) req.user = u;
    }
  }
  next();
});
// CSRF: state-changing API calls must carry a custom header (cannot be sent cross-site without CORS)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/webhook/payment') return next();
  if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'forbidden' });
  next();
});
const needAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' }));
const needAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'ไม่มีสิทธิ์' }));

function startSession(req, res, userId) {
  const token = rand(32);
  const ttl = 30 * 24 * 3600e3;
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)').run(token, userId, now() + ttl);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl / 1000}${secure}`);
}

/* --------------------------- realtime (SSE) ------------------------------ */
const overlayClients = new Map(); // overlay token -> Set<res>
const dashClients = new Map();    // user id -> Set<res> (แดชบอร์ดของสตรีมเมอร์/แอดมิน)
const refClients = new Map();     // donation ref -> Set<res> (หน้าจ่ายเงินของผู้โดเนท)
const adminClients = new Set();   // subset ของ dashClients ที่เป็นแอดมิน

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}
function pushToOverlay(token, event, data) {
  const set = overlayClients.get(token);
  if (!set) return 0;
  for (const res of set) sseWrite(res, event, data);
  return set.size;
}
function pushToDash(userId, event, data) {
  const set = dashClients.get(userId);
  if (!set) return 0;
  for (const res of set) sseWrite(res, event, data);
  return set.size;
}
function pushToAdmins(event, data) { for (const res of adminClients) sseWrite(res, event, data); }
function pushToRef(ref, event, data) {
  const set = refClients.get(ref);
  if (!set) return 0;
  for (const res of set) sseWrite(res, event, data);
  return set.size;
}
function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  sseWrite(res, 'hello', {});
  return setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
}
function sseJoin(map, key, res) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(res);
}
function sseLeave(map, key, res) {
  const set = map.get(key);
  if (set) { set.delete(res); if (!set.size) map.delete(key); }
}

function alertPayload(u, d) {
  const name = maskWords(d.donor_name, u.blocked_words);
  const message = maskWords(d.message || '', u.blocked_words);
  return {
    id: d.id,
    name,
    amount: d.amount,
    message,
    seconds: u.alert_seconds,
    accent: u.accent,
    speak: !!u.tts && d.amount >= u.min_tts && !!d.message,
    rate: u.tts_rate ?? 1,
    volume: u.tts_volume ?? 1,
    pitch: u.tts_pitch ?? 1,
    speech: `${name} โดเนท ${thaiNumber(d.amount)} บาท${message ? ' ' + message : ''}`
  };
}
function markPaid(donationId) {
  const d = db.prepare('SELECT * FROM donations WHERE id = ?').get(donationId);
  if (!d || d.status === 'paid') return null;
  db.prepare("UPDATE donations SET status='paid', paid_at=? WHERE id=?").run(now(), d.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
  pushToOverlay(u.overlay_token, 'donation', alertPayload(u, d));
  const summary = { id: d.id, donor_name: d.donor_name, amount: d.amount, message: d.message, created_at: d.created_at, paid_at: now(), username: u.username };
  pushToDash(u.id, 'donation-paid', summary);
  pushToAdmins('admin-donation', { action: 'paid', ...summary });
  pushToRef(d.ref, 'status', { status: 'paid' });
  return d;
}
function markRejected(d) {
  db.prepare("UPDATE donations SET status='rejected' WHERE id=?").run(d.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
  pushToDash(u.id, 'donation-rejected', { id: d.id, donor_name: d.donor_name, amount: d.amount });
  pushToAdmins('admin-donation', { action: 'rejected', id: d.id, username: u.username, donor_name: d.donor_name, amount: d.amount });
  pushToRef(d.ref, 'status', { status: 'rejected' });
}

/* --------------------------------- auth API ------------------------------ */
app.post('/api/register', limit('reg', 8, 3600e3), (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const username = clean(req.body.username, 20).toLowerCase();
  const displayName = clean(req.body.displayName, 40) || username;
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'อีเมลไม่ถูกต้อง' });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องเป็น a-z 0-9 _ ยาว 3-20 ตัวอักษร' });
  if (RESERVED.has(username)) return res.status(400).json({ error: 'ชื่อผู้ใช้นี้ถูกสงวนไว้' });
  if (password.length < 8) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? OR username = ?').get(email, username))
    return res.status(409).json({ error: 'อีเมลหรือชื่อผู้ใช้นี้ถูกใช้แล้ว' });
  const role = ADMIN_EMAIL && email === ADMIN_EMAIL ? 'admin' : 'user';
  const info = db.prepare(`INSERT INTO users (email, username, display_name, password_hash, role, overlay_token, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(email, username, displayName, bcrypt.hashSync(password, 10), role, rand(18), now());
  startSession(req, res, Number(info.lastInsertRowid));
  res.json({ ok: true });
});

app.post('/api/login', limit('login', 20, 900e3), (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash))
    return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
  if (u.banned) return res.status(403).json({ error: 'บัญชีนี้ถูกระงับ' });
  if (ADMIN_EMAIL && u.email === ADMIN_EMAIL && u.role !== 'admin') db.prepare("UPDATE users SET role='admin' WHERE id=?").run(u.id);
  startSession(req, res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, siteName: SITE_NAME }));

app.get('/api/public/stats', (req, res) => {
  const a = db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 0').get().c;
  const b = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM donations WHERE status='paid'").get();
  res.json({ streamers: a, donations: b.c, total: b.s });
});

/* --------------------------- streamer settings API ----------------------- */
app.patch('/api/settings', needAuth, (req, res) => {
  const b = req.body || {};
  const promptpay = String(b.promptpayId ?? '').replace(/[\s-]/g, '');
  if (promptpay && !/^(\d{10}|\d{13}|\d{15})$/.test(promptpay))
    return res.status(400).json({ error: 'PromptPay ต้องเป็นเบอร์โทร 10 หลัก หรือเลขบัตรประชาชน 13 หลัก' });
  const accent = /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : req.user.accent;
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const flt = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  db.prepare(`UPDATE users SET display_name=?, bio=?, promptpay_id=?, min_amount=?, alert_seconds=?, accent=?, tts=?, min_tts=?, blocked_words=?, tts_rate=?, tts_volume=?, tts_pitch=? WHERE id=?`)
    .run(clean(b.displayName, 40) || req.user.display_name, clean(b.bio, 200), promptpay,
      int(b.minAmount, 1, 100000, 20), int(b.alertSeconds, 3, 30, 8), accent, b.tts ? 1 : 0,
      int(b.minTts, 1, 100000, 50), clean(b.blockedWords, 300),
      flt(b.ttsRate, 0.5, 2, 1), flt(b.ttsVolume, 0, 1, 1), flt(b.ttsPitch, 0.5, 2, 1), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

app.post('/api/dashboard/rotate-token', needAuth, (req, res) => {
  const old = req.user.overlay_token;
  const t = rand(18);
  db.prepare('UPDATE users SET overlay_token=? WHERE id=?').run(t, req.user.id);
  const set = overlayClients.get(old);
  if (set) { for (const r of set) r.end(); overlayClients.delete(old); }
  res.json({ overlayToken: t });
});

app.get('/api/dashboard/summary', needAuth, (req, res) => {
  const paid = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM donations WHERE user_id=? AND status='paid'").get(req.user.id);
  const month = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM donations WHERE user_id=? AND status='paid' AND paid_at >= ?")
    .get(req.user.id, now() - 30 * 86400e3).s;
  const pending = db.prepare("SELECT COUNT(*) c FROM donations WHERE user_id=? AND status='pending'").get(req.user.id).c;
  res.json({ count: paid.c, total: paid.s, month, pending });
});

app.get('/api/dashboard/donations', needAuth, (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT id, donor_name, amount, message, status, slip != '' AS has_slip, created_at, paid_at FROM donations
    WHERE user_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 200`)
    .all(...(status ? [req.user.id, status] : [req.user.id]));
  res.json({ donations: rows });
});

function ownDonation(req, res) {
  const d = db.prepare('SELECT * FROM donations WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!d) res.status(404).json({ error: 'ไม่พบรายการ' });
  return d;
}
app.post('/api/dashboard/donations/:id/approve', needAuth, (req, res) => {
  const d = ownDonation(req, res); if (!d) return;
  if (d.status === 'rejected') return res.status(400).json({ error: 'รายการนี้ถูกปฏิเสธไปแล้ว' });
  markPaid(d.id);
  res.json({ ok: true });
});
app.post('/api/dashboard/donations/:id/reject', needAuth, (req, res) => {
  const d = ownDonation(req, res); if (!d) return;
  if (d.status === 'paid') return res.status(400).json({ error: 'รายการนี้ยืนยันไปแล้ว' });
  markRejected(d);
  res.json({ ok: true });
});
app.post('/api/dashboard/donations/:id/replay', needAuth, (req, res) => {
  const d = ownDonation(req, res); if (!d) return;
  if (d.status !== 'paid') return res.status(400).json({ error: 'เล่นซ้ำได้เฉพาะรายการที่ยืนยันแล้ว' });
  res.json({ ok: true, clients: pushToOverlay(req.user.overlay_token, 'donation', alertPayload(req.user, d)) });
});
app.post('/api/dashboard/test-alert', needAuth, (req, res) => {
  const fake = { id: 0, donor_name: 'ผู้ใช้ทดสอบ', amount: 100, message: 'ทดสอบระบบแจ้งเตือน ขอบคุณที่สตรีมนะครับ' };
  const clients = pushToOverlay(req.user.overlay_token, 'donation', alertPayload(req.user, fake));
  res.json({ ok: true, clients });
});
app.get('/api/dashboard/slip/:id', needAuth, (req, res) => {
  const d = ownDonation(req, res); if (!d) return;
  if (!d.slip) return res.status(404).json({ error: 'ไม่มีสลิป' });
  res.sendFile(path.join(UPLOAD_DIR, path.basename(d.slip)));
});

/* ------------------------------ public donate API ------------------------ */
function findStreamer(username) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND banned = 0').get(String(username).toLowerCase());
  return u || null;
}
app.get('/api/streamer/:username', (req, res) => {
  const u = findStreamer(req.params.username);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้รับโดเนท' });
  res.json({
    username: u.username, displayName: u.display_name, bio: u.bio, minAmount: u.min_amount,
    accent: u.accent, ready: !!u.promptpay_id, siteName: SITE_NAME
  });
});

app.post('/api/streamer/:username/donate', limit('donate', 15, 600e3), async (req, res) => {
  const u = findStreamer(req.params.username);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้รับโดเนท' });
  if (!u.promptpay_id) return res.status(400).json({ error: 'ผู้รับยังไม่ได้ตั้งค่าช่องทางรับเงิน' });
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isInteger(amount) || amount < u.min_amount) return res.status(400).json({ error: `ขั้นต่ำ ${u.min_amount} บาท` });
  if (amount > 50000) return res.status(400).json({ error: 'สูงสุด 50,000 บาทต่อครั้ง' });
  const name = clean(req.body.name, 30) || 'ผู้ไม่ประสงค์ออกนาม';
  const message = clean(req.body.message, 200);
  const ref = rand(9);
  const info = db.prepare('INSERT INTO donations (user_id, donor_name, amount, message, ref, created_at) VALUES (?,?,?,?,?,?)')
    .run(u.id, name, amount, message, ref, now());
  // แจ้งแดชบอร์ดผู้รับแบบเรียลไทม์ทันที (ไม่ต้องรอรีเฟรช)
  pushToDash(u.id, 'donation-new', {
    id: Number(info.lastInsertRowid), donor_name: name, amount, message, status: 'pending', created_at: now(), has_slip: 0, ref
  });
  pushToAdmins('admin-donation', { action: 'new', username: u.username, donor_name: name, amount });
  const payload = generatePayload(u.promptpay_id, { amount });
  const qr = await QRCode.toDataURL(payload, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  res.json({ ref, amount, qr });
});

app.get('/api/donation/:ref', (req, res) => {
  const d = db.prepare('SELECT status, amount FROM donations WHERE ref = ?').get(String(req.params.ref));
  if (!d) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json(d);
});

// หน้าจ่ายเงินของผู้โดเนท: รอสถานะแบบเรียลไทม์ (แทนการ poll ทุก 3 วินาที)
app.get('/api/donation/:ref/stream', (req, res) => {
  const d = db.prepare('SELECT status FROM donations WHERE ref = ?').get(String(req.params.ref));
  if (!d) return res.status(404).json({ error: 'ไม่พบรายการ' });
  const ping = sseStart(res);
  if (d.status !== 'pending') sseWrite(res, 'status', { status: d.status });
  const ref = String(req.params.ref);
  sseJoin(refClients, ref, res);
  req.on('close', () => { clearInterval(ping); sseLeave(refClients, ref, res); });
});

/* ------------------------- realtime for dashboard ------------------------ */
app.get('/api/dashboard/stream', needAuth, (req, res) => {
  const ping = sseStart(res);
  const uid = req.user.id;
  sseJoin(dashClients, uid, res);
  if (req.user.role === 'admin') adminClients.add(res);
  req.on('close', () => {
    clearInterval(ping);
    sseLeave(dashClients, uid, res);
    adminClients.delete(res);
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, rand(12) + ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype] || '.bin'))
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
});
app.post('/api/donation/:ref/slip', limit('slip', 10, 600e3), upload.single('slip'), (req, res) => {
  const d = db.prepare('SELECT * FROM donations WHERE ref = ?').get(String(req.params.ref));
  if (!d || d.status !== 'pending') return res.status(400).json({ error: 'ไม่สามารถแนบสลิปได้' });
  if (!req.file) return res.status(400).json({ error: 'รองรับเฉพาะไฟล์ PNG/JPG/WEBP ไม่เกิน 3MB' });
  db.prepare('UPDATE donations SET slip = ? WHERE id = ?').run(req.file.filename, d.id);
  res.json({ ok: true });
});

/* ------------------------------ overlay (OBS) ---------------------------- */
app.get('/api/overlay/:token/config', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE overlay_token = ? AND banned = 0').get(req.params.token);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({ accent: u.accent, displayName: u.display_name });
});
app.get('/api/overlay/:token/stream', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE overlay_token = ? AND banned = 0').get(req.params.token);
  if (!u) return res.status(404).end();
  const ping = sseStart(res);
  sseJoin(overlayClients, u.overlay_token, res);
  req.on('close', () => { clearInterval(ping); sseLeave(overlayClients, u.overlay_token, res); });
});

/* ------------------------- payment webhook (gateway) --------------------- */
app.post('/api/webhook/payment', express.raw({ type: '*/*', limit: '20kb' }), (req, res) => {
  if (!WEBHOOK_SECRET) return res.status(503).json({ error: 'webhook disabled' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = Buffer.from(String(req.get('x-signature') || ''), 'hex');
  const expect = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest();
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return res.status(401).json({ error: 'bad signature' });
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
  const d = db.prepare('SELECT * FROM donations WHERE ref = ?').get(String(body.ref || ''));
  if (!d) return res.status(404).json({ error: 'unknown ref' });
  if (body.status !== 'paid' || Number(body.amount) !== d.amount) return res.status(400).json({ error: 'status/amount mismatch' });
  markPaid(d.id);
  res.json({ ok: true });
});

/* --------------------------------- admin API ----------------------------- */
app.get('/api/admin/overview', needAuth, needAdmin, (req, res) => {
  const users = db.prepare(`SELECT u.id, u.email, u.username, u.display_name, u.role, u.banned, u.created_at,
    (SELECT COUNT(*) FROM donations d WHERE d.user_id=u.id AND d.status='paid') AS paid_count,
    (SELECT COALESCE(SUM(amount),0) FROM donations d WHERE d.user_id=u.id AND d.status='paid') AS paid_total
    FROM users u ORDER BY u.created_at DESC LIMIT 300`).all();
  const donations = db.prepare(`SELECT d.id, d.donor_name, d.amount, d.status, d.created_at, u.username
    FROM donations d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 100`).all();
  const t = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM donations WHERE status='paid'").get();
  res.json({ users, donations, totals: { users: users.length, paidCount: t.c, paidTotal: t.s } });
});

// สถิติสำหรับกราฟหน้าแอดมิน
app.get('/api/admin/stats', needAuth, needAdmin, (req, res) => {
  const dayMs = 86400e3;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const since = today.getTime() - 29 * dayMs;
  const totals = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    banned: db.prepare('SELECT COUNT(*) c FROM users WHERE banned=1').get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM donations WHERE status='pending'").get().c,
    paidCount: db.prepare("SELECT COUNT(*) c FROM donations WHERE status='paid'").get().c,
    paidTotal: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM donations WHERE status='paid'").get().s,
    todayCount: db.prepare("SELECT COUNT(*) c FROM donations WHERE status='paid' AND paid_at >= ?").get(today.getTime()).c,
    todayTotal: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM donations WHERE status='paid' AND paid_at >= ?").get(today.getTime()).s
  };
  const daily = [];
  const donationsByDay = db.prepare(`SELECT strftime('%Y-%m-%d', paid_at/1000, 'unixepoch', 'localtime') d, COUNT(*) c, COALESCE(SUM(amount),0) s
    FROM donations WHERE status='paid' AND paid_at >= ? GROUP BY d`).all(since);
  const usersByDay = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') d, COUNT(*) c
    FROM users WHERE created_at >= ? GROUP BY d`).all(since);
  const dm = new Map(donationsByDay.map(x => [x.d, x]));
  const um = new Map(usersByDay.map(x => [x.d, x]));
  for (let i = 0; i < 30; i++) {
    const dte = new Date(since + i * dayMs);
    const key = dte.getFullYear() + '-' + String(dte.getMonth() + 1).padStart(2, '0') + '-' + String(dte.getDate()).padStart(2, '0');
    daily.push({ date: key, donations: dm.get(key)?.c || 0, total: dm.get(key)?.s || 0, users: um.get(key)?.c || 0 });
  }
  const top = db.prepare(`SELECT u.username, u.display_name, COUNT(d.id) c, COALESCE(SUM(d.amount),0) s
    FROM donations d JOIN users u ON u.id=d.user_id WHERE d.status='paid'
    GROUP BY d.user_id ORDER BY s DESC LIMIT 8`).all();
  res.json({ totals, daily, top });
});

// รายชื่อผู้ใช้ + ค้นหา
app.get('/api/admin/users', needAuth, needAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const filter = ['all', 'banned', 'admins'].includes(req.query.filter) ? req.query.filter : 'all';
  let where = '1=1';
  const args = [];
  if (q) { where += ' AND (u.email LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (filter === 'banned') where += ' AND u.banned = 1';
  if (filter === 'admins') where += " AND u.role = 'admin'";
  const users = db.prepare(`SELECT u.id, u.email, u.username, u.display_name, u.role, u.banned, u.promptpay_id, u.created_at,
    (SELECT COUNT(*) FROM donations d WHERE d.user_id=u.id AND d.status='paid') AS paid_count,
    (SELECT COALESCE(SUM(amount),0) FROM donations d WHERE d.user_id=u.id AND d.status='paid') AS paid_total,
    (SELECT COUNT(*) FROM donations d WHERE d.user_id=u.id AND d.status='pending') AS pending_count
    FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 100`).all(...args);
  res.json({ users });
});

// ระงับ/ปลดระงับบัญชี
app.post('/api/admin/users/:id/ban', needAuth, needAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'ระงับตัวเองไม่ได้' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(req.body.banned ? 1 : 0, id);
  if (req.body.banned) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  pushToAdmins('admin-user', { action: req.body.banned ? 'ban' : 'unban', username: u.username });
  res.json({ ok: true });
});

// แก้ไขข้อมูลผู้ใช้จากหลังบ้าน
app.patch('/api/admin/users/:id', needAuth, needAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const b = req.body || {};
  const promptpay = String(b.promptpayId ?? u.promptpay_id).replace(/[\s-]/g, '');
  if (promptpay && !/^(\d{10}|\d{13}|\d{15})$/.test(promptpay))
    return res.status(400).json({ error: 'PromptPay ต้องเป็นเบอร์โทร 10 หลัก หรือเลขบัตร 13 หลัก' });
  const role = ['admin', 'user'].includes(b.role) ? b.role : u.role;
  if (u.role === 'admin' && role === 'user' && id === req.user.id)
    return res.status(400).json({ error: 'ถอดสิทธิ์ตัวเองไม่ได้' });
  db.prepare('UPDATE users SET display_name=?, promptpay_id=?, role=? WHERE id=?')
    .run(clean(b.displayName, 40) || u.display_name, promptpay, role, id);
  res.json({ ok: true });
});

// ลบบัญชี (ลบสลิป + รายการโดเนท + session ของเจ้าของด้วย)
app.delete('/api/admin/users/:id', needAuth, needAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'ลบตัวเองไม่ได้' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (String(req.body?.confirm || '').toLowerCase() !== u.username)
    return res.status(400).json({ error: 'พิมพ์ชื่อผู้ใช้ไม่ตรงกัน ยืนยันไม่สำเร็จ' });
  for (const d of db.prepare('SELECT slip FROM donations WHERE user_id=?').all(id))
    if (d.slip) fs.rm(path.join(UPLOAD_DIR, path.basename(d.slip)), { force: true }, () => {});
  db.prepare('DELETE FROM donations WHERE user_id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

// รายการโดเนททั้งระบบ + ค้นหา/กรอง
app.get('/api/admin/donations', needAuth, needAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : null;
  let where = '1=1';
  const args = [];
  if (q) { where += ' AND (d.donor_name LIKE ? OR d.ref LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where += ' AND d.status = ?'; args.push(status); }
  const rows = db.prepare(`SELECT d.id, d.ref, d.donor_name, d.amount, d.message, d.status, d.slip != '' AS has_slip, d.created_at, d.paid_at,
    u.username, u.display_name FROM donations d JOIN users u ON u.id=d.user_id
    WHERE ${where} ORDER BY d.created_at DESC LIMIT 150`).all(...args);
  res.json({ donations: rows });
});

app.post('/api/admin/donations/:id/approve', needAuth, needAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM donations WHERE id=?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (d.status === 'paid') return res.status(400).json({ error: 'ยืนยันไปแล้ว' });
  markPaid(d.id);
  res.json({ ok: true });
});
app.post('/api/admin/donations/:id/reject', needAuth, needAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM donations WHERE id=?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (d.status === 'paid') return res.status(400).json({ error: 'รายการนี้ยืนยันไปแล้ว' });
  markRejected(d);
  res.json({ ok: true });
});
app.delete('/api/admin/donations/:id', needAuth, needAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM donations WHERE id=?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (d.slip) fs.rm(path.join(UPLOAD_DIR, path.basename(d.slip)), { force: true }, () => {});
  db.prepare('DELETE FROM donations WHERE id=?').run(d.id);
  res.json({ ok: true });
});
// ดูสลิปจากหลังบ้าน
app.get('/api/admin/slip/:id', needAuth, needAdmin, (req, res) => {
  const d = db.prepare('SELECT slip FROM donations WHERE id=?').get(Number(req.params.id));
  if (!d || !d.slip) return res.status(404).json({ error: 'ไม่มีสลิป' });
  res.sendFile(path.join(UPLOAD_DIR, path.basename(d.slip)));
});

/* -------------------------------- pages --------------------------------- */
const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false, maxAge: '1h' }));
app.get('/', page('index.html'));
app.get(['/auth', '/login', '/register'], page('auth.html'));
app.get('/dashboard', page('dashboard.html'));
app.get('/admin', page('admin.html'));
app.get('/overlay/:token', page('overlay.html'));
app.get('/:username', (req, res, next) => {
  const n = req.params.username.toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(n) || RESERVED.has(n)) return next();
  page('donate.html')(req, res);
});
app.use((req, res) => (req.path.startsWith('/api') ? res.status(404).json({ error: 'not found' }) : res.status(404).sendFile(path.join(__dirname, 'public', '404.html'))));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message?.includes('File too large') ? 'ไฟล์ใหญ่เกิน 3MB' : 'เกิดข้อผิดพลาดของเซิร์ฟเวอร์' });
});

// housekeeping: expired sessions, stale pending donations
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now());
  db.prepare("UPDATE donations SET status='rejected' WHERE status='pending' AND created_at < ?").run(now() - 3 * 86400e3);
}, 3600e3).unref();

app.listen(PORT, () => console.log(`${SITE_NAME} running on http://localhost:${PORT}`));
