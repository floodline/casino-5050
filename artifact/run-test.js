'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'casino-night-5050.html'), 'utf8');
const ACQUIRE_CREATES_DOC = process.argv.includes('--acquire-creates');

/* ---------------- in-memory mock of the db capability ---------------- */
function makeStore() {
  const docs = new Map();      // path -> body
  const leases = new Map();    // path -> {holder, expires}
  const listeners = [];        // {kind:'doc'|'col', path, next, q}
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const meta = () => ({ fromCache: false, hasPendingWrites: false });
  const docSnap = p => { const b = docs.get(p); return { id: p.split('/').pop(), exists: b !== undefined, data: () => clone(b), metadata: meta() }; };
  function colDocs(col, q) {
    let out = [];
    for (const [p, b] of docs) { const segs = p.split('/'); if (p.startsWith(col + '/') && segs.length === col.split('/').length + 1) out.push({ p, b }); }
    for (const w of (q.where || [])) out = out.filter(({ b }) => { const v = b[w[0]]; switch (w[1]) { case '==': return v === w[2]; case '!=': return v !== w[2]; case '<': return v < w[2]; case '<=': return v <= w[2]; case '>': return v > w[2]; case '>=': return v >= w[2]; default: return true; } });
    if (q.orderBy) { const [f, d] = q.orderBy; out.sort((a, b) => { const x = a.b[f], y = b.b[f]; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : x > y ? 1 : 0) * (d === 'desc' ? -1 : 1); }); }
    else out.sort((a, b) => a.p < b.p ? -1 : 1);
    if (q.limit) out = out.slice(0, q.limit);
    const ds = out.map(({ p }) => docSnap(p));
    return { docs: ds, size: ds.length, empty: !ds.length, docChanges: () => ds.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })), metadata: meta() };
  }
  function notify(p) {
    const col = p.split('/').slice(0, -1).join('/');
    for (const l of listeners) {
      if (l.kind === 'doc' && l.path === p) setTimeout(() => l.next(docSnap(p)), 0);
      if (l.kind === 'col' && l.path === col) setTimeout(() => l.next(colDocs(col, l.q)), 0);
    }
  }
  const check = (p, even) => { const n = p.split('/').length; if (!!(n % 2) === even) throw new TypeError('bad path parity: ' + p); if (!/^[A-Za-z0-9_\-.~:@+\/]+$/.test(p)) throw new TypeError('bad path chars: ' + p); };
  function docRef(p) {
    check(p, true);
    return {
      id: p.split('/').pop(), path: p,
      get: async () => docSnap(p),
      set: async body => { if (typeof body !== 'object' || Array.isArray(body)) throw { code: 'invalid_argument', message: 'body' }; docs.set(p, clone(body)); notify(p); },
      update: async body => { if (!docs.has(p)) throw { code: 'invalid_argument', message: 'update on missing doc ' + p }; docs.set(p, Object.assign({}, docs.get(p), clone(body))); notify(p); },
      delete: async () => { docs.delete(p); notify(p); },
      acquire: async ({ holder, ttlMs }) => {
        const now = Date.now(); const l = leases.get(p);
        if (l && l.expires > now && l.holder !== holder) return { acquired: false, expiresAt: new Date(l.expires).toISOString() };
        leases.set(p, { holder, expires: now + (ttlMs || 30000) });
        if (ACQUIRE_CREATES_DOC && !docs.has(p)) { docs.set(p, {}); notify(p); }
        return { acquired: true, holder, expiresAt: new Date(now + (ttlMs || 30000)).toISOString() };
      },
      onSnapshot: (next, err) => { const l = { kind: 'doc', path: p, next }; listeners.push(l); setTimeout(() => next(docSnap(p)), 0); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
      collection: sub => colRef(p + '/' + sub),
    };
  }
  function query(col, q) {
    return {
      path: col,
      where: (f, op, v) => query(col, Object.assign({}, q, { where: (q.where || []).concat([[f, op, v]]) })),
      orderBy: (f, d) => query(col, Object.assign({}, q, { orderBy: [f, d || 'asc'] })),
      limit: n => query(col, Object.assign({}, q, { limit: n })),
      get: async () => colDocs(col, q),
      onSnapshot: (next, err) => { const l = { kind: 'col', path: col, next, q }; listeners.push(l); setTimeout(() => next(colDocs(col, q)), 0); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
    };
  }
  function colRef(col) {
    check(col, false);
    const q = query(col, {});
    q.doc = id => docRef(col + '/' + (id || ('d' + Math.random().toString(36).slice(2, 10))));
    q.add = async body => { const r = q.doc(); await r.set(body); return r; };
    return q;
  }
  return { docs, doc: docRef, collection: colRef, dump: () => Object.fromEntries(docs) };
}

/* ---------------- boot a page against the store ---------------- */
function boot(store, opts) {
  const saved = [];
  const dom = new JSDOM('<!doctype html><html><head><meta charset="utf-8"></head><body>' + PAGE + '</body></html>', {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://artifact.test/',
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', { value: webcrypto });
      window.TextEncoder = TextEncoder;
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.claude = { use: async name => {
        if (name === 'db') return Object.freeze({ doc: store.doc, collection: store.collection });
        if (name === 'user') return Object.freeze({ isOwner: async () => !!opts.owner, can: async () => opts.canWrite === undefined ? true : opts.canWrite, id: async () => opts.id || 'u_test' });
        if (name === 'downloads') return Object.freeze({ save: async r => { saved.push(r); return { status: 'saved' }; } });
        return null;
      } };
    },
  });
  dom.window.addEventListener('error', e => { console.error('PAGE ERROR:', e.message, e.error && e.error.stack); process.exitCode = 1; });
  const $ = id => dom.window.document.getElementById(id);
  return { dom, $, saved, txt: id => $(id).textContent.trim(), hidden: id => $(id).hidden };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) { if (cond) console.log('  ok  ' + msg); else { failures++; console.log('  FAIL ' + msg); } }
