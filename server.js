'use strict';
/*
  Casino Night For The Neuro 50/50 raffle server.
  Node 22+, no dependencies. SQLite via node:sqlite, one process, one file.

  Sellers open   /              enter the seller PIN (or the admin PIN) -> signed-in cookie -> /app
  Seller page    /app           needs the cookie
  Legacy link    /s/<SELLER_TOKEN>   sets the cookie and redirects to /app
  API            /api/*         cookie, or header x-raffle-token: <SELLER_TOKEN>
  Admin actions  draw, winner email, reset, change seller PIN need ADMIN_PIN in the body.
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'raffle.db');
const EVENT_NAME = process.env.EVENT_NAME || 'Casino Night For The Neuro 2026';
const EVENT_DATE = process.env.EVENT_DATE || 'Friday, October 16, 2026';
const LICENCE_TEXT = process.env.LICENCE_TEXT || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ORG_NAME = process.env.ORG_NAME || "Montreal's Elite Real Estate Group";
const ORG_ADDRESS = process.env.ORG_ADDRESS || '15F Av. Cartier, Pointe-Claire, QC H9S 4R5';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Logan Boyce <logan@eliterealestategroup.com>';
const GHL_PIT = process.env.GHL_PIT || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const GHL_TAG = process.env.GHL_TAG || '5050-raffle-2026';
const MAIL_DRY_RUN = process.env.MAIL_DRY_RUN === '1';
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || (MAIL_DRY_RUN ? 'dry' : (GHL_PIT && GHL_LOCATION_ID ? 'ghl' : 'none'));
const GHL_BASE = 'https://services.leadconnectorhq.com';
const PACKAGES = [{ t: 1, p: 5 }, { t: 3, p: 10 }, { t: 10, p: 20 }, { t: 40, p: 50 }, { t: 100, p: 100 }];
const MAX_QTY = 10;
const SESSION_DAYS = 30;
const COOKIE = 'raffle_s';

/* ---------------- database ---------------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, pkg_tickets INTEGER NOT NULL, pkg_price INTEGER NOT NULL,
    qty INTEGER NOT NULL, tickets INTEGER NOT NULL, amount INTEGER NOT NULL,
    from_no INTEGER NOT NULL, to_no INTEGER NOT NULL, created_at TEXT NOT NULL, seller TEXT,
    voided INTEGER NOT NULL DEFAULT 0, voided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS mails (
    id TEXT PRIMARY KEY, sale_id TEXT, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL,
    html TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at TEXT NOT NULL, sent_at TEXT, next_at TEXT NOT NULL, provider_id TEXT
  );
  CREATE INDEX IF NOT EXISTS mails_status ON mails (status, next_at);
  CREATE INDEX IF NOT EXISTS mails_sale ON mails (sale_id, created_at);
  CREATE TABLE IF NOT EXISTS cash (
    id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL, note TEXT, seller TEXT, created_at TEXT NOT NULL
  );
`);
if (!db.prepare('PRAGMA table_info(sales)').all().some(c => c.name === 'paid')) db.exec("ALTER TABLE sales ADD COLUMN paid TEXT NOT NULL DEFAULT 'square'");
const q = {
  getS: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setS: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  sales: db.prepare('SELECT * FROM sales ORDER BY from_no ASC'),
  sale: db.prepare('SELECT * FROM sales WHERE id = ?'),
  insSale: db.prepare('INSERT INTO sales (id, email, pkg_tickets, pkg_price, qty, tickets, amount, from_no, to_no, created_at, seller, paid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  cashAll: db.prepare('SELECT * FROM cash ORDER BY created_at ASC'),
  insCash: db.prepare('INSERT INTO cash (id, amount_cents, note, seller, created_at) VALUES (?, ?, ?, ?, ?)'),
  delCash: db.prepare('DELETE FROM cash WHERE id = ?'),
  delAllCash: db.prepare('DELETE FROM cash'),
  voidSale: db.prepare('UPDATE sales SET voided = ?, voided_at = ? WHERE id = ?'),
  emailSale: db.prepare('UPDATE sales SET email = ? WHERE id = ?'),
  delSales: db.prepare('DELETE FROM sales'),
  delMails: db.prepare('DELETE FROM mails'),
  insMail: db.prepare('INSERT INTO mails (id, sale_id, kind, to_email, subject, html, status, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  dueMails: db.prepare("SELECT * FROM mails WHERE status IN ('queued','retry') AND next_at <= ? ORDER BY created_at ASC LIMIT 20"),
  mailOk: db.prepare("UPDATE mails SET status = 'sent', sent_at = ?, provider_id = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?"),
  mailFail: db.prepare('UPDATE mails SET status = ?, attempts = attempts + 1, last_error = ?, next_at = ? WHERE id = ?'),
  latestMails: db.prepare("SELECT m.sale_id, m.status, m.sent_at, m.last_error, m.attempts, m.to_email FROM mails m WHERE m.kind = 'confirmation' AND m.created_at = (SELECT MAX(created_at) FROM mails x WHERE x.sale_id = m.sale_id AND x.kind = 'confirmation')"),
  winnerMails: db.prepare("SELECT status, sent_at, last_error, to_email FROM mails WHERE kind = 'winner' ORDER BY created_at DESC LIMIT 1"),
};
const getS = (k, d) => { const r = q.getS.get(k); return r ? r.value : d; };
const setS = (k, v) => { q.setS.run(k, String(v)); };
const getOrCreate = (k, make) => { let v = getS(k); if (v === undefined) { v = make(); setS(k, v); } return v; };
const nowIso = () => new Date().toISOString();
const bump = () => { const v = Number(getS('version', '0')) + 1; setS('version', v); return v; };
if (getS('next') === undefined) setS('next', 1);
if (getS('status') === undefined) setS('status', 'open');
if (getS('version') === undefined) setS('version', 1);

const SELLER_TOKEN = process.env.SELLER_TOKEN || getOrCreate('seller_token', () => crypto.randomBytes(18).toString('base64url'));
const ADMIN_PIN = process.env.ADMIN_PIN || getOrCreate('admin_pin', () => String(crypto.randomInt(100000, 1000000)));
const SESSION_SECRET = getOrCreate('session_secret', () => crypto.randomBytes(32).toString('hex'));

/* ---------------- helpers ---------------- */
const log = (msg, extra) => console.log(JSON.stringify(Object.assign({ t: nowIso(), msg }, extra || {})));
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const money = n => { n = Number(n) || 0; return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n); };
const moneyFr = n => { n = Number(n) || 0; return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const randomInt = n => crypto.randomInt(0, n); // crypto-secure, unbiased

/* ---------------- seller PIN + sessions ---------------- */
const sellerPinHash = pin => crypto.createHmac('sha256', SESSION_SECRET).update('seller:' + pin).digest('hex');
if (getS('seller_pin_hash') === undefined) {
  const seed = process.env.SELLER_PIN || String(crypto.randomInt(1000, 10000));
  setS('seller_pin_hash', sellerPinHash(seed)); setS('seller_pin_gen', '1');
  log('seller PIN initialised', { pin: process.env.SELLER_PIN ? '(from SELLER_PIN env)' : ('generated: ' + seed + ' (change it in Settings)') });
}
const sign = payload => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
function issueSession() { const payload = (Date.now() + SESSION_DAYS * 864e5) + '.' + getS('seller_pin_gen', '1'); return payload + '.' + sign(payload); }
function validSession(cookieHeader) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(cookieHeader || ''); if (!m) return false;
  const parts = m[1].split('.'); if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  if (!safeEq(sign(payload), parts[2])) return false;
  if (!(Number(parts[0]) > Date.now())) return false;
  return parts[1] === getS('seller_pin_gen', '1');
}
function cookieFor(req, value, maxAge) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || PUBLIC_URL.startsWith('https');
  return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}
