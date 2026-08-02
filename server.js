'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

/* ========================= RULES ========================= */
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RV = { '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
const MINBID = 100, MAXBID = 200, STEP = 5, TOTALPTS = 200;
const BOTNAMES = ['Namdeo', 'Veena', 'Santosh', 'Ankush', 'Binny', 'Mukesh'];

const ptsOf = c => (c.r === '5' || c.r === '10') ? 5 : c.r === 'A' ? 10 : (c.r === 'Q' && c.s === 'S') ? 20 : 0;

function buildDeck() {
  const d = []; let id = 0;
  for (let dk = 0; dk < 2; dk++) for (const s of SUITS) for (const r of RANKS) {
    if (r === '4' && dk === 1) continue;
    d.push({ r, s, id: id++ });
  }
  return d; // 84
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }
const SUIT_ORDER = ['S', 'H', 'C', 'D']; // black, red, green, blue: never two alike side by side
function suitOrder(trump) {
  if (!trump) return SUIT_ORDER;
  const i = SUIT_ORDER.indexOf(trump);
  return SUIT_ORDER.slice(i).concat(SUIT_ORDER.slice(0, i));
}
function sortHand(h, trump) {
  const ord = suitOrder(trump);
  return h.sort((a, b) => ord.indexOf(a.s) - ord.indexOf(b.s) || RV[b.r] - RV[a.r]);
}
function beats(a, b, trump, lead) {
  const at = a.s === trump, bt = b.s === trump;
  if (at !== bt) return at;
  if (at) return RV[a.r] > RV[b.r];
  const al = a.s === lead, bl = b.s === lead;
  if (al !== bl) return al;
  if (!al) return false;
  return RV[a.r] > RV[b.r];
}
function legal(hand, lead) {
  if (!lead) return hand.slice();
  const f = hand.filter(c => c.s === lead);
  return f.length ? f : hand.slice();
}

/* ========================= ROOMS ========================= */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.random() * CODE_CHARS.length | 0]).join(''); }
  while (rooms.has(c));
  return c;
}
const tok = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function createRoom(size) {
  const code = newCode();
  const R = {
    code, size, phase: 'lobby', players: [], hostToken: null,
    log: [], chat: [], fxq: [], fxSeq: 0, turnKey: null,
    timer: null, createdAt: Date.now(), lastTouch: Date.now()
  };
  rooms.set(code, R);
  return R;
}
function esc2(x) { return String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fx(R, name, to, label) { R.fxq.push({ name, to: (to === undefined ? null : to), label: label || null }); }
function notifyTurn(R) {
  let k = null;
  if (R.phase === 'play') k = 'p' + turnPlayer(R);
  else if (R.phase === 'bid') k = 'b' + R.bidState.turn;
  else if (R.phase === 'declare') k = 'd' + R.bidder;
  if (k && k !== R.turnKey) {
    R.turnKey = k;
    const i = +k.slice(1);
    if (R.players[i] && !R.players[i].bot) fx(R, 'yourturn', i);
  }
}
function say(R, html) { R.log.unshift(html); if (R.log.length > 60) R.log.pop(); }

/* ========================= DEAL FLOW ========================= */
function startGame(R) {
  while (R.players.length < R.size) {
    const used = new Set(R.players.map(p => p.name));
    const nm = BOTNAMES.find(n => !used.has(n)) || 'Bot' + R.players.length;
    R.players.push({ name: nm, token: tok(), bot: true, connected: true, score: 0, hand: [], won: 0 });
  }
  R.n = R.size;
  R.handSize = R.n === 6 ? 14 : 12;
  R.totalDeals = R.n === 6 ? 9 : 10;
  R.dealNo = 0;
  R.dealer = R.n - 1;
  R.log = [];
  startDeal(R);
}

function startDeal(R) {
  R.dealNo++;
  R.dealer = (R.dealer + 1) % R.n;
  const deck = shuffle(buildDeck());
  R.players.forEach((p, i) => { p.hand = deck.slice(i * R.handSize, (i + 1) * R.handSize); p.won = 0; });
  R.trump = null; R.called = [null, null]; R.calledDone = [false, false];
  R.bidder = null; R.bidAmount = null; R.team = new Set(); R.privateTeam = new Set();
  R.trick = []; R.lead = null; R.leader = null; R.trickNo = 0; R.lastTrick = null; R.result = null;
  R.bigTrick = null; R.partnerAt = [null, null]; R.cuts = {};
  R.bidState = { turn: (R.dealer + 1) % R.n, high: null, highBidder: null, passed: new Set(), opened: false };
  R.phase = 'bid';
  say(R, `<b>Round ${R.dealNo} of ${R.totalDeals}</b> dealt by ${R.players[R.dealer].name}. ${R.players[R.bidState.turn].name} opens.`);
  push(R); tick(R);
}

function activeBidders(R) { let c = 0; for (let i = 0; i < R.n; i++) if (!R.bidState.passed.has(i)) c++; return c; }
function nextBidder(R, from) {
  let i = from;
  for (let k = 0; k < R.n; k++) { i = (i + 1) % R.n; if (!R.bidState.passed.has(i)) return i; }
  return -1;
}
function minBidFor(R) { const b = R.bidState; return b.opened ? b.high + STEP : MINBID; }

function doBid(R, idx, amt) {
  const b = R.bidState;
  if (R.phase !== 'bid' || b.turn !== idx) return;
  amt = Math.round(amt / STEP) * STEP;
  if (amt < minBidFor(R) || amt > MAXBID) return;
  b.high = amt; b.highBidder = idx; b.opened = true;
  say(R, `<b>${R.players[idx].name}</b> bids <span class="hi">${amt}</span>.`);
  afterBid(R, idx);
}
function doPass(R, idx) {
  const b = R.bidState;
  if (R.phase !== 'bid' || b.turn !== idx) return;
  if (!b.opened) return; // opener must bid
  b.passed.add(idx);
  say(R, `${R.players[idx].name} passes.`);
  afterBid(R, idx);
}
function afterBid(R, from) {
  const b = R.bidState;
  if (b.opened && activeBidders(R) <= 1) {
    R.bidder = b.highBidder; R.bidAmount = b.high;
    R.team = new Set([R.bidder]); R.privateTeam = new Set([R.bidder]);
    R.phase = 'declare';
    say(R, `<b>${R.players[R.bidder].name}</b> takes the contract at <span class="hi">${R.bidAmount}</span>.`);
    fx(R, 'contract');
    push(R); tick(R); return;
  }
  b.turn = nextBidder(R, from);
  push(R); tick(R);
}

function doDeclare(R, idx, trump, calls) {
  if (R.phase !== 'declare' || R.bidder !== idx) return;
  if (!SUITS.includes(trump) || !Array.isArray(calls) || calls.length !== 2) return;
  for (const c of calls) {
    if (!RANKS.includes(c.r) || !SUITS.includes(c.s)) return;
  }
  // the same card may be called twice, meaning both copies bring in a partner.
  // 4s exist only once in the deck, so a doubled 4 is impossible.
  if (calls[0].r === calls[1].r && calls[0].s === calls[1].s && calls[0].r === '4') return;
  R.trump = trump; R.called = [{ r: calls[0].r, s: calls[0].s }, { r: calls[1].r, s: calls[1].s }];
  R.phase = 'play'; R.leader = R.bidder; R.trickNo = 1; R.trick = []; R.lead = null;
  say(R, `Trump is <span class="hi">${trump}</span>. Called: <span class="hi">${R.called[0].r}${R.called[0].s}</span> and <span class="hi">${R.called[1].r}${R.called[1].s}</span>.`);
  fx(R, 'declared', null, JSON.stringify({
    b: esc2(R.players[R.bidder].name), a: R.bidAmount, t: trump, c: R.called
  }));
  push(R); tick(R);
}

function turnPlayer(R) { return (R.leader + R.trick.length) % R.n; }

function doPlay(R, idx, cardId) {
  if (R.phase !== 'play' || turnPlayer(R) !== idx) return;
  const p = R.players[idx];
  const card = p.hand.find(c => c.id === cardId);
  if (!card) return;
  if (!legal(p.hand, R.lead).some(c => c.id === cardId)) return;

  p.hand = p.hand.filter(c => c.id !== cardId);
  if (R.trick.length === 0) R.lead = card.s;
  R.trick.push({ p: idx, card });

  fx(R, 'card');
  if (card.r === 'Q' && card.s === 'S') fx(R, 'queen', null, 'Black Queen &middot; 20');
  if (card.s === R.trump && R.lead !== R.trump && R.lead !== null) {
    R.cuts[idx] = (R.cuts[idx] || 0) + 1;
    fx(R, 'trumpcut', null, esc2(p.name) + ' cuts');
  }

  for (let k = 0; k < 2; k++) {
    if (R.calledDone[k]) continue;
    const cc = R.called[k];
    if (card.r !== cc.r || card.s !== cc.s) continue;
    if (idx === R.bidder) {
      // the bidder cannot partner himself, so the call passes to the other copy
      const holder = R.players.findIndex((q, j) => !R.team.has(j) && q.hand.some(c => c.r === cc.r && c.s === cc.s));
      if (holder >= 0) {
        R.privateTeam.add(holder);
        say(R, `${p.name} lays the called ${cc.r}${cc.s}. Whoever holds the other copy is now a partner.`);
      } else {
        R.calledDone[k] = true;
        say(R, `No ${cc.r}${cc.s} left outside the bidding side, so that call is dead.`);
      }
    } else if (!R.team.has(idx)) {
      R.calledDone[k] = true; R.team.add(idx); R.privateTeam.add(idx);
      R.partnerAt[k] = R.trickNo;
      say(R, `<span class="jd">${p.name} lays ${cc.r}${cc.s} and joins ${R.players[R.bidder].name}.</span>`);
      fx(R, 'partner', null, esc2(p.name) + ' joins ' + esc2(R.players[R.bidder].name));
    } else {
      // already a partner, and now holds a second called card: the call is spent, no third player joins
      R.calledDone[k] = true;
      R.partnerAt[k] = R.trickNo;
      say(R, `<span class="jd">${p.name} lays ${cc.r}${cc.s} as well, so ${R.players[R.bidder].name} plays with one partner only.</span>`);
      fx(R, 'partner', null, esc2(p.name) + ' partners alone');
    }
    break;
  }

  if (R.trick.length === R.n) {
    R.phase = 'resolve'; push(R);
    arm(R, () => resolveTrick(R), TRICK_MS);
  } else { push(R); tick(R); }
}

function resolveTrick(R) {
  if (R.phase !== 'resolve' || R.trick.length !== R.n) return;
  let best = 0;
  for (let i = 1; i < R.trick.length; i++)
    if (beats(R.trick[i].card, R.trick[best].card, R.trump, R.lead)) best = i;
  const w = R.trick[best].p;
  const pts = R.trick.reduce((a, t) => a + ptsOf(t.card), 0);
  R.players[w].won += pts;
  R.lastTrick = { winner: w, pts };
  if (pts > 0) say(R, `${R.players[w].name} takes trick ${R.trickNo} <span class="hi">(+${pts})</span>.`);
  if (!R.bigTrick || pts > R.bigTrick.pts) R.bigTrick = { i: w, pts, no: R.trickNo };
  fx(R, 'trickwin', w);
  if (pts >= 20) fx(R, 'bigpot', null, '+' + pts + ' in one trick');
  R.leader = w; R.trick = []; R.lead = null; R.trickNo++;
  if (R.trickNo > R.handSize) endDeal(R);
  else { R.phase = 'play'; push(R); tick(R); }
}

function teamPoints(R) { let t = 0; R.team.forEach(i => t += R.players[i].won); return t; }

function endDeal(R) {
  const tp = teamPoints(R), op = TOTALPTS - tp;
  const made = tp >= R.bidAmount;
  const isLast = R.dealNo === R.totalDeals;
  const winners = [], losers = [];
  for (let i = 0; i < R.n; i++) (R.team.has(i) === made ? winners : losers).push(i);
  const award = made ? tp : (isLast ? op : R.bidAmount);
  winners.forEach(i => R.players[i].score += award);
  R.result = { tp, op, made, isLast, award, winners, big: R.bigTrick, partnerAt: R.partnerAt,
    cuts: Object.entries(R.cuts).map(([i, c]) => ({ i: +i, c })).sort((a, b) => b.c - a.c).slice(0, 1)[0] || null };
  say(R, made
    ? `<b>Contract made.</b> Team collected ${tp} against ${R.bidAmount}. <span class="hi">+${award}</span> each to ${winners.map(i => R.players[i].name).join(', ')}.`
    : `<b>Contract broken.</b> Team collected only ${tp} of ${R.bidAmount}. <span class="hi">+${award}</span> each to ${winners.map(i => R.players[i].name).join(', ')}.`);
  for (let i = 0; i < R.n; i++) fx(R, winners.includes(i) ? 'made' : 'broken', i);
  R.phase = isLast ? 'gameover' : 'dealover';
  push(R);
  if (!isLast) arm(R, () => { if (R.phase === 'dealover') startDeal(R); }, NEXT_MS);
}

/* ========================= BOT BRAIN ========================= */
function botCeiling(R, i) {
  const h = R.players[i].hand;
  const pts = h.reduce((a, c) => a + ptsOf(c), 0);
  const by = { S: 0, H: 0, D: 0, C: 0 }; h.forEach(c => by[c.s]++);
  const longest = Math.max(...SUITS.map(s => by[s]));
  const aces = h.filter(c => c.r === 'A').length;
  const kings = h.filter(c => c.r === 'K').length;
  let est = 52 + pts * 0.55 + longest * 6.5 + aces * 5 + kings * 2.5 + (Math.random() * 14 - 7);
  return Math.min(MAXBID, Math.round(est / STEP) * STEP);
}
function botBid(R, i) {
  const b = R.bidState;
  if (!b.opened) return doBid(R, i, MINBID);
  const want = b.high + STEP;
  if (want <= botCeiling(R, i) && want <= MAXBID) doBid(R, i, want); else doPass(R, i);
}
function botDeclare(R, i) {
  const h = R.players[i].hand;
  const by = { S: 0, H: 0, D: 0, C: 0 }; h.forEach(c => by[c.s]++);
  let trump = SUITS[0]; SUITS.forEach(s => { if (by[s] > by[trump]) trump = s; });
  const have = new Set(h.map(c => c.r + c.s));
  const cands = [];
  if (!have.has('QS')) cands.push({ r: 'Q', s: 'S', w: 100 });
  SUITS.forEach(s => { if (!have.has('A' + s)) cands.push({ r: 'A', s, w: 60 - by[s] * 4 + (s === trump ? 15 : 0) }); });
  SUITS.forEach(s => { if (!have.has('K' + s)) cands.push({ r: 'K', s, w: 20 - by[s] * 3 }); });
  SUITS.forEach(s => cands.push({ r: 'A', s, w: 5 }));
  cands.sort((a, b) => b.w - a.w);
  const seen = new Set(), pick = [];
  for (const c of cands) { const k = c.r + c.s; if (seen.has(k)) continue; seen.add(k); pick.push(c); if (pick.length === 2) break; }
  doDeclare(R, i, trump, [{ r: pick[0].r, s: pick[0].s }, { r: pick[1].r, s: pick[1].s }]);
}
function knownMate(R, i, j) {
  if (R.team.has(i) && R.team.has(j)) return true;
  if (R.privateTeam.has(i) && (j === R.bidder || R.team.has(j))) return true;
  return false;
}
function botPlay(R, i) {
  const hand = R.players[i].hand;
  const opts = legal(hand, R.lead);
  if (!opts.length) return;
  const pot = R.trick.reduce((a, t) => a + ptsOf(t.card), 0);
  const last = R.trick.length === R.n - 1;

  if (R.trick.length === 0) {
    const ace = opts.find(c => c.r === 'A' && c.s !== R.trump);
    const trumps = opts.filter(c => c.s === R.trump);
    if (ace && Math.random() < 0.75) return doPlay(R, i, ace.id);
    if (trumps.length >= 4) {
      const hi = trumps.slice().sort((a, b) => RV[b.r] - RV[a.r])[0];
      if (RV[hi.r] >= 12) return doPlay(R, i, hi.id);
    }
    const safe = opts.filter(c => ptsOf(c) === 0);
    const pool = safe.length ? safe : opts;
    return doPlay(R, i, pool.sort((a, b) => RV[a.r] - RV[b.r])[0].id);
  }
  let best = 0;
  for (let k = 1; k < R.trick.length; k++)
    if (beats(R.trick[k].card, R.trick[best].card, R.trump, R.lead)) best = k;
  const friendly = knownMate(R, i, R.trick[best].p);
  const winners = opts.filter(c => beats(c, R.trick[best].card, R.trump, R.lead));

  if (friendly && last) {
    const fat = opts.slice().sort((a, b) => ptsOf(b) - ptsOf(a))[0];
    if (ptsOf(fat) > 0) return doPlay(R, i, fat.id);
  }
  if (!friendly && winners.length && (pot > 0 || Math.random() < 0.35)) {
    winners.sort((a, b) => (a.s === R.trump) - (b.s === R.trump) || RV[a.r] - RV[b.r]);
    return doPlay(R, i, winners[0].id);
  }
  const junk = opts.filter(c => ptsOf(c) === 0 && c.s !== R.trump);
  const pool = junk.length ? junk : opts.filter(c => ptsOf(c) === 0);
  const fin = pool.length ? pool : opts;
  return doPlay(R, i, fin.sort((a, b) => ptsOf(a) - ptsOf(b) || RV[a.r] - RV[b.r])[0].id);
}

/* ========================= TURN DRIVER ========================= */
const AWAY_MS = +(process.env.AWAY_MS || 30000);
const BOT_MS = +(process.env.BOT_MS || 900);
const TRICK_MS = +(process.env.TRICK_MS || 2600);
const NEXT_MS = +(process.env.NEXT_MS || 7000);
function arm(R, fn, ms) { clearTimeout(R.timer); R.timer = setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, ms); }

