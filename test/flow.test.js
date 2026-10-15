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
const PIN = '2468';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raffle-test-'));
const env = Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'raffle.db'), MAIL_DRY_RUN: '1', ADMIN_PIN: PIN, SELLER_TOKEN: TOKEN, PUBLIC_URL: BASE, LICENCE_TEXT: 'Licence RACJ test' });
const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
proc.stdout.on('data', d => { serverLog += d; });
proc.stderr.on('data', d => { serverLog += d; process.stderr.write(d); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) { if (cond) console.log('  ok  ' + msg); else { failures++; console.log('  FAIL ' + msg); } }
async function api(p, body, token) {
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'x-raffle-token': token === undefined ? TOKEN : token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function boot() {
  const html = await (await fetch(BASE + '/s/' + TOKEN)).text();
  const dom = new JSDOM(html, {
    url: BASE + '/s/' + TOKEN, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', { value: webcrypto });
      window.fetch = (u, o) => fetch(new URL(u, BASE), o);
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

  console.log('\n1. access control');
  check((await api('/api/state', null, 'wrong')).status === 401, 'wrong token -> 401');
  check((await api('/api/state', null, '')).status === 401, 'missing token -> 401');
  const landing = await fetch(BASE + '/s/wrongtoken'); check(landing.status === 404 && (await landing.text()).includes('Sellers: open the link'), 'wrong seller link -> 404 landing page, app not served');
  const okPage = await fetch(BASE + '/s/' + TOKEN); check(okPage.status === 200 && (await okPage.text()).includes('id="sale-form"'), 'right seller link serves the app');
  const st0 = await api('/api/state'); check(st0.status === 200 && st0.body.state.status === 'open' && st0.body.state.next === 1 && st0.body.config.emailProvider === 'dry', 'state: open, next #1, dry-run mail');

  console.log('\n2. two seller pages boot');
  const A = await boot(); const B = await boot(); await sleep(700);
  check(A.txt('status-pill') === 'Sales open' && B.txt('status-pill') === 'Sales open', 'pills read Sales open');
  check(A.txt('sale-btn') === 'Log sale' && !A.$('sale-btn').disabled, 'Log sale enabled');
  check(A.txt('t-tickets') === '0' && A.txt('t-raised') === '$0', 'tally zero');
  check(A.$('draw-btn').disabled, 'draw disabled with no tickets');
  check(A.txt('live-text') === 'Live', 'live indicator: ' + A.txt('live-text'));
  check(A.txt('footer').includes('Licence RACJ test'), 'licence text in footer');
  check(A.$('pkg').options.length === 5 && A.$('pkg').options[1].textContent === '3 tickets for $10', 'packages rendered from server config');

  console.log('\n3. one sale from A');
  submitSale(A, 1, 2, 'jane@example.com'); await sleep(400);
  let sales = await salesOf();
  check(sales.length === 1 && sales[0].from === 1 && sales[0].to === 6 && sales[0].amount === 20, 'sale #1–#6 $20 stored: ' + JSON.stringify(sales[0] && { from: sales[0].from, to: sales[0].to, amount: sales[0].amount }));
  check(!A.hidden('receipt') && A.txt('r-range') === '#1–#6' && A.txt('r-say').includes('1 to 6') && A.txt('r-say').includes('confirmation email'), 'receipt: ' + A.txt('r-range'));
  check(A.txt('t-tickets') === '6' && A.txt('t-raised') === '$20' && A.txt('t-half') === '$10', 'A tally 6 / $20 / $10');
  check(A.txt('next-ticket') === 'Next ticket #7', 'next ticket label');
  check(A.$('email').value === '' && A.$('qty').value === '1', 'form reset');
  await sleep(3000);
  check(B.txt('t-tickets') === '6', 'B sees the sale after polling');
  sales = await salesOf();
  check(sales[0].mail && sales[0].mail.status === 'sent', 'confirmation mail recorded as sent (dry run): ' + JSON.stringify(sales[0].mail));
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
  const bad = await api('/api/sales', { email: 'x@y.z', pkg: 9, qty: 1 }); check(bad.status === 400 && bad.body.error.code === 'badpkg', 'server rejects bad package');
  const bad2 = await api('/api/sales', { email: 'x@y.z', pkg: 0, qty: 11 }); check(bad2.status === 400 && bad2.body.error.code === 'badqty', 'server rejects qty 11');
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
  check(jane.email === 'jane.doe@example.com' && jane.mail && jane.mail.to === 'jane.doe@example.com' && jane.mail.status === 'sent', 'email fixed and confirmation resent: ' + JSON.stringify(jane.mail));

  console.log('\n7. draw');
  A.$('draw-btn').click(); await sleep(30);
  check(!A.hidden('modal') && A.txt('m-body').includes('$45') && A.txt('m-body').includes('17 tickets'), 'confirm modal: ' + A.txt('m-body'));
  A.$('m-pin').value = '0000'; A.$('m-confirm').click(); await sleep(300);
  check(!A.hidden('m-error') && A.txt('m-error').includes('PIN'), 'wrong PIN rejected: ' + A.txt('m-error'));
  A.$('m-pin').value = PIN; A.$('m-confirm').click(); await sleep(400);
  const st = (await api('/api/state')).body.state;
  check(st.status === 'drawn' && st.draw && typeof st.draw.ticket === 'number', 'drawn: ' + JSON.stringify(st.draw));
  const liveSales = sales.filter(s => !s.voided);
  const winSale = liveSales.find(s => st.draw.ticket >= s.from && st.draw.ticket <= s.to);
  check(!!winSale && winSale.email === st.draw.email && st.draw.pool === 17 && st.draw.gross === 45, 'winning ticket maps to a live sale, pool 17, gross $45');
  await sleep(3400);
  check(!A.hidden('winner') && A.txt('w-ticket') === '#' + st.draw.ticket && A.txt('w-email') === st.draw.email, 'A winner panel: ' + A.txt('w-ticket'));
  check(!B.hidden('winner') && B.txt('w-ticket') === '#' + st.draw.ticket && B.txt('status-pill') === 'Drawn', 'B winner panel via polling');
  check(A.hidden('sale-form') && !A.hidden('closed-note') && A.$('draw-btn').hidden, 'sales closed in UI');
  const late = await api('/api/sales', { email: 'late@example.com', pkg: 0, qty: 1 }); check(late.status === 409 && late.body.error.code === 'closed', 'late sale -> 409 closed');
  const voidLate = await api('/api/sales/' + sales[0].id + '/void', { voided: true }); check(voidLate.status === 409, 'void after draw -> 409');

  console.log('\n8. winner email + export + stage');
  A.$('w-email-btn').click(); await sleep(30); A.$('m-pin').value = PIN; A.$('m-confirm').click(); await sleep(2000);
  const st2 = (await api('/api/state')).body.state;
  check(st2.winnerMail && st2.winnerMail.status === 'sent' && st2.winnerMail.to === st.draw.email, 'winner email sent (dry): ' + JSON.stringify(st2.winnerMail));
  check(A.txt('w-mail').startsWith('Winner emailed'), 'winner panel shows emailed: ' + A.txt('w-mail'));
  const csvRes = await fetch(BASE + '/s/' + TOKEN + '/export.csv'); const csv = await csvRes.text();
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  check(csvRes.headers.get('content-disposition').includes('attachment') && lines[0].startsWith('ticket_from,ticket_to') && lines.length >= 7 && lines.some(l => l.includes(',voided,')) && lines.some(l => l.startsWith('winning_ticket,' + st.draw.ticket)), 'CSV export: header, voided row, winner line');
  check((await fetch(BASE + '/s/nope/export.csv')).status === 404, 'CSV needs the right token');
  A.$('stage-btn').click(); await sleep(20);
  check(A.win.document.body.classList.contains('stage') && A.txt('w-email').includes('•••@'), 'stage view masks email: ' + A.txt('w-email'));
  A.$('stage-btn').click();

  console.log('\n9. reset');
  A.$('settings-btn').click(); A.$('reset-pin').value = PIN; A.$('reset-word').value = 'RESET'; A.$('reset-btn').click(); await sleep(500);
  const st3 = (await api('/api/state')).body;
  check(st3.sales.length === 0 && st3.state.status === 'open' && st3.state.next === 1 && !st3.state.draw, 'reset: no sales, open, next #1');
  check(A.hidden('winner') && A.txt('status-pill') === 'Sales open' && A.txt('reset-msg').includes('reset'), 'UI back to open: ' + A.txt('reset-msg'));
  const badReset = await api('/api/reset', { pin: PIN, word: 'nope' }); check(badReset.status === 400, 'reset without RESET word refused');

  console.log('\n10. persistence across restart');
  await api('/api/sales', { email: 'persist@example.com', pkg: 2, qty: 1 });
  proc.kill('SIGTERM'); await sleep(500);
  const proc2 = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc2.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {} await sleep(100); }
  const st4 = (await api('/api/state')).body;
  check(st4.sales.length === 1 && st4.sales[0].email === 'persist@example.com' && st4.state.next === 11, 'sale survives restart, next #11');

  console.log('\n11. PIN lockout');
  let last;
  for (let i = 0; i < 9; i++) last = await api('/api/draw', { pin: '1111' });
  check(last.status === 429 && last.body.error.code === 'locked', 'locked after repeated wrong PINs: ' + last.status + ' ' + (last.body.error && last.body.error.code));

  proc2.kill('SIGTERM');
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
  if (failures) console.log('--- server log tail ---\n' + serverLog.split('\n').slice(-12).join('\n'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); proc.kill('SIGTERM'); process.exit(1); });