function setVal(win, id, v) { const el = win.document.getElementById(id); el.value = v; el.dispatchEvent(new win.window.Event('input', { bubbles: true })); el.dispatchEvent(new win.window.Event('change', { bubbles: true })); }
async function logSale(page, pkgIdx, qty, email) {
  const w = page.dom.window;
  page.$('pkg').value = String(pkgIdx); page.$('pkg').dispatchEvent(new w.Event('change'));
  page.$('qty').value = String(qty); page.$('qty').dispatchEvent(new w.Event('change'));
  page.$('email').value = email;
  page.$('sale-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
}

(async () => {
  console.log('acquire creates doc: ' + ACQUIRE_CREATES_DOC);
  const store = makeStore();
  const A = boot(store, { owner: true, id: 'u_owner' });
  const B = boot(store, { owner: false, id: 'u_seller' });
  await sleep(150);

  console.log('\n1. first paint, empty raffle');
  check(A.txt('status-pill') === 'Sales open', 'status pill reads Sales open (A): ' + A.txt('status-pill'));
  check(A.txt('sale-btn') === 'Log sale' && !A.$('sale-btn').disabled, 'Log sale button enabled');
  check(A.txt('t-tickets') === '0' && A.txt('t-raised') === '$0', 'tally zeros: ' + A.txt('t-tickets') + ' ' + A.txt('t-raised'));
  check(!A.hidden('pin-banner'), 'owner sees the set-a-PIN banner');
  check(B.hidden('pin-banner'), 'seller does not see the PIN banner');
  check(!A.hidden('settings-btn') && B.hidden('settings-btn'), 'settings button owner-only');
  check(A.$('draw-btn').disabled, 'draw disabled with no tickets');
  check(A.txt('sale-summary') === '1 ticket · $5', 'default summary: ' + A.txt('sale-summary'));

  console.log('\n2. set PIN 2468 (owner)');
  A.$('settings-btn').click();
  A.$('pin-new').value = '2468'; A.$('pin-confirm').value = '2468'; A.$('pin-save').click();
  await sleep(150);
  check(store.docs.get('raffle/config') && /^[0-9a-f]{64}$/.test(store.docs.get('raffle/config').pinHash), 'config doc holds a sha256 hash');
  check(A.txt('pin-status').startsWith('Set'), 'pin status: ' + A.txt('pin-status'));
  check(A.hidden('pin-banner'), 'PIN banner gone');

  console.log('\n3. log a sale: 3 for $10 × 2 (A)');
  await logSale(A, 1, 2, 'jane@example.com');
  await sleep(200);
  const sales1 = [...store.docs.entries()].filter(([p]) => p.startsWith('sales/')).map(([, b]) => b);
  check(sales1.length === 1 && sales1[0].from === 1 && sales1[0].to === 6 && sales1[0].amount === 20 && sales1[0].tickets === 6, 'sale doc #1–#6, $20: ' + JSON.stringify(sales1[0]));
  check(store.docs.get('raffle/state').next === 7 && store.docs.get('raffle/state').status === 'open', 'state next=7 open: ' + JSON.stringify(store.docs.get('raffle/state')));
  check(!A.hidden('receipt') && A.txt('r-range') === '#1–#6', 'receipt shows #1–#6: ' + A.txt('r-range'));
  check(A.txt('r-say').includes('1 to 6'), 'receipt says tickets 1 to 6');
  check(A.txt('t-tickets') === '6' && A.txt('t-raised') === '$20' && A.txt('t-half') === '$10', 'tally 6 / $20 / $10: ' + [A.txt('t-tickets'), A.txt('t-raised'), A.txt('t-half')].join(' '));
  check(B.txt('t-tickets') === '6', 'device B sees 6 tickets live');
  check(A.txt('next-ticket') === 'Next ticket #7', 'next ticket label: ' + A.txt('next-ticket'));
  check(A.$('email').value === '' && A.$('qty').value === '1' && A.$('pkg').value === '0', 'form reset after sale');
  check(A.$('ledger-list').children.length === 1 && A.$('ledger-list').textContent.includes('jane@example.com'), 'ledger row rendered');

  console.log('\n4. concurrent sales from A and B');
  const t0 = Date.now();
  await Promise.all([logSale(A, 0, 1, 'a@example.com'), logSale(B, 2, 1, 'b@example.com')]);
  await sleep(2200);
  const twoDone = [...store.docs.keys()].filter(p => p.startsWith('sales/')).length === 3;
  check(twoDone, 'both concurrent sales landed within 2.2s');
  await logSale(B, 3, 1, 'c@example.com');
  await sleep(400);
  const all = [...store.docs.entries()].filter(([p]) => p.startsWith('sales/')).map(([, b]) => b).sort((x, y) => x.from - y.from);
  let disjoint = true; for (let i = 1; i < all.length; i++) if (all[i].from !== all[i - 1].to + 1) disjoint = false;
  check(all.length === 4 && disjoint, 'four sales, contiguous disjoint ranges: ' + all.map(s => s.from + '-' + s.to).join(', '));
  const totalTickets = all.reduce((n, s) => n + s.to - s.from + 1, 0);
  check(store.docs.get('raffle/state').next === totalTickets + 1, 'state.next = total+1 (' + store.docs.get('raffle/state').next + ')');
  check(A.txt('t-tickets') === String(totalTickets) && B.txt('t-tickets') === String(totalTickets), 'both devices show ' + totalTickets + ' tickets');
  check(A.txt('t-raised') === '$95', 'raised $95: ' + A.txt('t-raised'));

  console.log('\n5. invalid email + filter');
  await logSale(A, 0, 1, 'not-an-email');
  await sleep(100);
  check(!A.hidden('sale-error') && A.txt('sale-error').includes('valid email'), 'invalid email error: ' + A.txt('sale-error'));
  setVal(A.dom.window, 'ledger-filter', 'jane');
  check(A.$('ledger-list').children.length === 1, 'filter by email → 1 row');
  setVal(A.dom.window, 'ledger-filter', '#3');
  check(A.$('ledger-list').children.length === 1 && A.$('ledger-list').textContent.includes('jane'), 'filter by ticket #3 → jane');
  setVal(A.dom.window, 'ledger-filter', '');

  console.log('\n6. void a sale (B voids c@example.com) then restore');
  const rowC = [...B.$('ledger-list').children].find(li => li.textContent.includes('c@example.com'));
  rowC.querySelector('.xbtn').click(); await sleep(50);
  const rowC2 = [...B.$('ledger-list').children].find(li => li.textContent.includes('c@example.com'));
  check(rowC2.textContent.includes('Void #'), 'inline confirm shown');
  rowC2.querySelector('.xbtn.yes').click(); await sleep(200);
  const cDoc = [...store.docs.values()].find(b => b.email === 'c@example.com');
  check(cDoc.voided === true, 'c voided in store');
  check(A.txt('t-raised') === '$45', 'tally excludes voided: ' + A.txt('t-raised'));
  check(A.txt('ledger-count').includes('1 voided'), 'ledger count mentions voided: ' + A.txt('ledger-count'));

  console.log('\n7. draw: wrong PIN, then right PIN');
  A.$('draw-btn').click(); await sleep(50);
  check(!A.hidden('modal') && A.txt('m-title').includes('draw the winner'), 'confirm modal opened: ' + A.txt('m-title'));
  check(A.txt('m-body').includes('tickets') && A.txt('m-body').includes('$45'), 'modal body names pot: ' + A.txt('m-body'));
  A.$('m-pin').value = '0000'; A.$('m-confirm').click(); await sleep(200);
  check(!A.hidden('m-error') && A.txt('m-error').includes('PIN'), 'wrong PIN rejected: ' + A.txt('m-error'));
  check(!store.docs.get('raffle/state').status || store.docs.get('raffle/state').status === 'open', 'still open after wrong PIN');
  A.$('m-pin').value = '2468'; A.$('m-confirm').click(); await sleep(400);
  const st = store.docs.get('raffle/state');
  check(st.status === 'drawn' && st.draw && typeof st.draw.ticket === 'number', 'state drawn: ' + JSON.stringify(st.draw));
  const winnerSale = all.find(s => s.email !== 'c@example.com' && st.draw.ticket >= s.from && st.draw.ticket <= s.to);
  check(!!winnerSale && winnerSale.email === st.draw.email, 'winning ticket maps to a live sale and its email (' + st.draw.ticket + ' → ' + st.draw.email + ')');
  check(st.draw.pool === 17 && st.draw.gross === 45, 'draw pool 17 tickets, gross $45');
  check(A.hidden('modal'), 'modal closed');
  await sleep(3400);
  check(!A.hidden('winner') && A.txt('w-ticket') === '#' + st.draw.ticket && A.txt('w-email') === st.draw.email, 'A winner panel: ' + A.txt('w-ticket') + ' ' + A.txt('w-email'));
  check(!B.hidden('winner') && B.txt('w-ticket') === '#' + st.draw.ticket, 'B winner panel live: ' + B.txt('w-ticket'));
  check(A.txt('status-pill') === 'Drawn' && B.txt('status-pill') === 'Drawn', 'pills read Drawn');
  check(A.hidden('sale-form') && !A.hidden('closed-note'), 'sale form hidden, closed note shown');
  check(A.$('draw-btn').hidden, 'draw button gone');
  check(![...A.$('ledger-list').querySelectorAll('.xbtn')].length, 'no void buttons after draw');

  console.log('\n8. sale attempt after draw is refused by the store logic');
  const vals = store.docs.size;
  B.$('sale-form').hidden = false;
  await logSale(B, 0, 1, 'late@example.com'); await sleep(300);
  check(store.docs.size === vals, 'no new sale doc after draw');

  console.log('\n9. stage view masks email; export CSV');
  A.$('stage-btn').click(); await sleep(20);
  check(A.dom.window.document.body.classList.contains('stage') && A.txt('w-email').includes('•••@'), 'stage view masked: ' + A.txt('w-email'));
  A.$('stage-btn').click(); await sleep(20);
  check(A.txt('w-email') === st.draw.email, 'exit stage restores email');
  A.$('export-btn').click(); await sleep(100);
  check(A.saved.length === 1 && A.saved[0].filename.endsWith('.csv'), 'downloads.save called: ' + (A.saved[0] && A.saved[0].filename));
  const csvLines = A.saved[0].data.split('\r\n');
  check(csvLines[0].startsWith('ticket_from,ticket_to') && csvLines.length >= 6 && csvLines.some(l => l.includes(',voided')) && csvLines.some(l => l.startsWith('winning_ticket,' + st.draw.ticket)), 'CSV has header, 4 rows incl. voided, winner line');
  console.log('     ' + csvLines.slice(0, 3).join('\n     '));

  console.log('\n10. reset (owner, PIN + RESET)');
  A.$('reset-pin').value = '2468'; A.$('reset-word').value = 'RESET'; A.$('reset-btn').click(); await sleep(600);
  check([...store.docs.keys()].filter(p => p.startsWith('sales/')).length === 0, 'all sales deleted');
  const st2 = store.docs.get('raffle/state');
  check(st2.status === 'open' && st2.next === 1 && !st2.draw, 'state reset: ' + JSON.stringify(st2));
  check(A.hidden('winner') && B.hidden('winner') && A.txt('status-pill') === 'Sales open', 'winner hidden, sales open on both');
  check(A.txt('t-tickets') === '0', 'tally back to 0');
  check(A.txt('reset-msg').includes('reset'), 'reset message: ' + A.txt('reset-msg'));

  console.log('\n11. view-only viewer and no-db viewer');
  const V = boot(store, { owner: false, canWrite: false, id: 'u_viewer' }); await sleep(150);
  check(V.hidden('sale-card') && V.hidden('draw-card') && !V.hidden('viewonly'), 'view-only hides sale + draw cards, shows notice');
  const N = (() => { const p = boot(store, {}); return p; })();
  const dom2 = new JSDOM('<!doctype html><html><body>' + PAGE + '</body></html>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://x.test/', beforeParse(w) { Object.defineProperty(w, 'crypto', { value: webcrypto }); w.TextEncoder = TextEncoder; w.HTMLElement.prototype.scrollIntoView = function () {}; w.claude = { use: async () => null }; } });
  await sleep(150);
  const d2 = dom2.window.document;
  check(!d2.getElementById('nodb').hidden && d2.getElementById('sale-btn').disabled && d2.getElementById('sale-btn').textContent === 'Not connected', 'no-db: notice shown, button "Not connected"');

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