function tick(R) {
  clearTimeout(R.timer);
  let idx = null, act = null;
  if (R.phase === 'bid') { idx = R.bidState.turn; act = () => botBid(R, idx); }
  else if (R.phase === 'declare') { idx = R.bidder; act = () => botDeclare(R, idx); }
  else if (R.phase === 'play') { idx = turnPlayer(R); act = () => botPlay(R, idx); }
  else return;
  const p = R.players[idx];
  if (p.bot) arm(R, act, BOT_MS);
  else if (!p.connected) arm(R, act, AWAY_MS);
}

/* ========================= VIEWS ========================= */
function viewFor(R, me) {
  if (R.phase === 'lobby') {
    return {
      phase: 'lobby', code: R.code, size: R.size, you: me,
      isHost: R.players[me] && R.players[me].token === R.hostToken,
      chat: R.chat.slice(-40),
      seats: R.players.map(p => ({ name: p.name, bot: !!p.bot, connected: p.connected }))
    };
  }
  const p = R.players[me];
  const showPts = R.phase !== 'bid' && R.phase !== 'declare';
  const v = {
    phase: R.phase, code: R.code, you: me, n: R.n,
    dealNo: R.dealNo, totalDeals: R.totalDeals, handSize: R.handSize,
    trump: R.trump, called: R.called, calledDone: R.calledDone,
    bidder: R.bidder, bidAmount: R.bidAmount, dealer: R.dealer,
    team: [...R.team], secretMate: R.privateTeam.has(me) && !R.team.has(me) && R.bidder !== me,
    teamPts: R.team.size ? teamPoints(R) : 0,
    trick: R.trick.map(t => ({ p: t.p, card: t.card })),
    trickNo: Math.min(R.trickNo, R.handSize),
    lastTrick: R.lastTrick, result: R.result, log: R.log.slice(0, 40),
    seats: R.players.map((q, i) => ({
      name: q.name, score: q.score, cards: q.hand.length, bot: !!q.bot,
      connected: q.connected, won: showPts ? q.won : null
    })),
    hand: p ? sortHand(p.hand.slice(), R.trump) : [],
    chat: R.chat.slice(-40)
  };
  if (R.phase === 'bid') {
    v.bid = {
      turn: R.bidState.turn, high: R.bidState.high, highBidder: R.bidState.highBidder,
      opened: R.bidState.opened, passed: [...R.bidState.passed], min: minBidFor(R)
    };
  }
  if (R.phase === 'play') {
    v.turn = turnPlayer(R);
    if (v.turn === me) v.legalIds = legal(p.hand, R.lead).map(c => c.id);
  }
  return v;
}
function send(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { } } }
function push(R) {
  R.lastTouch = Date.now();
  notifyTurn(R);
  const seq = ++R.fxSeq;
  R.players.forEach((p, i) => {
    if (p.bot || !p.ws) return;
    const v = viewFor(R, i);
    v.fx = R.fxq.filter(e => e.to === null || e.to === i).map(e => ({ n: e.name, l: e.label }));
    v.fxId = seq;
    send(p.ws, { t: 'state', v });
  });
  R.fxq = [];
}

