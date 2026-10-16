'use strict';
/* End-to-end flow test: spawns the real server (dry-run email), drives two seller pages under jsdom,
   and checks the API directly. Run: node --no-warnings=ExperimentalWarning test/flow.test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.error('jsdom missing: run  npm install --no-save jsdom@25.0.1  in the server folder first'); process.exit(2); }
const { webcrypto } = require('node:crypto');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'testtoken';
const PIN = '2468';          // admin
const SELLER_PIN = '1016';   // gate
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffle-test-'));
const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'raffle.db'), MAIL_DRY_RUN: '1', ADMIN_PIN: PIN, SELLER_PIN, SELLER_TOKEN: TOKEN, PUBLIC_URL: BASE, LICENCE_TEXT: 'Licence RACJ test' });
const serverArgs = ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'server.js')];
const proc = spawn(process.execPath, serverArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
proc.stdout.on('data', d => { serverLog += d; });
proc.stderr.on('data', d => { serverLog += d; process.stderr.write(d); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) { if (cond) console.log('  ok  ' + msg); else { failures++; console.log('  FAIL ' + msg); } }
let COOKIE = '';
async function api(p, body, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.token !== undefined) { if (opts.token) headers['x-raffle-token'] = opts.token; }
  else if (opts.cookie !== undefined) { if (opts.cookie) headers.cookie = opts.cookie; }
  else headers.cookie = COOKIE;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') || '' };
}
async function login(pin) {
  const r = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'pin=' + encodeURIComponent(pin), redirect: 'manual' });
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, location: r.headers.get('location'), cookie: sc.split(';')[0], text: r.status === 303 ? '' : await r.text() };
}
async function boot(cookie) {
  cookie = cookie || COOKIE;
  const html = await (await fetch(BASE + '/app', { headers: { cookie } })).text();
  const dom = new JSDOM(html, {
    url: BASE + '/app', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', { value: webcrypto });
      window.fetch = (u, o) => fetch(new URL(u, BASE), Object.assign({}, o, { headers: Object.assign({}, (o && o.headers) || {}, { cookie }) }));
      window.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  dom.window.addEventListener('error', e => { console.error('PAGE ERROR:', e.message); failures++; });
  const $ = id => dom.window.document.getElementById(id);
  return { dom, $, txt: id => $(id).textContent.trim(), hidden: id => $(id).hidden, win: dom.window };
}
function setVal(page, id, v) { const el = page.$(id); el.value = v; el.dispatchEvent(new page.win.Event('input', { bubbles: true })); el.dispatchEvent(new page.win.Event('change', { bubbles: true })); }
function submitSale(page, pkg, qty, email) { page.$('pkg').value = String(pkg); page.$('qty').value = String(qty); page.$('email').value = email; page.$('sale-form').dispatchEvent(new page.win.Event('submit', { cancelable: true, bubbles: true })); }
const salesOf = async () => (await api('/api/state')).body.sales;

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {} await sleep(100); }
  console.log('server up on ' + BASE);

  console.log('\n1. PIN gate and sessions');
  const gate = await fetch(BASE + '/'); const gateText = await gate.text();
  check(gate.status === 200 && gateText.includes('Seller PIN') && gateText.includes('action="/login"'), 'bare domain shows the PIN screen');
  const appNoCookie = await fetch(BASE + '/app', { redirect: 'manual' });
  check(appNoCookie.status === 303 && appNoCookie.headers.get('location') === '/', '/app without a session redirects to the PIN screen');
  const bad = await login('0000'); check(bad.status === 401 && bad.text.includes('isn’t right') && !bad.cookie, 'wrong PIN: error on the PIN screen, no cookie');
  const asAdmin = await login(PIN); check(asAdmin.status === 303 && asAdmin.location === '/app' && asAdmin.cookie.startsWith('raffle_s='), 'admin PIN also opens the gate');
  const asSeller = await login(SELLER_PIN); check(asSeller.status === 303 && asSeller.cookie.startsWith('raffle_s='), 'seller PIN opens the gate and sets a cookie');
  COOKIE = asSeller.cookie;
  const appOk = await fetch(BASE + '/app', { headers: { cookie: COOKIE } });
  check(appOk.status === 200 && (await appOk.text()).includes('id="sale-form"'), '/app with the cookie serves the seller page');
  check((await api('/api/state', null, { cookie: '' })).status === 401, 'API without session -> 401');
  check((await api('/api/state', null, { cookie: 'raffle_s=1.1.forged' })).status === 401, 'API with forged cookie -> 401');
  check((await api('/api/state', null, { token: TOKEN })).status === 200, 'API with the legacy token header still works');
  const legacy = await fetch(BASE + '/s/' + TOKEN, { redirect: 'manual' });
  check(legacy.status === 303 && legacy.headers.get('location') === '/app' && (legacy.headers.get('set-cookie') || '').startsWith('raffle_s='), 'legacy /s/<token> link signs in and redirects to /app');
  const legacyBad = await fetch(BASE + '/s/wrongtoken'); check(legacyBad.status === 404 && (await legacyBad.text()).includes('Seller PIN'), 'wrong legacy link -> 404 PIN screen');
  const st0 = await api('/api/state'); check(st0.status === 200 && st0.body.state.status === 'open' && st0.body.state.next === 1 && st0.body.config.emailProvider === 'dry', 'state: open, next #1, dry-run mail');

  console.log('\n2. two seller pages boot');
  const A = await boot(); const B = await boot(asAdmin.cookie); await sleep(700);
  check(A.txt('status-pill') === 'Sales open' && B.txt('status-pill') === 'Sales open', 'pills read Sales open');
  check(A.txt('sale-btn') === 'Log sale' && !A.$('sale-btn').disabled, 'Log sale enabled');
  check(A.txt('t-tickets') === '0' && A.txt('t-raised') === '$0', 'tally zero');
  check(A.$('draw-btn').disabled, 'draw disabled with no tickets');
  check(A.txt('live-text') === 'Live', 'live indicator: ' + A.txt('live-text'));
  check(A.txt('footer').includes('Licence RACJ test'), 'licence text in footer');
  check(A.$('pkg').options.length === 5 && A.$('pkg').options[1].textContent === '3 tickets for $10', 'packages rendered from server config');
  check(A.$('export-btn').getAttribute('href') === '/app/export.csv' && A.txt('entry-url') === '127.0.0.1:' + PORT, 'export link + sign-in address use the session, not a token');

  console.log('\n3. one sale from A');
  submitSale(A, 1, 2, 'jane@example.com'); await sleep(400);
  let sales = await salesOf();
  check(sales.length === 1 && sales[0].from === 1 && sales[0].to === 6 && sales[0].amount === 20, 'sale #1–#6 $20 stored');
  check(!A.hidden('receipt') && A.txt('r-range') === '#1–#6' && A.txt('r-say').includes('1 to 6') && A.txt('r-say').includes('confirmation email'), 'receipt: ' + A.txt('r-range'));
  check(A.txt('t-tickets') === '6' && A.txt('t-raised') === '$20' && A.txt('t-half') === '$10', 'A tally 6 / $20 / $10');
  check(A.txt('next-ticket') === 'Next ticket #7', 'next ticket label');
  check(A.$('email').value === '' && A.$('qty').value === '1', 'form reset');
  await sleep(3000);
  check(B.txt('t-tickets') === '6', 'B sees the sale after polling');
  sales = await salesOf();
  check(sales[0].mail && sales[0].mail.status === 'sent', 'confirmation mail recorded as sent (dry run)');
  check(A.$('ledger-list').textContent.includes('Emailed'), 'ledger shows Emailed chip');

  console.log('\n4. simultaneous sales from A and B, then one more');
  submitSale(A, 0, 1, 'a@example.com'); submitSale(B, 2, 1, 'b@example.com'); await sleep(600);
  submitSale(B, 3, 1, 'c@example.com'); await sleep(600);
  sales = (await salesOf()).sort((x, y) => x.from - y.from);
  let disjoint = true; for (let i = 1; i < sales.length; i++) if (sales[i].from !== sales[i - 1].to + 1) disjoint = false;
  check(sales.length === 4 && disjoint, 'four sales, contiguous ranges: ' + sales.map(s => s.from + '-' + s.to).join(', '));
  const total = sales.reduce((n, s) => n + s.to - s.from + 1, 0);
  check((await api('/api/state')).body.state.next === total + 1, 'next = total + 1');
  await sleep(3000);
  check(A.txt('t-tickets') === String(total) && B.txt('t-tickets') === String(total) && A.txt('t-raised') === '$95', 'both pages show ' + total + ' tickets, $95');

  console.log('\n5. validation + filter');
  submitSale(A, 0, 1, 'nope'); await sleep(50);
  check(!A.hidden('sale-error') && A.txt('sale-error').includes('valid email'), 'client rejects bad email');
  const badPkg = await api('/api/sales', { email: 'x@y.z', pkg: 9, qty: 1 }); check(badPkg.status === 400 && badPkg.body.error.code === 'badpkg', 'server rejects bad package');
  const badQty = await api('/api/sales', { email: 'x@y.z', pkg: 0, qty: 11 }); check(badQty.status === 400 && badQty.body.error.code === 'badqty', 'server rejects qty 11');
  setVal(A, 'ledger-filter', 'jane'); check(A.$('ledger-list').children.length === 1, 'filter by email');
  setVal(A, 'ledger-filter', '#3'); check(A.$('ledger-list').children.length === 1 && A.$('ledger-list').textContent.includes('jane'), 'filter by ticket #');
  setVal(A, 'ledger-filter', '');

  console.log('\n6. void c@ from B, fix jane’s email from A');
  let rowC = [...B.$('ledger-list').children].find(li => li.textContent.includes('c@example.com'));
  [...rowC.querySelectorAll('.xbtn')].find(b => b.textContent === 'Void').click(); await sleep(30);
  rowC = [...B.$('ledger-list').children].find(li => li.textContent.includes('c@example.com'));
  rowC.querySelector('.xbtn.yes').click(); await sleep(400);
  sales = await salesOf();
  check(sales.find(s => s.email === 'c@example.com').voided === true, 'c@ voided');
  check(B.txt('t-raised') === '$45' && B.txt('ledger-count').includes('1 voided'), 'B tally excludes voided: ' + B.txt('t-raised'));
  let rowJ = [...A.$('ledger-list').children].find(li => li.textContent.includes('jane@example.com'));
  [...rowJ.querySelectorAll('.xbtn')].find(b => b.textContent === 'Fix email').click(); await sleep(30);
  rowJ = [...A.$('ledger-list').children].find(li => li.querySelector('input[type=email]'));
  rowJ.querySelector('input[type=email]').value = 'jane.doe@example.com';
  rowJ.querySelector('.xbtn.gold').click(); await sleep(500);
  sales = await salesOf();
  const jane = sales.find(s => s.from === 1);
  check(jane.email === 'jane.doe@example.com' && jane.mail && jane.mail.to === 'jane.doe@example.com' && jane.mail.status === 'sent', 'email fixed and confirmation resent');

  console.log('\n6b. fundraising total (manual sources, no tokens)');
  const f0 = (await api('/api/state')).body.fund;
  check(f0 && f0.expenses === 4000 && f0.raffle.half === 22.5 && f0.total === 22.5 - 4000, 'defaults: expenses 4000, only the 50/50 share counted: ' + (f0 && f0.total));
  const badF = await api('/api/fund-settings', { pin: '0000', expenses: 1 }); check(badF.status === 403, 'fund settings need the admin PIN');
  const fset = await api('/api/fund-settings', { pin: PIN, overrideEventbrite: '10000', overrideSquare: '2500', overrideMcgill: '6050', expenses: '4000', raffleInSquare: true });
  const f1 = fset.body.snapshot.fund;
  check(fset.status === 200 && f1.square.onsite === 2455 && f1.total === 10000 + 2455 + 6050 + 22.5 - 4000, 'total with Square minus the 50/50: ' + f1.total);
  const fset2 = await api('/api/fund-settings', { pin: PIN, raffleInSquare: false });
  check(fset2.body.snapshot.fund.total === 10000 + 2500 + 6050 + 22.5 - 4000, 'total when Square excludes the 50/50: ' + fset2.body.snapshot.fund.total);
  await api('/api/fund-settings', { pin: PIN, raffleInSquare: true });
  await sleep(3000);
  check(A.txt('np-total') === '$14,527.50' && A.txt('sp-total') === '$14,527.50', 'page shows the Neuro total: ' + A.txt('np-total'));
  check(A.$('np-bd').children.length === 7 && A.$('np-bd').textContent.includes('Online donations') && A.$('np-bd').textContent.includes('Expenses'), 'breakdown rows rendered');
  check(A.txt('np-fresh').includes('Eventbrite: entered manually') && A.txt('np-fresh').includes('Square: entered manually'), 'source lines: ' + A.txt('np-fresh'));
  A.$('stage-btn').click(); await sleep(20);
  check(A.win.document.body.classList.contains('stage') && A.txt('sp-tickets') === '17' && A.txt('sp-raised') === '$45', 'stage panels: 17 tickets, $45 pot');
  A.$('stage-btn').click();
  A.$('settings-btn').click(); await sleep(50);
  check(A.$('f-mc').value === '6050' && A.$('f-exp').value === '4000' && A.$('f-ris').checked === true && A.$('f-ov-eb').value === '10000', 'settings form prefilled from the server');
  A.$('settings-btn').click();
  const fref = await api('/api/fund-refresh', { force: true }); check(fref.status === 200 && fref.body.snapshot.fund.total === 14527.5, 'refresh endpoint answers with the snapshot');
  // cash: a 50/50 sale paid in cash is not subtracted from Square; a cash entry adds in full
  const cashSale = await api('/api/sales', { email: 'cashbuyer@example.com', pkg: 0, qty: 1, paid: 'cash' });
  check(cashSale.status === 201 && cashSale.body.sale.paid === 'cash' && cashSale.body.snapshot.totals.grossCash === 5 && cashSale.body.snapshot.totals.grossSquare === 45, 'cash 50/50 sale recorded: grossCash 5, grossSquare 45');
  let fc = cashSale.body.snapshot.fund;
  check(fc.square.onsite === 2455 && fc.raffle.half === 25 && fc.total === 10000 + 2455 + 6050 + 25 - 4000, 'Square still minus only card 50/50 sales; half pot now $25: ' + fc.total);
  const badCash = await api('/api/cash', { amount: 0, note: 'x' }); check(badCash.status === 400, 'cash entry must be above zero');
  const cashEntry = await api('/api/cash', { amount: '120.50', note: 'drinks', seller: 'Marie' });
  fc = cashEntry.body.snapshot.fund;
  check(cashEntry.status === 201 && cashEntry.body.snapshot.cash.total === 120.5 && fc.cash === 120.5 && fc.total === 10000 + 2455 + 120.5 + 6050 + 25 - 4000, 'cash entry adds in full: ' + fc.total);
  await sleep(3000);
  check(A.$('cash-list').children.length === 1 && A.$('cash-list').textContent.includes('drinks') && A.txt('cash-total').includes('$120.50'), 'cash card lists the entry');
  check(A.$('np-bd').textContent.includes('Cash received on site') && A.$('np-bd').children.length === 7, 'breakdown has the cash row');
  check([...A.$('ledger-list').children].some(li => li.textContent.includes('cashbuyer@example.com') && li.textContent.includes('cash')), 'ledger marks the cash sale');
  const csvC = await (await fetch(BASE + '/app/export.csv', { headers: { cookie: COOKIE } })).text();
  check(csvC.includes('paid_by') && csvC.includes(',cash,cashbuyer@example.com') && csvC.includes('cash_total,120.5'), 'CSV carries paid_by and the cash block');
  await api('/api/cash/' + cashEntry.body.entry.id + '/delete', {});
  await api('/api/sales/' + cashSale.body.sale.id + '/void', { voided: true });
  const afterClean = (await api('/api/state')).body;
  check(afterClean.cash.total === 0 && afterClean.totals.gross === 45 && afterClean.fund.total === 14527.5, 'cash entry removed and cash sale voided: back to $14,527.50');
  await sleep(3000);

  console.log('\n7. draw');
  A.$('draw-btn').click(); await sleep(30);
  check(!A.hidden('modal') && A.txt('m-body').includes('$45') && A.txt('m-body').includes('17 tickets'), 'confirm modal: ' + A.txt('m-body'));
  A.$('m-pin').value = '0000'; A.$('m-confirm').click(); await sleep(300);
  check(!A.hidden('m-error') && A.txt('m-error').includes('PIN'), 'wrong PIN rejected: ' + A.txt('m-error'));
  A.$('m-pin').value = PIN; A.$('m-confirm').click(); await sleep(400);
  const st = (await api('/api/state')).body.state;
  check(st.status === 'drawn' && st.draw && typeof st.draw.ticket === 'number', 'drawn: ticket #' + (st.draw && st.draw.ticket));
  const liveSales = sales.filter(s => !s.voided);
  const winSale = liveSales.find(s => st.draw.ticket >= s.from && st.draw.ticket <= s.to);
  check(!!winSale && winSale.email === st.draw.email && st.draw.pool === 17 && st.draw.gross === 45, 'winning ticket maps to a live sale, pool 17, gross $45');
  await sleep(6500);
  check(!A.hidden('winner') && A.txt('w-ticket') === '#' + st.draw.ticket && A.txt('w-email') === st.draw.email, 'A winner panel: ' + A.txt('w-ticket'));
  check(!B.hidden('winner') && B.txt('w-ticket') === '#' + st.draw.ticket && B.txt('status-pill') === 'Drawn', 'B winner panel via polling');
  check(A.hidden('sale-form') && !A.hidden('closed-note') && A.$('draw-btn').hidden, 'sales closed in UI');
  const late = await api('/api/sales', { email: 'late@example.com', pkg: 0, qty: 1 }); check(late.status === 409 && late.body.error.code === 'closed', 'late sale -> 409 closed');
  const voidLate = await api('/api/sales/' + sales[0].id + '/void', { voided: true }); check(voidLate.status === 409, 'void after draw -> 409');

  console.log('\n8. winner email + export + stage');
  A.$('w-email-btn').click(); await sleep(30); A.$('m-pin').value = PIN; A.$('m-confirm').click(); await sleep(2000);
  const st2 = (await api('/api/state')).body.state;
  check(st2.winnerMail && st2.winnerMail.status === 'sent' && st2.winnerMail.to === st.draw.email, 'winner email sent (dry)');
  check(A.txt('w-mail').startsWith('Winner emailed'), 'winner panel shows emailed: ' + A.txt('w-mail'));
  const csvRes = await fetch(BASE + '/app/export.csv', { headers: { cookie: COOKIE } }); const csv = await csvRes.text();
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  check(csvRes.headers.get('content-disposition').includes('attachment') && lines[0].startsWith('ticket_from,ticket_to') && lines.length >= 7 && lines.some(l => l.includes(',voided,')) && lines.some(l => l.startsWith('winning_ticket,' + st.draw.ticket)), 'CSV export: header, voided row, winner line');
  check((await fetch(BASE + '/app/export.csv', { redirect: 'manual' })).status === 303, 'CSV needs a session');
  A.$('stage-btn').click(); await sleep(20);
  check(A.win.document.body.classList.contains('stage') && A.txt('w-email').includes('•••@'), 'stage view masks email: ' + A.txt('w-email'));
  A.$('stage-btn').click();

  console.log('\n9. reset');
  A.$('settings-btn').click(); A.$('reset-pin').value = PIN; A.$('reset-word').value = 'RESET'; A.$('reset-btn').click(); await sleep(500);
  const st3 = (await api('/api/state')).body;
  check(st3.sales.length === 0 && st3.state.status === 'open' && st3.state.next === 1 && !st3.state.draw, 'reset: no sales, open, next #1');
  check(A.hidden('winner') && A.txt('status-pill') === 'Sales open' && A.txt('reset-msg').includes('reset'), 'UI back to open: ' + A.txt('reset-msg'));
  const badReset = await api('/api/reset', { pin: PIN, word: 'nope' }); check(badReset.status === 400, 'reset without RESET word refused');

  console.log('\n10. change the seller PIN from Settings (signs other phones out)');
  A.$('sp-new').value = '7777'; A.$('sp-admin').value = PIN; A.$('sp-save').click(); await sleep(500);
  check(A.txt('sp-msg').includes('changed'), 'settings confirms: ' + A.txt('sp-msg'));
  const badChange = await api('/api/seller-pin', { pin: '0000', newPin: '8888' }, { token: TOKEN }); check(badChange.status === 403, 'seller PIN change needs the admin PIN');
  check((await login(SELLER_PIN)).status === 401, 'old seller PIN no longer opens the gate');
  const newLogin = await login('7777'); check(newLogin.status === 303 && newLogin.cookie, 'new seller PIN opens the gate');
  check((await fetch(BASE + '/app', { headers: { cookie: asAdmin.cookie }, redirect: 'manual' })).status === 303, 'B’s old session is signed out');
  A.win.close(); B.win.close();
  COOKIE = newLogin.cookie;

  console.log('\n11. persistence across restart');
  await api('/api/sales', { email: 'persist@example.com', pkg: 2, qty: 1 });
  proc.kill('SIGTERM'); await sleep(500);
  const proc2 = spawn(process.execPath, serverArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc2.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {} await sleep(100); }
  const st4 = await api('/api/state');
  check(st4.status === 200 && st4.body.sales.length === 1 && st4.body.sales[0].email === 'persist@example.com' && st4.body.state.next === 11, 'sale and session survive a restart, next #11');
  check((await login('7777')).status === 303 && (await login(SELLER_PIN)).status === 401, 'changed seller PIN survives a restart (SELLER_PIN env only seeds the first boot)');

  console.log('\n12. PIN lockouts');
  let last;
  for (let i = 0; i < 9; i++) last = await api('/api/draw', { pin: '1111' });
  check(last.status === 429 && last.body.error.code === 'locked', 'admin lockout after repeated wrong PINs');
  let g; for (let i = 0; i < 9; i++) g = await login('0000');
  check(g.status === 429 && g.text.includes('10 minutes'), 'gate lockout after repeated wrong PINs');

  proc2.kill('SIGTERM');
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
  if (failures) console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-12).join('\n'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); proc.kill('SIGTERM'); process.exit(1); });
