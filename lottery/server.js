// Lucky-draw server: QR registration → number by screen + email → host draws
// 5 surgeons + 5 assistants per round, 4 rounds (40 winners total).
// No external CDN / Google services: everything is served from this process,
// so it works from mainland-China networks and on an offline venue LAN.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString('hex');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const EVENT_NAME = process.env.EVENT_NAME || 'Lucky Draw';
const ROUNDS = Number(process.env.ROUNDS || 4);
const PER_ROLE = Number(process.env.PER_ROLE || 5); // surgeons and assistants each
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- storage (JSON file, atomic writes) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { registrationOpen: true, nextNumber: 1, registrants: [], rounds: {} };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const fmt = (n) => String(n).padStart(3, '0');

// ---------- email (optional; configure SMTP_* env vars) ----------
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = require('nodemailer').createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendNumberMail(r) {
  if (!mailer) { r.mail = 'not-configured'; return; }
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: r.email,
      subject: `${EVENT_NAME} - Your number is ${fmt(r.number)}`,
      text:
        `Dear ${r.name},\n\nThank you for registering for the ${EVENT_NAME}.\n\n` +
        `Your lottery number: ${fmt(r.number)}\n\n` +
        `Name: ${r.name}\nAffiliation: ${r.affiliation}\nCountry: ${r.country}\n\n` +
        `Please keep this number. Winners will be announced on screen at the venue.\n`,
    });
    r.mail = 'sent';
  } catch (e) {
    r.mail = 'failed: ' + e.message;
    console.error('mail error', r.email, e.message);
  }
  save();
}