/* ========================= SOCKETS ========================= */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let file = url === '/' ? '/index.html' : url;
  const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(fp);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, m); } catch (e) { console.error(e); send(ws, { t: 'err', msg: 'Something went wrong on the table.' }); }
  });
  ws.on('close', () => {
    const R = ws.room; if (!R) return;
    const p = R.players.find(q => q.ws === ws);
    if (!p) return;
    p.connected = false; p.ws = null;
    if (R.phase === 'lobby') {
      R.players = R.players.filter(q => q !== p);
      if (R.players.length === 0) { clearTimeout(R.timer); rooms.delete(R.code); return; }
      if (p.token === R.hostToken) R.hostToken = R.players[0].token;
    }
    push(R); tick(R);
  });
});

function handle(ws, m) {
  if (m.t === 'create') {
    const size = m.size === 7 ? 7 : 6;
    const R = createRoom(size);
    const p = { name: cleanName(m.name), token: tok(), bot: false, connected: true, ws, score: 0, hand: [], won: 0 };
    R.players.push(p); R.hostToken = p.token;
    ws.room = R;
    send(ws, { t: 'seated', code: R.code, token: p.token, seat: 0 });
    push(R); return;
  }
  if (m.t === 'join') {
    const R = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!R) return send(ws, { t: 'err', msg: 'No table with that code. Check the four letters.' });
    // reconnect path
    if (m.token) {
      const i = R.players.findIndex(q => q.token === m.token);
      if (i >= 0) {
        const p = R.players[i];
        if (p.ws && p.ws !== ws) try { p.ws.close(); } catch (e) { }
        p.ws = ws; p.connected = true; ws.room = R;
        send(ws, { t: 'seated', code: R.code, token: p.token, seat: i });
        push(R); tick(R); return;
      }
    }
    if (R.phase !== 'lobby') return send(ws, { t: 'err', msg: 'That game has already started.' });
    if (R.players.length >= R.size) return send(ws, { t: 'err', msg: 'That table is full.' });
    const p = { name: cleanName(m.name), token: tok(), bot: false, connected: true, ws, score: 0, hand: [], won: 0 };
    R.players.push(p); ws.room = R;
    send(ws, { t: 'seated', code: R.code, token: p.token, seat: R.players.length - 1 });
    push(R); return;
  }

  const R = ws.room; if (!R) return;
  const me = R.players.findIndex(q => q.ws === ws);
  if (me < 0) return;

  if (m.t === 'size' && R.phase === 'lobby' && R.players[me].token === R.hostToken) {
    if (m.size === 6 || m.size === 7) { if (R.players.length <= m.size) { R.size = m.size; push(R); } }
    return;
  }
  if (m.t === 'start' && R.phase === 'lobby' && R.players[me].token === R.hostToken) { startGame(R); return; }
  if (m.t === 'chat') {
    const now = Date.now();
    const p = R.players[me];
    if (p.lastChat && now - p.lastChat < 600) return;
    const text = String(m.text || '').replace(/[<>&"']/g, '').trim().slice(0, 180);
    if (!text) return;
    p.lastChat = now;
    R.chat.push({ i: me, name: p.name, text, at: now });
    if (R.chat.length > 60) R.chat.shift();
    for (let j = 0; j < R.players.length; j++) if (j !== me) fx(R, 'chat', j);
    push(R);
    return;
  }
  if (m.t === 'bid') return doBid(R, me, Number(m.amount));
  if (m.t === 'pass') return doPass(R, me);
  if (m.t === 'declare') return doDeclare(R, me, m.trump, m.calls);
  if (m.t === 'play') return doPlay(R, me, Number(m.cardId));
  if (m.t === 'next' && R.phase === 'dealover') { clearTimeout(R.timer); startDeal(R); return; }
  if (m.t === 'again' && R.phase === 'gameover' && R.players[me].token === R.hostToken) {
    R.players.forEach(p => p.score = 0);
    startGame(R); return;
  }
}
function cleanName(n) {
  n = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14);
  return n || 'Player';
}

/* keepalive + room reaping */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch (e) { }
  });
}, 30000);
setInterval(() => {
  const now = Date.now();
  rooms.forEach((R, code) => {
    const live = R.players.some(p => !p.bot && p.connected);
    if (!live && now - R.lastTouch > 30 * 60 * 1000) { clearTimeout(R.timer); rooms.delete(code); }
  });
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Black Queen listening on ' + PORT));