function gateCheck(ip, pin) {
  pin = String(pin || '').trim();
  const f = gateFails.get(ip);
  if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, 'locked', 'Too many wrong PINs. Try again in 10 minutes.');
  const ok = pin && (safeEq(sellerPinHash(pin), getS('seller_pin_hash')) || safeEq(pin, ADMIN_PIN));
  if (!ok) {
    const g = f && f.until > Date.now() ? f : { n: 0 };
    g.n++; g.until = Date.now() + 10 * 60 * 1000; gateFails.set(ip, g);
    throw new HttpError(401, 'badpin', 'That PIN isn’t right.');
  }
  gateFails.delete(ip);
}
function changeSellerPin(ip, adminPin, newPin) {
  checkPin(ip, adminPin);
  newPin = String(newPin || '').trim();
  if (!/^\d{4,8}$/.test(newPin)) throw new HttpError(400, 'badnewpin', 'The seller PIN must be 4 to 8 digits.');
  if (safeEq(newPin, ADMIN_PIN)) throw new HttpError(400, 'samepin', 'Choose a seller PIN that is different from the admin PIN.');
  setS('seller_pin_hash', sellerPinHash(newPin));
  setS('seller_pin_gen', String(Number(getS('seller_pin_gen', '1')) + 1)); // signs every phone out
  bump();
  log('seller PIN changed', { ip });
}

function readState() {
  const draw = getS('draw');
  return { next: Number(getS('next', '1')), status: getS('status', 'open'), draw: draw ? JSON.parse(draw) : null, resetAt: getS('reset_at') || null };
}
function rowToSale(r) {
  return { id: r.id, email: r.email, pkgTickets: r.pkg_tickets, pkgPrice: r.pkg_price, qty: r.qty, tickets: r.tickets, amount: r.amount, from: r.from_no, to: r.to_no, createdAt: r.created_at, seller: r.seller || null, paid: r.paid === 'cash' ? 'cash' : 'square', voided: !!r.voided, voidedAt: r.voided_at || null };
}
function listCash() {
  const entries = q.cashAll.all().map(r => ({ id: r.id, amount: r.amount_cents / 100, note: r.note || '', seller: r.seller || null, createdAt: r.created_at }));
  return { entries, total: entries.reduce((n, e) => n + e.amount, 0) };
}
function addCash(body, ip) {
  const amount = Math.round(Number(String(body.amount == null ? '' : body.amount).replace(/[^0-9.]/g, '')) * 100);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new HttpError(400, 'badamount', 'Enter a cash amount above zero.');
  const note = String(body.note || '').trim().slice(0, 80);
  const seller = String(body.seller || '').slice(0, 60) || null;
  const id = crypto.randomBytes(6).toString('base64url');
  q.insCash.run(id, amount, note, seller, nowIso()); bump();
  log('cash', { id, amount: amount / 100, note, ip });
  return { id, amount: amount / 100, note, seller, createdAt: nowIso() };
}
function removeCash(id) { q.delCash.run(id); bump(); }
function listSales() {
  const mails = {};
  for (const m of q.latestMails.all()) mails[m.sale_id] = { status: m.status, sentAt: m.sent_at, error: m.last_error, attempts: m.attempts, to: m.to_email };
  return q.sales.all().map(r => Object.assign(rowToSale(r), { mail: mails[r.id] || null }));
}
function totals(sales) {
  let tickets = 0, gross = 0, buyers = 0, grossSquare = 0, grossCash = 0;
  for (const s of sales) if (!s.voided) { tickets += s.to - s.from + 1; gross += s.amount; buyers++; if (s.paid === 'cash') grossCash += s.amount; else grossSquare += s.amount; }
  return { tickets, gross, buyers, half: gross / 2, grossSquare, grossCash };
}
function snapshot() {
  const sales = listSales();
  const state = readState();
  const wm = q.winnerMails.get();
  const t = totals(sales);
  const cash = listCash();
  return {
    version: Number(getS('version', '1')),
    state: Object.assign(state, { winnerMail: wm ? { status: wm.status, sentAt: wm.sent_at, error: wm.last_error, to: wm.to_email } : null }),
    sales, totals: t, cash,
    fund: fundSnapshot(t, cash.total), fundSettings: fundSettingsView(),
    config: { eventName: EVENT_NAME, eventDate: EVENT_DATE, licence: LICENCE_TEXT, packages: PACKAGES, maxQty: MAX_QTY, emailProvider: EMAIL_PROVIDER, publicUrl: PUBLIC_URL },
  };
}