// ---------- drawing ----------
function winnerIds() {
  const ids = new Set();
  for (const rd of Object.values(db.rounds)) for (const w of rd.winners) if (!w.absent) ids.add(w.number);
  return ids;
}
function absentIds() {
  const ids = new Set();
  for (const rd of Object.values(db.rounds)) for (const w of rd.winners) if (w.absent) ids.add(w.number);
  return ids;
}
function eligible() {
  const won = winnerIds(), absent = absentIds();
  return db.registrants.filter((r) => !won.has(r.number) && !absent.has(r.number));
}
function pickRandom(pool, k) {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
function drawRound(round) {
  if (db.rounds[round]) throw new Error(`Round ${round} has already been drawn. Reset it first.`);
  const pool = eligible();
  const need = PER_ROLE * 2;
  if (pool.length < need) throw new Error(`Not enough eligible registrants (${pool.length}/${need}).`);
  const picks = pickRandom(pool, need);
  db.rounds[round] = {
    drawnAt: new Date().toISOString(),
    winners: picks.map((r, i) => ({ number: r.number, role: i < PER_ROLE ? 'Surgeon' : 'Assistant', absent: false })),
  };
  save();
}
function redraw(round, number) {
  const rd = db.rounds[round];
  if (!rd) throw new Error('Round not drawn.');
  const w = rd.winners.find((x) => x.number === number && !x.absent);
  if (!w) throw new Error('Winner not found.');
  const pool = eligible().filter((r) => r.number !== number);
  if (!pool.length) throw new Error('No eligible registrants left.');
  w.absent = true;
  const [p] = pickRandom(pool, 1);
  const idx = rd.winners.indexOf(w);
  rd.winners.splice(idx + 1, 0, { number: p.number, role: w.role, absent: false, replacement: true });
  save();
  return p.number;
}

// ---------- http helpers ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
const isAdmin = (req, url) => {
  const k = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  const a = Buffer.from(String(k)), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}
const baseUrl = (req) => PUBLIC_URL || `http://${req.headers.host}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max = 120) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);

function publicState() {
  const byNum = new Map(db.registrants.map((r) => [r.number, r]));
  const rounds = {};
  for (const [k, rd] of Object.entries(db.rounds))
    rounds[k] = { ...rd, winners: rd.winners.map((w) => ({ ...w, ...pick(byNum.get(w.number)) })) };
  return {
    eventName: EVENT_NAME, roundsTotal: ROUNDS, perRole: PER_ROLE,
    registrationOpen: db.registrationOpen, registrants: db.registrants, rounds,
    eligibleCount: eligible().length, mailConfigured: !!mailer,
  };
}
const pick = (r) => (r ? { name: r.name, affiliation: r.affiliation, country: r.country } : {});
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/register')) return sendFile(res, 'register.html');
    if (req.method === 'GET' && p === '/host') return sendFile(res, 'host.html');
    if (req.method === 'GET' && p === '/api/info')
      return send(res, 200, { eventName: EVENT_NAME, registrationOpen: db.registrationOpen });

    if (req.method === 'POST' && p === '/api/register') {
      if (!db.registrationOpen) return send(res, 403, { error: 'Registration is closed.' });
      const b = await readBody(req);
      const r = { name: clean(b.name), affiliation: clean(b.affiliation, 200), country: clean(b.country, 60), email: clean(b.email, 200).toLowerCase() };
      if (!r.name || !r.affiliation || !r.country || !EMAIL_RE.test(r.email))
        return send(res, 400, { error: 'Please fill in all fields with a valid email.' });
      const existing = db.registrants.find((x) => x.email === r.email);
      if (existing) return send(res, 200, { number: fmt(existing.number), name: existing.name, already: true, mail: !!mailer });
      Object.assign(r, { number: db.nextNumber++, registeredAt: new Date().toISOString(), mail: 'pending' });
      db.registrants.push(r);
      save();
      sendNumberMail(r);
      return send(res, 200, { number: fmt(r.number), name: r.name, mail: !!mailer });
    }

    if (p === '/qr.svg') {
      const target = url.searchParams.get('u') || baseUrl(req) + '/';
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return send(res, 200, svg, 'image/svg+xml');
    }

    // ----- admin -----
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req, url)) return send(res, 401, { error: 'Invalid host key.' });
      const action = p.slice('/api/admin/'.length);
      if (req.method === 'GET' && action === 'state')
        return send(res, 200, { ...publicState(), registerUrl: baseUrl(req) + '/', lanUrls: lanUrls() });
      if (req.method === 'GET' && action === 'export.csv') {
        const byNum = new Map(db.registrants.map((r) => [r.number, r]));
        const roleOf = new Map();
        for (const [k, rd] of Object.entries(db.rounds))
          for (const w of rd.winners) roleOf.set(w.number, w.absent ? `Round ${k} ${w.role} (absent)` : `Round ${k} ${w.role}`);
        const rows = [['Number', 'Name', 'Affiliation', 'Country', 'Email', 'Registered', 'Email status', 'Result']];
        for (const r of byNum.values())
          rows.push([fmt(r.number), r.name, r.affiliation, r.country, r.email, r.registeredAt, r.mail, roleOf.get(r.number) || '']);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lottery.csv"' });
        return res.end('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const round = String(b.round || '');
        if (action === 'draw') { drawRound(round); return send(res, 200, publicState()); }
        if (action === 'redraw') { redraw(round, Number(b.number)); return send(res, 200, publicState()); }
        if (action === 'reset-round') { delete db.rounds[round]; save(); return send(res, 200, publicState()); }
        if (action === 'registration') { db.registrationOpen = !!b.open; save(); return send(res, 200, publicState()); }
        if (action === 'resend-mail') {
          const r = db.registrants.find((x) => x.number === Number(b.number));
          if (!r) return send(res, 404, { error: 'Not found' });
          await sendNumberMail(r);
          return send(res, 200, publicState());
        }
      }
      return send(res, 404, { error: 'Unknown action' });
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

function sendFile(res, name) {
  fs.readFile(path.join(__dirname, 'public', name), (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, 'text/html; charset=utf-8');
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${EVENT_NAME} running on port ${PORT}`);
  console.log(`Registration page : ${PUBLIC_URL || lanUrls()[0] || `http://localhost:${PORT}`}/`);
  for (const u of lanUrls()) console.log(`  LAN             : ${u}/`);
  console.log(`Host screen       : ${PUBLIC_URL || `http://localhost:${PORT}`}/host?key=${ADMIN_KEY}`);
  console.log(`Email             : ${mailer ? 'SMTP ' + process.env.SMTP_HOST : 'NOT configured (number shown on screen only)'}\n`);
});