/* ---------------- email ---------------- */
function ticketWords(sale) {
  const n = sale.to - sale.from + 1;
  if (n === 1) return { en: 'ticket #' + sale.from, fr: 'billet n° ' + sale.from };
  return { en: 'tickets #' + sale.from + ' to #' + sale.to, fr: 'billets n° ' + sale.from + ' à ' + sale.to };
}
function ticketChips(sale) {
  const n = sale.to - sale.from + 1;
  if (n > 40) return '<div style="font:700 34px/1.1 Georgia,serif;color:#201613;margin:6px 0">#' + sale.from + ' &rarr; #' + sale.to + '</div><div style="color:#5c4a44;font-size:14px">' + n + ' tickets / billets</div>';
  let out = '<div style="margin:6px 0">';
  for (let i = sale.from; i <= sale.to; i++) out += '<span style="display:inline-block;margin:3px 4px 3px 0;padding:6px 10px;border:1px solid #d6281f;border-radius:999px;color:#201613;font:700 16px/1 Georgia,serif">#' + i + '</span>';
  return out + '</div>';
}
function layout(inner) {
  return '<!doctype html><html><body style="margin:0;background:#f9f7f1;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#362117">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6dfd3;border-radius:12px;padding:28px 24px">' +
    '<div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#d6281f;font-weight:700">50/50 Raffle &middot; Tirage moiti&eacute;-moiti&eacute;</div>' +
    '<div style="font:800 26px/1.1 Georgia,serif;color:#201613;margin:6px 0 18px">' + esc(EVENT_NAME) + '</div>' +
    inner +
    '<hr style="border:0;border-top:1px solid #e6dfd3;margin:24px 0 14px">' +
    '<div style="font-size:12px;color:#7a6a63;line-height:1.5">' + esc(ORG_NAME) + ' &middot; ' + esc(ORG_ADDRESS) +
    (LICENCE_TEXT ? '<br>' + esc(LICENCE_TEXT) : '') +
    '<br>Questions? Reply to this email. / Des questions? R&eacute;pondez &agrave; ce courriel.</div>' +
    '</div></body></html>';
}
function confirmationMail(sale) {
  const tw = ticketWords(sale);
  const pkg = sale.pkgTickets + ' for ' + money(sale.pkgPrice) + (sale.qty > 1 ? ' x ' + sale.qty : '');
  const subject = 'Your 50/50 raffle ' + tw.en + ' / Vos ' + tw.fr + ' du tirage moitié-moitié';
  const html = layout(
    '<p style="margin:0 0 10px;font-size:16px;line-height:1.5">Thank you for supporting The Neuro. Here are your raffle numbers. Keep this email as your proof of purchase.</p>' +
    ticketChips(sale) +
    '<table style="border-collapse:collapse;margin:14px 0;font-size:14px" cellpadding="0"><tr><td style="padding:4px 14px 4px 0;color:#7a6a63">Tickets / Billets</td><td style="padding:4px 0"><b>' + (sale.to - sale.from + 1) + '</b> (' + esc(pkg) + ')</td></tr>' +
    '<tr><td style="padding:4px 14px 4px 0;color:#7a6a63">Paid / Pay&eacute;</td><td style="padding:4px 0"><b>' + esc(money(sale.amount)) + '</b></td></tr>' +
    '<tr><td style="padding:4px 14px 4px 0;color:#7a6a63">Draw / Tirage</td><td style="padding:4px 0">' + esc(EVENT_DATE) + ', end of the night / en fin de soir&eacute;e</td></tr></table>' +
    '<p style="margin:0 0 10px;font-size:15px;line-height:1.5">The winner takes half the pot. The winning number is announced at the event and the winner is contacted at this email address.</p>' +
    '<p style="margin:18px 0 10px;font-size:16px;line-height:1.5">Merci de soutenir le Neuro. Voici vos num&eacute;ros de tirage. Conservez ce courriel comme preuve d&rsquo;achat. Le gagnant remporte la moiti&eacute; de la cagnotte. Le num&eacute;ro gagnant est annonc&eacute; lors de la soir&eacute;e et le gagnant est contact&eacute; &agrave; cette adresse courriel.</p>'
  );
  return { subject, html };
}
function winnerMail(sale, draw) {
  const half = draw.gross / 2;
  const subject = 'You won the 50/50 raffle! / Vous avez gagné le tirage moitié-moitié!';
  const html = layout(
    '<div style="font:800 56px/1 Georgia,serif;color:#d6281f;margin:4px 0 10px">#' + draw.ticket + '</div>' +
    '<p style="margin:0 0 10px;font-size:16px;line-height:1.5">Your ticket <b>#' + draw.ticket + '</b> was drawn as the winning number. The pot was ' + esc(money(draw.gross)) + ', so your prize is <b>' + esc(money(half)) + '</b>. Reply to this email or find Logan at the event to collect it.</p>' +
    '<p style="margin:14px 0 0;font-size:16px;line-height:1.5">Votre billet <b>n&deg; ' + draw.ticket + '</b> a &eacute;t&eacute; tir&eacute; comme num&eacute;ro gagnant. La cagnotte &eacute;tait de ' + esc(moneyFr(draw.gross)) + ', votre prix est donc de <b>' + esc(moneyFr(half)) + '</b>. R&eacute;pondez &agrave; ce courriel ou trouvez Logan sur place pour le r&eacute;cup&eacute;rer.</p>'
  );
  return { subject, html };
}
function queueMail(kind, sale, extra) {
  const m = kind === 'winner' ? winnerMail(sale, extra) : confirmationMail(sale);
  const id = crypto.randomBytes(8).toString('base64url');
  q.insMail.run(id, sale.id, kind, sale.email, m.subject, m.html, 'queued', nowIso(), nowIso());
  setTimeout(processMails, 50);
  return id;
}
async function ghlRequest(method, p, body) {
  const r = await fetch(GHL_BASE + p, { method, headers: { Authorization: 'Bearer ' + GHL_PIT, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'curl/8.7.1' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error('GHL ' + method + ' ' + p + ' -> ' + r.status + ' ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch (e) { return {}; }
}
async function sendViaGhl(to, subject, html) {
  const up = await ghlRequest('POST', '/contacts/upsert', { locationId: GHL_LOCATION_ID, email: to });
  const cid = up && up.contact && up.contact.id;
  if (!cid) throw new Error('GHL upsert returned no contact id');
  if (GHL_TAG) { try { await ghlRequest('POST', '/contacts/' + cid + '/tags', { tags: [GHL_TAG] }); } catch (e) { log('ghl tag failed (continuing)', { error: e.message }); } }
  // The conversations endpoint rejects a free-form replyTo; replies go to EMAIL_FROM's address, which is Logan's own.
  const sent = await ghlRequest('POST', '/conversations/messages', { type: 'Email', contactId: cid, subject, html, emailFrom: EMAIL_FROM });
  return sent.messageId || sent.emailMessageId || 'ok';
}
async function deliver(m) {
  if (EMAIL_PROVIDER === 'dry') return 'dry-run';
  if (EMAIL_PROVIDER === 'ghl') return sendViaGhl(m.to_email, m.subject, m.html);
  throw new Error('No email provider configured (set GHL_PIT and GHL_LOCATION_ID)');
}
let mailBusy = false;
async function processMails() {
  if (mailBusy) return; mailBusy = true;
  try {
    const due = q.dueMails.all(nowIso());
    for (const m of due) {
      try {
        const pid = await deliver(m);
        q.mailOk.run(nowIso(), String(pid), m.id);
        log('mail sent', { id: m.id, kind: m.kind, to: m.to_email, provider: EMAIL_PROVIDER });
      } catch (e) {
        const attempts = m.attempts + 1;
        const giveUp = attempts >= 6;
        const next = new Date(Date.now() + Math.min(30 * 60, 30 * Math.pow(2, attempts)) * 1000).toISOString();
        q.mailFail.run(giveUp ? 'failed' : 'retry', String(e.message).slice(0, 500), next, m.id);
        log('mail failed', { id: m.id, kind: m.kind, to: m.to_email, attempts, giveUp, error: e.message });
      }
      bump();
    }
  } finally { mailBusy = false; }
}
setInterval(processMails, 15000).unref();

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++; return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();
const pinFails = new Map();
const gateFails = new Map();
function checkPin(ip, pin) {
  const f = pinFails.get(ip);
  if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, 'locked', 'Too many wrong PINs. Try again in 10 minutes.');
  if (!safeEq(pin, ADMIN_PIN)) {
    const g = f && f.until > Date.now() ? f : { n: 0 };
    g.n++; g.until = Date.now() + 10 * 60 * 1000; pinFails.set(ip, g);
    throw new HttpError(403, 'badpin', 'That PIN isn’t right.');
  }
  pinFails.delete(ip);
}

/* ---------------- operations ---------------- */
function logSale(body, ip) {
  const email = String(body.email || '').trim();
  const pkgIdx = Number(body.pkg); const qty = Number(body.qty);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'bademail', 'Enter a valid email address.');
  if (!Number.isInteger(pkgIdx) || !PACKAGES[pkgIdx]) throw new HttpError(400, 'badpkg', 'Choose a ticket package.');
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'badqty', 'Quantity must be between 1 and ' + MAX_QTY + '.');
  const pkg = PACKAGES[pkgIdx]; const count = pkg.t * qty;
  const seller = String(body.seller || '').slice(0, 60) || null;
  const paid = body.paid === 'cash' ? 'cash' : 'square';
  let sale;
  db.exec('BEGIN IMMEDIATE');
  try {
    const st = readState();
    if (st.status === 'drawn') throw new HttpError(409, 'closed', 'Sales are closed. The winner has been drawn.');
    const from = st.next, to = from + count - 1;
    const id = crypto.randomBytes(6).toString('base64url');
    const createdAt = nowIso();
    q.insSale.run(id, email, pkg.t, pkg.p, qty, count, pkg.p * qty, from, to, createdAt, seller, paid);
    setS('next', to + 1); bump();
    sale = rowToSale(q.sale.get(id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (EMAIL_PROVIDER !== 'none') queueMail('confirmation', sale);
  log('sale', { id: sale.id, from: sale.from, to: sale.to, amount: sale.amount, ip });
  return sale;
}
function setVoid(id, voided) {
  const r = q.sale.get(id); if (!r) throw new HttpError(404, 'nosale', 'That sale no longer exists.');
  if (readState().status === 'drawn') throw new HttpError(409, 'closed', 'The winner has been drawn. Sales can no longer change.');
  q.voidSale.run(voided ? 1 : 0, voided ? nowIso() : null, id); bump();
  return rowToSale(q.sale.get(id));
}
function changeEmail(id, email) {
  email = String(email || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'bademail', 'Enter a valid email address.');
  const r = q.sale.get(id); if (!r) throw new HttpError(404, 'nosale', 'That sale no longer exists.');
  q.emailSale.run(email, id); bump();
  const sale = rowToSale(q.sale.get(id));
  if (EMAIL_PROVIDER !== 'none') queueMail('confirmation', sale);
  return sale;
}
function resend(id) {
  const r = q.sale.get(id); if (!r) throw new HttpError(404, 'nosale', 'That sale no longer exists.');
  if (EMAIL_PROVIDER === 'none') throw new HttpError(400, 'nomail', 'Email sending is not configured on this server.');
  queueMail('confirmation', rowToSale(r)); bump();
}
function drawWinner(ip, pin) {
  checkPin(ip, pin);
  let draw;
  db.exec('BEGIN IMMEDIATE');
  try {
    const st = readState();
    if (st.status === 'drawn') throw new HttpError(409, 'already', 'The winner was already drawn.');
    const live = q.sales.all().filter(r => !r.voided).map(rowToSale);
    let total = 0, gross = 0; for (const s of live) { total += s.to - s.from + 1; gross += s.amount; }
    if (!total) throw new HttpError(400, 'empty', 'There are no tickets in the drum.');
    const idx = randomInt(total); let acc = 0, win = null;
    for (const s of live) { const n = s.to - s.from + 1; if (idx < acc + n) { win = { ticket: s.from + (idx - acc), email: s.email, saleId: s.id }; break; } acc += n; }
    draw = Object.assign(win, { drawnAt: nowIso(), pool: total, buyers: live.length, gross, drawnBy: ip });
    setS('status', 'drawn'); setS('draw', JSON.stringify(draw)); bump();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  log('draw', draw);
  return draw;
}
function emailWinner(ip, pin) {
  checkPin(ip, pin);
  const st = readState();
  if (st.status !== 'drawn' || !st.draw) throw new HttpError(400, 'notdrawn', 'Draw the winner first.');
  if (EMAIL_PROVIDER === 'none') throw new HttpError(400, 'nomail', 'Email sending is not configured on this server.');
  const r = q.sale.get(st.draw.saleId);
  const sale = r ? rowToSale(r) : { id: st.draw.saleId, email: st.draw.email };
  queueMail('winner', Object.assign({}, sale, { email: st.draw.email }), st.draw); bump();
}
function resetRaffle(ip, pin, word) {
  checkPin(ip, pin);
  if (String(word || '').trim() !== 'RESET') throw new HttpError(400, 'badword', 'Type RESET to confirm.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const n = q.sales.all().length;
    q.delSales.run(); q.delMails.run(); q.delAllCash.run();
    setS('next', 1); setS('status', 'open'); setS('draw', ''); setS('reset_at', nowIso()); bump();
    db.exec('COMMIT');
    log('reset', { deleted: n, ip });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function csv() {
  const rows = listSales(); const st = readState();
  const qv = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = ['ticket_from,ticket_to,tickets,package,quantity,amount_cad,paid_by,email,logged_at,seller,status,confirmation_email'];
  for (const s of rows) lines.push([s.from, s.to, s.to - s.from + 1, qv(s.pkgTickets + ' for $' + s.pkgPrice), s.qty, s.amount, s.paid, qv(s.email), qv(s.createdAt), qv(s.seller || ''), s.voided ? 'voided' : 'live', qv(s.mail ? s.mail.status : '')].join(','));
  if (st.status === 'drawn' && st.draw) { lines.push(''); lines.push('winning_ticket,' + st.draw.ticket + ',' + qv(st.draw.email) + ',' + qv(st.draw.drawnAt)); }
  const cash = listCash();
  if (cash.entries.length) { lines.push(''); lines.push('cash_amount_cad,note,logged_at,seller'); for (const e of cash.entries) lines.push([e.amount, qv(e.note), qv(e.createdAt), qv(e.seller || '')].join(',')); lines.push('cash_total,' + cash.total); }
  return lines.join('\r\n');
}

/* ---------------- fundraising total (Eventbrite + Square + online donations - expenses) ---------------- */
const FUND_DEFAULT_SINCE = process.env.FUND_SQUARE_SINCE || '2026-10-16T00:00:00-04:00';
if (getS('fund_expenses') === undefined) setS('fund_expenses', process.env.EXPENSES || '4000');
if (getS('fund_raffle_in_square') === undefined) setS('fund_raffle_in_square', '1');
if (getS('fund_eventbrite_token') === undefined && process.env.EVENTBRITE_TOKEN) setS('fund_eventbrite_token', process.env.EVENTBRITE_TOKEN);
if (getS('fund_square_token') === undefined && process.env.SQUARE_TOKEN) setS('fund_square_token', process.env.SQUARE_TOKEN);
const fundCache = (() => { try { return JSON.parse(getS('fund_cache', '{}')); } catch (e) { return {}; } })();
const saveFundCache = () => setS('fund_cache', JSON.stringify(fundCache));
const numOr = (v, d) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : d; };
const overrideOf = key => { const v = getS(key, ''); return v === '' ? null : numOr(v, null); };

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + text.slice(0, 160).replace(/\s+/g, ' '));
  return JSON.parse(text);
}
async function pullEventbrite() {
  const token = getS('fund_eventbrite_token', '');
  if (!token) return null;
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  const base = 'https://www.eventbriteapi.com/v3';
  let eventId = getS('fund_eventbrite_event_id', '');
  if (!eventId) {
    const orgs = await fetchJson(base + '/users/me/organizations/', H);
    const candidates = [];
    for (const o of (orgs.organizations || [])) {
      const ev = await fetchJson(base + '/organizations/' + o.id + '/events/?order_by=start_desc&page_size=50&status=live,started,ended,completed', H);
      for (const e of (ev.events || [])) candidates.push(e);
    }
    const pick = candidates.find(e => /casino/i.test((e.name && e.name.text) || '')) || candidates[0];
    if (!pick) throw new Error('No events found on this Eventbrite account');
    eventId = pick.id; setS('fund_eventbrite_event_id', eventId); setS('fund_eventbrite_event_name', (pick.name && pick.name.text) || '');
  }
  let base_cents = 0, gross_cents = 0, tax_cents = 0, fee_cents = 0, orders = 0, cont = '';
  for (let page = 0; page < 50; page++) {
    const j = await fetchJson(base + '/events/' + eventId + '/orders/?page_size=200' + (cont ? '&continuation=' + encodeURIComponent(cont) : ''), H);
    for (const o of (j.orders || [])) {
      if (String(o.status || 'placed').toLowerCase() !== 'placed') continue; // skips refunded / cancelled orders
      const c = o.costs || {};
      const v = k => Number((c[k] && c[k].value) || 0);
      base_cents += v('base_price'); gross_cents += v('gross'); tax_cents += v('tax'); fee_cents += v('eventbrite_fee') + v('payment_fee');
      orders++;
    }
    if (!(j.pagination && j.pagination.has_more_items && j.pagination.continuation)) break;
    cont = j.pagination.continuation;
  }
  const measure = getS('fund_eventbrite_measure', 'base');
  const amount = measure === 'gross' ? gross_cents / 100 : base_cents / 100;
  return { amount, base: base_cents / 100, gross: gross_cents / 100, tax: tax_cents / 100, fees: fee_cents / 100, measure, orders, eventId, eventName: getS('fund_eventbrite_event_name', '') };
}
async function pullSquare() {
  const token = getS('fund_square_token', '');
  if (!token) return null;
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Square-Version': '2025-01-23' };
  const since = getS('fund_square_since', '') || FUND_DEFAULT_SINCE;
  const onlyLoc = getS('fund_square_location', '');
  // ListPayments defaults to the seller's MAIN location only, so walk every active location explicitly.
  let merchant = '';
  try { const m = await fetchJson('https://connect.squareup.com/v2/merchants/me', H); merchant = (m.merchant && (m.merchant.business_name || m.merchant.id)) || ''; } catch (e) { merchant = ''; }
  const locs = await fetchJson('https://connect.squareup.com/v2/locations', H);
  const locations = (locs.locations || []).filter(l => !onlyLoc || l.id === onlyLoc); // inactive locations included: old events may sit there
  if (!locations.length) throw new Error('No Square locations visible to this token');
  let cents = 0, count = 0; const perLocation = [];
  for (const l of locations) {
    let lc = 0, ln = 0, cursor = '';
    for (let page = 0; page < 50; page++) {
      const url = 'https://connect.squareup.com/v2/payments?sort_order=ASC&limit=100&location_id=' + encodeURIComponent(l.id) + '&begin_time=' + encodeURIComponent(new Date(since).toISOString()) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const j = await fetchJson(url, H);
      for (const p of (j.payments || [])) {
        if (p.status !== 'COMPLETED') continue;
        const amt = Number((p.amount_money && p.amount_money.amount) || 0);
        const refunded = Number((p.refunded_money && p.refunded_money.amount) || 0);
        lc += amt - refunded; ln++;
      }
      if (!j.cursor) break; cursor = j.cursor;
    }
    cents += lc; count += ln; perLocation.push({ id: l.id, name: l.name || l.id, status: l.status || 'ACTIVE', amount: lc / 100, count: ln });
  }
  return { amount: cents / 100, count, since, locations: perLocation, merchant };
}
let fundBusy = null, fundLastRun = 0;
function refreshFund(force) {
  if (fundBusy) return fundBusy;
  if (!force && Date.now() - fundLastRun < 15000) return Promise.resolve();
  fundLastRun = Date.now();
  fundBusy = (async () => {
    for (const [key, fn] of [['eventbrite', pullEventbrite], ['square', pullSquare]]) {
      try {
        const r = await fn();
        if (r === null) { if (fundCache[key] && fundCache[key].source === 'api') delete fundCache[key]; continue; }
        fundCache[key] = Object.assign({ source: 'api', at: nowIso(), error: null }, r);
      } catch (e) {
        fundCache[key] = Object.assign({}, fundCache[key] || {}, { error: String(e.message).slice(0, 200), errorAt: nowIso() });
        log('fund pull failed', { source: key, error: e.message });
      }
    }
    saveFundCache(); bump();
  })().finally(() => { fundBusy = null; });
  return fundBusy;
}
setInterval(() => { if (getS('fund_eventbrite_token', '') || getS('fund_square_token', '')) refreshFund(false); }, 120000).unref();
function fundSnapshot(saleTotals, cashTotal) {
  cashTotal = Number(cashTotal) || 0;
  const expenses = numOr(getS('fund_expenses', '4000'), 0);
  const raffleInSquare = getS('fund_raffle_in_square', '1') === '1';
  const ovEb = overrideOf('fund_override_eventbrite'), ovSq = overrideOf('fund_override_square'), ovMc = overrideOf('fund_override_mcgill');
  const eb = fundCache.eventbrite || {}, sq = fundCache.square || {};
  const ebAmount = ovEb !== null ? ovEb : (typeof eb.amount === 'number' ? eb.amount : 0);
  const sqAmount = ovSq !== null ? ovSq : (typeof sq.amount === 'number' ? sq.amount : 0);
  const mcAmount = ovMc !== null ? ovMc : 0;
  const raffleGross = saleTotals.gross, raffleHalf = raffleGross / 2;
  // Only the 50/50 sales that were PAID BY CARD are inside the Square total; cash 50/50 sales never touch Square.
  const onsite = raffleInSquare ? Math.max(0, sqAmount - (saleTotals.grossSquare || 0)) : sqAmount;
  const beforeExpenses = ebAmount + onsite + cashTotal + mcAmount + raffleHalf;
  return {
    total: beforeExpenses - expenses, beforeExpenses, expenses, raffleInSquare, cash: cashTotal,
    eventbrite: { amount: ebAmount, source: ovEb !== null ? 'manual' : (typeof eb.amount === 'number' ? 'api' : 'none'), at: eb.at || null, error: eb.error || null, orders: eb.orders || 0, base: eb.base, gross: eb.gross, fees: eb.fees, tax: eb.tax, measure: getS('fund_eventbrite_measure', 'base'), eventName: eb.eventName || getS('fund_eventbrite_event_name', ''), connected: !!getS('fund_eventbrite_token', '') },
    square: { amount: sqAmount, source: ovSq !== null ? 'manual' : (typeof sq.amount === 'number' ? 'api' : 'none'), at: sq.at || null, error: sq.error || null, count: sq.count || 0, locations: sq.locations || [], merchant: sq.merchant || '', since: getS('fund_square_since', '') || FUND_DEFAULT_SINCE, connected: !!getS('fund_square_token', ''), onsite },
    mcgill: { amount: mcAmount, source: ovMc !== null ? 'manual' : 'none', url: process.env.MCGILL_URL || 'https://crowdfunding.mcgill.ca/ui/main/p/montrealelite2026' },
    raffle: { gross: raffleGross, half: raffleHalf, square: saleTotals.grossSquare || 0, cashPaid: saleTotals.grossCash || 0 },
  };
}
function saveFundSettings(ip, body) {
  checkPin(ip, body.pin);
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  const setOrClear = (key, v) => { if (v == null || String(v).trim() === '') setS(key, ''); else setS(key, String(v).trim()); };
  if (has('eventbriteToken')) { setOrClear('fund_eventbrite_token', body.eventbriteToken); setS('fund_eventbrite_event_id', ''); setS('fund_eventbrite_event_name', ''); if (!String(body.eventbriteToken || '').trim()) delete fundCache.eventbrite; }
  if (has('squareToken')) { setOrClear('fund_square_token', body.squareToken); if (!String(body.squareToken || '').trim()) delete fundCache.square; }
  if (has('squareSince')) { const d = new Date(String(body.squareSince || '')); setS('fund_square_since', isNaN(d) ? '' : d.toISOString()); }
  if (has('squareLocation')) setOrClear('fund_square_location', body.squareLocation);
  if (has('eventbriteMeasure')) { const mv = body.eventbriteMeasure === 'gross' ? 'gross' : 'base'; setS('fund_eventbrite_measure', mv); if (fundCache.eventbrite && typeof fundCache.eventbrite[mv] === 'number') fundCache.eventbrite.amount = fundCache.eventbrite[mv]; }
  if (has('expenses')) setS('fund_expenses', String(numOr(body.expenses, 0)));
  if (has('raffleInSquare')) setS('fund_raffle_in_square', body.raffleInSquare ? '1' : '0');
  for (const k of ['eventbrite', 'square', 'mcgill']) {
    const f = 'override' + k[0].toUpperCase() + k.slice(1);
    if (has(f)) { const v = String(body[f] == null ? '' : body[f]).trim(); if (v === '') setS('fund_override_' + k, ''); else { const n = numOr(v, null); if (n === null || n < 0) throw new HttpError(400, 'badamount', 'Amounts must be numbers.'); setS('fund_override_' + k, String(n)); } }
  }
  saveFundCache(); bump();
  log('fund settings saved', { ip, keys: Object.keys(body).filter(k => k !== 'pin') });
}
function fundSettingsView() {
  return { eventbriteConnected: !!getS('fund_eventbrite_token', ''), eventbriteMeasure: getS('fund_eventbrite_measure', 'base'), squareConnected: !!getS('fund_square_token', ''), squareSince: getS('fund_square_since', '') || FUND_DEFAULT_SINCE, squareLocation: getS('fund_square_location', ''), expenses: numOr(getS('fund_expenses', '4000'), 0), raffleInSquare: getS('fund_raffle_in_square', '1') === '1', overrides: { eventbrite: getS('fund_override_eventbrite', ''), square: getS('fund_override_square', ''), mcgill: getS('fund_override_mcgill', '') }, eventbriteEvent: getS('fund_eventbrite_event_name', '') };
}

/* ---------------- pages ---------------- */
const APP_HTML = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
function gatePage(error) {
  const parts = EVENT_NAME.split(/\s+for\s+/i);
  const title = parts.length === 2 ? esc(parts[0]) + '<br>For ' + esc(parts[1]) : esc(EVENT_NAME);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>' + esc(EVENT_NAME) + ' 50/50</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap">' +
    '<style>:root{color-scheme:dark}html{background:#071d16}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c2d23 radial-gradient(120% 70% at 50% 0%,#134634 0%,#0c2d23 55%,#071d16 100%) no-repeat;color:#f3ecd8;font:16px/1.45 "IBM Plex Sans","Helvetica Neue",Arial,sans-serif;padding:24px 16px;box-sizing:border-box}' +
    '.box{width:100%;max-width:400px;background:#11382b;border:1px solid rgba(243,236,216,.12);border-radius:14px;padding:26px 20px;box-shadow:0 10px 30px rgba(0,0,0,.32)}' +
    '.eyebrow{font:600 12px/1 inherit;letter-spacing:.18em;text-transform:uppercase;color:#d8b35a}h1{font:800 clamp(32px,9vw,46px)/.95 "Big Shoulders Display","Oswald","Arial Narrow",Impact,sans-serif;text-transform:uppercase;margin:6px 0 18px;letter-spacing:.01em}' +
    'label{display:block;font-size:13px;color:#a9bbae;margin-bottom:6px;font-weight:500}input{width:100%;box-sizing:border-box;min-height:56px;background:#17462f;color:#f3ecd8;border:1px solid rgba(243,236,216,.26);border-radius:10px;padding:10px 14px;font:600 26px/1 "IBM Plex Sans",Arial,sans-serif;letter-spacing:.35em;text-align:center}input:focus-visible{outline:2px solid #f1d27f;outline-offset:2px}' +
    'button{width:100%;min-height:50px;margin-top:14px;border:0;border-radius:10px;background:linear-gradient(180deg,#f1d27f,#d8b35a);color:#241a05;font:600 16px/1 "IBM Plex Sans",Arial,sans-serif;cursor:pointer}' +
    '.err{color:#e8705c;font-size:14px;margin:10px 0 0}.fine{color:#a9bbae;font-size:12px;margin:16px 0 0;text-align:center}</style></head><body>' +
    '<form class="box" method="post" action="/login" autocomplete="off"><div class="eyebrow">50/50 Raffle</div><h1>' + title + '</h1>' +
    '<label for="pin">Seller PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autofocus required>' +
    '<button type="submit">Open the raffle</button>' + (error ? '<p class="err">' + esc(error) + '</p>' : '') +
    '<p class="fine">Sellers only. ' + esc(EVENT_DATE) + (LICENCE_TEXT ? ' &middot; ' + esc(LICENCE_TEXT) : '') + '</p></form></body></html>';
}

/* ---------------- http ---------------- */
const json = (res, status, body, extra) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {})); res.end(JSON.stringify(body)); };
const html = (res, status, body, extra) => { res.writeHead(status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' }, extra || {})); res.end(body); };
const redirect = (res, to, extra) => { res.writeHead(303, Object.assign({ Location: to, 'Cache-Control': 'no-store' }, extra || {})); res.end(); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > 16384) { reject(new HttpError(413, 'big', 'Request too large.')); req.destroy(); } else data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(data)));
      try { resolve(JSON.parse(data)); } catch (e) { reject(new HttpError(400, 'badjson', 'Bad JSON.')); }
    });
    req.on('error', reject);
  });
}
const ipOf = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

const server = http.createServer(async (req, res) => {
  const ip = ipOf(req);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, version: Number(getS('version', '1')), provider: EMAIL_PROVIDER });
    const signedIn = validSession(req.headers.cookie);
    if (p === '/' || p === '') { if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed.'); return signedIn ? redirect(res, '/app') : html(res, 200, gatePage('')); }
    if (p === '/login') {
      if (req.method !== 'POST') return redirect(res, '/');
      if (limited('gate:' + ip, 30, 60000)) return html(res, 429, gatePage('Too many attempts. Wait a minute.'));
      const body = await readBody(req);
      try { gateCheck(ip, body.pin); } catch (e) { if (e instanceof HttpError) return html(res, e.status, gatePage(e.message)); throw e; }
      return redirect(res, '/app', { 'Set-Cookie': cookieFor(req, issueSession(), SESSION_DAYS * 86400) });
    }
    if (p === '/logout') return redirect(res, '/', { 'Set-Cookie': cookieFor(req, '', 0) });
    if (p === '/app' || p === '/app/') return signedIn ? html(res, 200, APP_HTML) : redirect(res, '/');
    if (p === '/app/export.csv') {
      if (!signedIn) return redirect(res, '/');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="casino-night-5050-sales-' + nowIso().slice(0, 10) + '.csv"', 'Cache-Control': 'no-store' });
      return res.end('﻿' + csv());
    }
    let m;
    if ((m = p.match(/^\/s\/([A-Za-z0-9_-]+)(\/export\.csv)?\/?$/))) {
      if (!safeEq(m[1], SELLER_TOKEN)) { if (limited('nf:' + ip, 30, 60000)) return html(res, 429, 'Slow down.'); return html(res, 404, gatePage('')); }
      if (m[2]) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="casino-night-5050-sales-' + nowIso().slice(0, 10) + '.csv"', 'Cache-Control': 'no-store' }); return res.end('﻿' + csv()); }
      return redirect(res, '/app', { 'Set-Cookie': cookieFor(req, issueSession(), SESSION_DAYS * 86400) });
    }
    if (p.startsWith('/api/')) {
      const token = req.headers['x-raffle-token'] || url.searchParams.get('token');
      if (!signedIn && !safeEq(token, SELLER_TOKEN)) { if (limited('auth:' + ip, 30, 60000)) throw new HttpError(429, 'slow', 'Slow down.'); throw new HttpError(401, 'unauthorized', 'Your sign-in has expired. Enter the PIN again.'); }
      if (limited('api:' + ip, 240, 60000)) throw new HttpError(429, 'slow', 'Too many requests. Wait a moment.');
      if (req.method === 'GET' && p === '/api/state') {
        const since = Number(url.searchParams.get('since') || 0);
        const v = Number(getS('version', '1'));
        if (since && since === v) return json(res, 200, { version: v, unchanged: true });
        return json(res, 200, snapshot());
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'Method not allowed.');
      const body = await readBody(req);
      if (p === '/api/sales') { const sale = logSale(body, ip); return json(res, 201, { sale, snapshot: snapshot() }); }
      if (p === '/api/cash') { const entry = addCash(body, ip); return json(res, 201, { entry, snapshot: snapshot() }); }
      if ((m = p.match(/^\/api\/cash\/([A-Za-z0-9_-]+)\/delete$/))) { removeCash(m[1]); return json(res, 200, { ok: true, snapshot: snapshot() }); }
      if ((m = p.match(/^\/api\/sales\/([A-Za-z0-9_-]+)\/(void|email|resend)$/))) {
        if (m[2] === 'void') return json(res, 200, { sale: setVoid(m[1], !!body.voided), snapshot: snapshot() });
        if (m[2] === 'email') return json(res, 200, { sale: changeEmail(m[1], body.email), snapshot: snapshot() });
        resend(m[1]); return json(res, 200, { ok: true, snapshot: snapshot() });
      }
      const pinGuard = () => { if (limited('pin:' + ip, 20, 60000)) throw new HttpError(429, 'slow', 'Too many attempts.'); };
      if (p === '/api/draw') { pinGuard(); const draw = drawWinner(ip, body.pin); return json(res, 200, { draw, snapshot: snapshot() }); }
      if (p === '/api/winner-email') { pinGuard(); emailWinner(ip, body.pin); return json(res, 200, { ok: true, snapshot: snapshot() }); }
      if (p === '/api/reset') { pinGuard(); resetRaffle(ip, body.pin, body.word); return json(res, 200, { ok: true, snapshot: snapshot() }); }
      if (p === '/api/seller-pin') { pinGuard(); changeSellerPin(ip, body.pin, body.newPin); return json(res, 200, { ok: true, snapshot: snapshot() }, { 'Set-Cookie': cookieFor(req, issueSession(), SESSION_DAYS * 86400) }); }
      if (p === '/api/fund-settings') { pinGuard(); saveFundSettings(ip, body); await Promise.race([refreshFund(true), new Promise(r => setTimeout(r, 25000))]); return json(res, 200, { ok: true, snapshot: snapshot() }); }
      if (p === '/api/fund-refresh') { await Promise.race([refreshFund(!!body.force), new Promise(r => setTimeout(r, 25000))]); return json(res, 200, { ok: true, snapshot: snapshot() }); }
      throw new HttpError(404, 'notfound', 'Not found.');
    }
    return html(res, 404, gatePage(''));
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, message: e.message } });
    log('server error', { error: e.message, stack: String(e.stack).split('\n').slice(0, 3).join(' | '), path: p });
    return json(res, 500, { error: { code: 'server', message: 'Something went wrong on the server.' } });
  }
});
server.listen(PORT, HOST, () => {
  const base = PUBLIC_URL || ('http://localhost:' + PORT);
  log('raffle server up', { port: PORT, db: DB_PATH, emailProvider: EMAIL_PROVIDER, entry: base + '/', legacyLink: base + '/s/' + SELLER_TOKEN, adminPin: process.env.ADMIN_PIN ? '(from env)' : ('generated: ' + ADMIN_PIN + ' (set ADMIN_PIN to choose your own)') });
  setTimeout(processMails, 2000);
  setTimeout(() => refreshFund(true), 3000);
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
