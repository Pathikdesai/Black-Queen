'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
/* An unbiased shuffle from the system generator. Math.random is fine for a
   friendly game, but a deal is the one thing nobody should be able to predict,
   and randomInt costs nothing at 84 cards. */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[a[i], a[j]] = [a[j], a[i]]; } return a; }
const COPIES = r => r === '4' ? 1 : 2; // the 4s come from one pack only
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
const MAX_ROOMS = +(process.env.MAX_ROOMS || 500);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
const tok = () => crypto.randomBytes(16).toString('hex');

function createRoom(size) {
  const code = newCode();
  const R = {
    code, size, phase: 'lobby', players: [], hostToken: null,
    log: [], chat: [], chatSeq: 0, history: [], fxq: [], fxSeq: 0, turnKey: null,
    turnTimerKey: null, turnDeadline: 0,
    timer: null, createdAt: Date.now(), lastTouch: Date.now()
  };
  rooms.set(code, R);
  return R;
}
function esc2(x) { return String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fx(R, name, to, label, data) { R.fxq.push({ name, to: (to === undefined ? null : to), label: label || null, data: data || null }); }
/* Who the table is waiting on, as a stable string. Both the "your turn" cue and
   the turn clock key off this, so a state push that changes nothing about whose
   turn it is cannot restart either of them. */
function turnKeyOf(R) {
  if (R.phase === 'play') return 'p' + turnPlayer(R);
  if (R.phase === 'bid') return 'b' + R.bidState.turn;
  if (R.phase === 'declare') return 'd' + R.bidder;
  return null;
}
/* How long this seat gets, and who is counting. Kept apart from tick because
   push runs first and has to send an already-current deadline: computing it in
   tick left every client one turn behind, showing a clock that had already run
   out before the turn began. */
function turnMode(R, i) {
  const p = R.players[i];
  if (!p) return null;
  return p.bot ? 'bot' : p.connected ? 'live' : 'away';
}
function fullMs(mode) { return mode === 'bot' ? BOT_MS : mode === 'away' ? AWAY_MS : TURN_MS; }
function refreshDeadline(R) {
  const k = turnKeyOf(R);
  if (!k) { R.turnTimerKey = null; R.turnDeadline = 0; return null; }
  const i = +k.slice(1);
  const mode = turnMode(R, i);
  if (!mode) { R.turnTimerKey = null; R.turnDeadline = 0; return null; }
  /* The deadline belongs to the turn, not to the push that happened to notice
     it. State goes out on every change, chat included, so recomputing the delay
     each time would let a talkative table hold the clock open forever. A change
     of seat, or of whether that seat is still with us, starts a fresh one. */
  const key = k + '|' + mode;
  if (R.turnTimerKey !== key) { R.turnTimerKey = key; R.turnDeadline = Date.now() + fullMs(mode); }
  return { i, mode };
}
function notifyTurn(R) {
  refreshDeadline(R);
  const k = turnKeyOf(R);
  if (k && k !== R.turnKey) {
    R.turnKey = k;
    const i = +k.slice(1);
    clearTimeout(R.slowTimer);
    if (R.players[i] && !R.players[i].bot) {
      fx(R, 'yourturn', i);
      const mine = k;
      R.slowTimer = setTimeout(() => {
        // still the same person still sitting on the same turn
        if (R.turnKey !== mine || R.phase === 'lobby' || R.phase === 'gameover') return;
        fx(R, 'slow', null, esc2(R.players[i].name) + ' is thinking',
          { who: R.players[i].name, seconds: Math.round(SLOW_MS / 1000), phase: R.phase });
        push(R);
      }, SLOW_MS);
    }
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
  /* Card counting memory, rebuilt every deal. seen counts copies already played,
     voids records who has failed to follow which suit. The bots read both. */
  R.seen = {}; R.voids = R.players.map(() => new Set());
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
  }), { bidder: R.players[R.bidder].name, amount: R.bidAmount, trump, calls: R.called });
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
  // failing to follow proves a void, and is the single most useful thing to know
  if (R.lead && card.s !== R.lead) R.voids[idx].add(R.lead);
  R.seen[card.r + card.s] = (R.seen[card.r + card.s] || 0) + 1;
  if (R.trick.length === 0) R.lead = card.s;
  R.trick.push({ p: idx, card });

  fx(R, 'card');
  if (card.r === 'Q' && card.s === 'S') fx(R, 'queen', null, 'Black Queen &middot; 20', { who: p.name });
  if (card.s === R.trump && R.lead !== R.trump && R.lead !== null) {
    R.cuts[idx] = (R.cuts[idx] || 0) + 1;
    fx(R, 'trumpcut', null, esc2(p.name) + ' cuts', { who: p.name, suit: R.trump });
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
      fx(R, 'partner', null, esc2(p.name) + ' joins ' + esc2(R.players[R.bidder].name),
        { who: p.name, bidder: R.players[R.bidder].name, team: shownTeam(R), settled: R.calledDone[0] && R.calledDone[1], sole: false });
    } else {
      // already a partner, and now holds a second called card: the call is spent, no third player joins
      R.calledDone[k] = true;
      R.partnerAt[k] = R.trickNo;
      say(R, `<span class="jd">${p.name} lays ${cc.r}${cc.s} as well, so ${R.players[R.bidder].name} plays with one partner only.</span>`);
      fx(R, 'partner', null, esc2(p.name) + ' partners alone',
        { who: p.name, bidder: R.players[R.bidder].name, team: shownTeam(R), settled: R.calledDone[0] && R.calledDone[1], sole: true });
    }
    break;
  }

  if (R.trick.length === R.n) {
    R.phase = 'resolve'; push(R);
    arm(R, () => resolveTrick(R), TRICK_MS, 'resolve');
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
  // keep the cards themselves so the table can look back at what just happened
  R.lastTrick = { winner: w, pts, no: R.trickNo, lead: R.lead, cards: R.trick.map(t => ({ p: t.p, card: t.card })) };
  if (pts > 0) say(R, `${R.players[w].name} takes trick ${R.trickNo} <span class="hi">(+${pts})</span>.`);
  if (!R.bigTrick || pts > R.bigTrick.pts) R.bigTrick = { i: w, pts, no: R.trickNo };
  fx(R, 'trickwin', w, null, { who: R.players[w].name, pts, trick: R.trickNo });
  if (pts >= 20) fx(R, 'bigpot', null, '+' + pts + ' in one trick', { who: R.players[w].name, pts, trick: R.trickNo });
  R.leader = w; R.trick = []; R.lead = null; R.trickNo++;
  if (R.trickNo > R.handSize) return endDeal(R);
  if (deadContract(R)) {
    const short = R.bidAmount - (TOTALPTS - oppPoints(R));
    say(R, `<b>${R.players[R.bidder].name}</b> cannot reach ${R.bidAmount} any more, short by ${short} even with every remaining point. Deal ends here.`);
    fx(R, 'deadcontract', null, 'Bid is out of reach',
      { bidder: R.players[R.bidder].name, amount: R.bidAmount, short, trick: R.trickNo - 1 });
    return endDeal(R);
  }
  R.phase = 'play'; push(R); tick(R);
}

function shownTeam(R) { return [...R.team].map(i => R.players[i].name); }
function teamPoints(R) { let t = 0; R.team.forEach(i => t += R.players[i].won); return t; }
function oppPoints(R) { let t = 0; for (let i = 0; i < R.n; i++) if (!R.team.has(i)) t += R.players[i].won; return t; }

/* A deal is dead once the bidding side cannot reach the bid even by taking every
   remaining point. Ending there changes nothing: a failed contract pays each
   opponent the bid amount regardless of what was actually collected.
   Two guards:
   - never in the final round, where a failed contract pays actual points, so the
     rest of the tricks genuinely still matter
   - never before both called cards are down, because an unrevealed partner's
     points are still sitting in the opposition column and would make the
     bidding side look further behind than it is */
function deadContract(R) {
  if (R.dealNo >= R.totalDeals) return false;
  if (!(R.calledDone[0] && R.calledDone[1])) return false;
  return (TOTALPTS - oppPoints(R)) < R.bidAmount;
}

function endDeal(R) {
  const tp = teamPoints(R), op = oppPoints(R);
  const unplayed = TOTALPTS - tp - op;
  const made = tp >= R.bidAmount;
  const isLast = R.dealNo === R.totalDeals;
  const winners = [], losers = [];
  for (let i = 0; i < R.n; i++) (R.team.has(i) === made ? winners : losers).push(i);
  const award = made ? tp : (isLast ? op : R.bidAmount);
  winners.forEach(i => R.players[i].score += award);
  R.result = { tp, op, made, isLast, award, winners, unplayed, early: unplayed > 0, big: R.bigTrick, partnerAt: R.partnerAt,
    cuts: Object.entries(R.cuts).map(([i, c]) => ({ i: +i, c })).sort((a, b) => b.c - a.c).slice(0, 1)[0] || null };
  say(R, made
    ? `<b>Contract made.</b> Team collected ${tp} against ${R.bidAmount}. <span class="hi">+${award}</span> each to ${winners.map(i => R.players[i].name).join(', ')}.`
    : `<b>Contract broken.</b> Team collected only ${tp} of ${R.bidAmount}.${unplayed > 0 ? ` The bid was already out of reach, so the last ${R.handSize - R.trickNo + 1} trick${R.handSize - R.trickNo + 1 === 1 ? '' : 's'} were not played.` : ''} <span class="hi">+${award}</span> each to ${winners.map(i => R.players[i].name).join(', ')}.`);
  R.history.push({
    deal: R.dealNo, bidder: R.bidder, amount: R.bidAmount, trump: R.trump,
    made, tp, op, award, early: unplayed > 0,
    team: [...R.team], winners: winners.slice(),
    scores: R.players.map(q => q.score)
  });
  const rd = { bidder: R.players[R.bidder].name, amount: R.bidAmount, made, tp, op,
    team: shownTeam(R), winners: winners.map(i => R.players[i].name) };
  for (let i = 0; i < R.n; i++) fx(R, winners.includes(i) ? 'made' : 'broken', i, null, rd);
  fx(R, made ? 'contractmade' : 'contractbroken', null, null, rd);
  if (tp === TOTALPTS || op === TOTALPTS) {
    const swept = tp === TOTALPTS;
    fx(R, 'sweep', null, (swept ? 'Bidding side' : 'The opposition') + ' took all 200',
      { side: swept ? 'bidding' : 'against', pts: TOTALPTS,
        team: swept ? shownTeam(R) : R.players.filter((q, i) => !R.team.has(i)).map(q => q.name) });
  }
  if (isLast) {
    const best = Math.max(...R.players.map(q => q.score));
    const champs = R.players.filter(q => q.score === best).map(q => q.name);
    fx(R, 'gamewinner', null, champs.join(' and ') + ' wins',
      { who: champs[0], winners: champs, team: champs, score: best, tied: champs.length > 1 });
  }
  clearTimeout(R.slowTimer);
  R.phase = isLast ? 'gameover' : 'dealover';
  push(R);
  if (!isLast) arm(R, () => { if (R.phase === 'dealover') startDeal(R); }, NEXT_MS, 'deal');
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

/* ---- what a bot may fairly work out from the table ----
   Only two sources: cards already played, and cards in its own hand. Both are
   things a human at the table can see too, so this is counting, not cheating. */
function stillOut(R, i, s, r) {
  const played = R.seen[r + s] || 0;
  const mine = R.players[i].hand.filter(c => c.r === r && c.s === s).length;
  return COPIES(r) - played - mine;
}
/* The best card of a suit that somebody else could still be holding. If my own
   card matches it, mine wins: identical cards tie in favour of the earlier
   play, and the leader always plays first. */
function topOut(R, i, s) {
  for (let k = RANKS.length - 1; k >= 0; k--) if (stillOut(R, i, s, RANKS[k]) > 0) return RV[RANKS[k]];
  return 0;
}
function opponentVoid(R, i, s) {
  return R.players.some((q, j) => j !== i && !knownMate(R, i, j) && R.voids[j] && R.voids[j].has(s));
}
function trumpsOut(R, i) {
  let n = 0;
  for (const r of RANKS) n += stillOut(R, i, R.trump, r);
  return n;
}

function botPlay(R, i) {
  const hand = R.players[i].hand;
  const opts = legal(hand, R.lead);
  if (!opts.length) return;
  const pot = R.trick.reduce((a, t) => a + ptsOf(t.card), 0);
  const last = R.trick.length === R.n - 1;
  const bySuit = s => hand.filter(c => c.s === s).length;

  if (R.trick.length === 0) {
    /* Leading. A card that nobody can beat is worth cashing, biggest points
       first, but only in a suit no opponent is known to be out of, since a void
       opponent with a trump left would simply cut it. */
    const cashable = opts.filter(c => c.s !== R.trump
      && RV[c.r] >= topOut(R, i, c.s)
      && !(opponentVoid(R, i, c.s) && trumpsOut(R, i) > 0));
    if (cashable.length) {
      cashable.sort((a, b) => ptsOf(b) - ptsOf(a) || RV[b.r] - RV[a.r]);
      return doPlay(R, i, cashable[0].id);
    }
    // Otherwise draw trumps while holding length in them, which protects points later.
    const trumps = opts.filter(c => c.s === R.trump);
    if (trumps.length >= 4 && trumpsOut(R, i) > 0) {
      const hi = trumps.slice().sort((a, b) => RV[b.r] - RV[a.r])[0];
      if (RV[hi.r] >= topOut(R, i, R.trump)) return doPlay(R, i, hi.id);
    }
    // Nothing to cash: lead a low card from the shortest side suit and keep the points.
    const safe = opts.filter(c => ptsOf(c) === 0 && c.s !== R.trump);
    const pool = safe.length ? safe : (opts.filter(c => ptsOf(c) === 0).length ? opts.filter(c => ptsOf(c) === 0) : opts);
    return doPlay(R, i, pool.sort((a, b) => bySuit(a.s) - bySuit(b.s) || RV[a.r] - RV[b.r])[0].id);
  }

  let best = 0;
  for (let k = 1; k < R.trick.length; k++)
    if (beats(R.trick[k].card, R.trick[best].card, R.trump, R.lead)) best = k;
  const friendly = knownMate(R, i, R.trick[best].p);
  const winners = opts.filter(c => beats(c, R.trick[best].card, R.trump, R.lead));

  // Partner is holding the trick and nobody is left to take it off them: feed the points.
  if (friendly && last) {
    const fat = opts.slice().sort((a, b) => ptsOf(b) - ptsOf(a))[0];
    if (ptsOf(fat) > 0) return doPlay(R, i, fat.id);
  }
  if (!friendly && winners.length) {
    /* Spend a card on this trick when there is something in it, when I am last
       and can take it cheaply, or when everyone still to play is void in the
       led suit and the pot is about to be cut away from me anyway. */
    const cheapest = winners.slice().sort((a, b) =>
      (a.s === R.trump) - (b.s === R.trump) || RV[a.r] - RV[b.r])[0];
    const cheap = RV[cheapest.r] <= RV['10'];
    if (pot > 0 || (last && cheap) || (cheap && !opponentVoid(R, i, R.lead))) {
      return doPlay(R, i, cheapest.id);
    }
  }
  /* Throwing away. Points stay in hand where possible, and among equally worthless
     cards the one from the shortest suit goes, which is how a void gets created. */
  const junk = opts.filter(c => ptsOf(c) === 0 && c.s !== R.trump);
  const pool = junk.length ? junk : opts.filter(c => ptsOf(c) === 0);
  const fin = pool.length ? pool : opts;
  return doPlay(R, i, fin.sort((a, b) =>
    ptsOf(a) - ptsOf(b) || bySuit(a.s) - bySuit(b.s) || RV[a.r] - RV[b.r])[0].id);
}

/* ========================= TURN DRIVER ========================= */
const AWAY_MS = +(process.env.AWAY_MS || 30000);
const TURN_MS = +(process.env.TURN_MS || 60000);
const SLOW_MS = +(process.env.SLOW_MS || 15000);
const LOBBY_GRACE_MS = +(process.env.LOBBY_GRACE_MS || 90000);
const CHAT_MS = +(process.env.CHAT_MS || 600);
const BOT_MS = +(process.env.BOT_MS || 900);
const TRICK_MS = +(process.env.TRICK_MS || 2600);
const NEXT_MS = +(process.env.NEXT_MS || 7000);
function arm(R, fn, ms, tag) {
  clearTimeout(R.timer);
  R.timerTag = tag || null;
  R.timer = setTimeout(() => {
    R.timerTag = null;
    try { fn(); } catch (e) { console.error(e); }
  }, ms);
}

function tick(R) {
  /* These two phases are driven by a pending timer rather than by a player.
     tick used to clear that timer and then fall straight out of the bottom,
     which froze the table forever if anyone reconnected while a completed
     trick was still on the cloth. Re-arm instead, and only if the pending
     timer is not already the right one, so repeated calls cannot keep
     pushing the deadline back. */
  if (R.phase === 'resolve') {
    if (R.timerTag !== 'resolve') arm(R, () => resolveTrick(R), TRICK_MS, 'resolve');
    return;
  }
  if (R.phase === 'dealover') {
    if (R.timerTag !== 'deal' && R.dealNo < R.totalDeals) {
      arm(R, () => { if (R.phase === 'dealover') startDeal(R); }, NEXT_MS, 'deal');
    }
    return;
  }
  clearTimeout(R.timer); R.timerTag = null;
  let idx = null, act = null;
  if (R.phase === 'bid') { idx = R.bidState.turn; act = () => botBid(R, idx); }
  else if (R.phase === 'declare') { idx = R.bidder; act = () => botDeclare(R, idx); }
  else if (R.phase === 'play') { idx = turnPlayer(R); act = () => botPlay(R, idx); }
  else { R.turnTimerKey = null; R.turnDeadline = 0; return; }
  const p = R.players[idx];
  if (!refreshDeadline(R)) return;
  const left = Math.max(0, R.turnDeadline - Date.now());

  const fire = () => {
    /* A live player who ran the clock out gets their turn played for them
       rather than the table stopping. Said out loud, so nobody thinks the game
       glitched. */
    if (!p.bot && p.connected) say(R, `<b>${p.name}</b> ran out of time, so the table played on.`);
    act();
  };
  arm(R, fire, left, 'turn');
}

/* ========================= VIEWS ========================= */
function viewFor(R, me) {
  if (R.phase === 'lobby') {
    return {
      phase: 'lobby', code: R.code, size: R.size, you: me,
      isHost: R.players[me] && R.players[me].token === R.hostToken,
      hostSeat: R.players.findIndex(p => p.token === R.hostToken),
      chat: R.chat.slice(-40),
      seats: R.players.map(p => ({ name: p.name, bot: !!p.bot, connected: p.connected }))
    };
  }
  const p = R.players[me];
  const showPts = R.phase !== 'bid' && R.phase !== 'declare';
  const v = {
    phase: R.phase, code: R.code, you: me, n: R.n,
    isHost: !!(R.players[me] && R.players[me].token === R.hostToken),
    hostSeat: R.players.findIndex(q => q.token === R.hostToken),
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
    chat: R.chat.slice(-40),
    history: R.history
  };
  /* Remaining time on the current turn, sent as a duration rather than a wall
     clock instant because the phone's clock is not ours to trust. Bots move too
     fast to be worth a countdown. */
  const tp = turnKeyOf(R) === null ? -1 : +turnKeyOf(R).slice(1);
  if (tp >= 0 && R.players[tp] && !R.players[tp].bot && R.turnDeadline) {
    v.turnMs = Math.max(0, R.turnDeadline - Date.now());
    v.turnSeat = tp;
  }
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
    v.fx = R.fxq.filter(e => e.to === null || e.to === i).map(e => ({ n: e.name, l: e.label, d: e.data }));
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
    const ext = path.extname(fp).toLowerCase();
    const TYPES = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
      '.webmanifest': 'application/manifest+json',
      '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
      '.wav': 'audio/wav', '.webm': 'audio/webm', '.aac': 'audio/aac',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon'
    };
    const type = TYPES[ext] || 'application/octet-stream';
    const isText = /^(text\/|application\/json)/.test(type);
    // media is immutable in practice, so let phones keep it instead of
    // pulling it down again on every single refresh
    const cache = /^(audio|image)\//.test(type) ? 'public, max-age=604800' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': type + (isText ? '; charset=utf-8' : ''),
      'Content-Length': data.length,
      'Cache-Control': cache
    });
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
      /* Do NOT drop the seat straight away. A host waiting for friends to join
         will have their phone lock the screen or lose signal, and instantly
         losing the seat meant they came back as a nameless new player with no
         host rights. Hold the seat, and only release it if they stay away. */
      clearTimeout(p.dropTimer);
      p.dropTimer = setTimeout(() => releaseSeat(R, p), LOBBY_GRACE_MS);
    }
    push(R); tick(R);
  });
});

function handle(ws, m) {
  if (m.t === 'create') {
    /* A socket gets one table. Without this, repeated create messages left the
       earlier rooms holding a player still marked connected, which the reaper
       treats as a live table and never collects. */
    if (ws.room) leaveRoom(ws);
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Too many tables are open right now. Try again in a minute.' });
    const now = Date.now();
    if (ws.lastCreate && now - ws.lastCreate < 1000) return;
    ws.lastCreate = now;
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
    if (ws.room && ws.room !== R) leaveRoom(ws);
    // reconnect path
    if (m.token) {
      const i = R.players.findIndex(q => q.token === m.token);
      if (i >= 0) {
        const p = R.players[i];
        clearTimeout(p.dropTimer);
        if (p.ws && p.ws !== ws) try { p.ws.close(); } catch (e) { }
        p.ws = ws; p.connected = true; ws.room = R;
        send(ws, { t: 'seated', code: R.code, token: p.token, seat: i });
        push(R); tick(R); return;
      }
    }
    // Fallback for a player who lost their saved token: a new phone, a cleared
    // browser, a private tab. Let them reclaim their own seat by name, but only
    // if that seat is actually sitting empty, so nobody can bump a live player.
    if (R.phase === 'lobby' && m.name) {
      const want = String(m.name).trim().toLowerCase();
      const i = R.players.findIndex(q => !q.bot && !q.connected && q.name.toLowerCase() === want);
      if (i >= 0) {
        const p = R.players[i];
        const wasHost = p.token === R.hostToken;
        clearTimeout(p.dropTimer);
        if (p.ws && p.ws !== ws) try { p.ws.close(); } catch (e) { }
        p.token = tok(); p.ws = ws; p.connected = true; ws.room = R;
        if (wasHost) R.hostToken = p.token;
        send(ws, { t: 'seated', code: R.code, token: p.token, seat: i });
        push(R); return;
      }
    }
    if (R.phase !== 'lobby') {
      const want = cleanName(m.name).toLowerCase();
      if (want) {
        const i = R.players.findIndex(q => !q.bot && !q.connected && q.name.toLowerCase() === want);
        if (i >= 0) {
          const p = R.players[i];
          if (p.ws && p.ws !== ws) try { p.ws.close(); } catch (e) { }
          const wasHost = p.token === R.hostToken;
          p.token = tok(); p.ws = ws; p.connected = true; ws.room = R;
          if (wasHost) R.hostToken = p.token;
          send(ws, { t: 'seated', code: R.code, token: p.token, seat: i });
          say(R, `<b>${p.name}</b> is back at the table.`);
          push(R); tick(R); return;
        }
        const live = R.players.findIndex(q => !q.bot && q.connected && q.name.toLowerCase() === want);
        if (live >= 0) return send(ws, { t: 'err', msg: 'Someone is already playing as ' + R.players[live].name + ' on this table.' });
      }
      const away = R.players.filter(q => !q.bot && !q.connected).map(q => q.name);
      return send(ws, {
        t: 'err',
        msg: away.length
          ? 'That game has started. To take your seat back, join with the exact name you used: ' + away.join(', ') + '.'
          : 'That game has already started and every seat is taken.'
      });
    }
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
    if (p.lastChat && now - p.lastChat < CHAT_MS) return;
    const text = String(m.text || '').replace(/[<>&"']/g, '').trim().slice(0, 180);
    if (!text) return;
    p.lastChat = now;
    /* Every message carries its own id. The client used to spot new messages by
       comparing array lengths, which stopped working the moment the log hit the
       40 message window and the length stopped growing. */
    R.chat.push({ id: ++R.chatSeq, i: me, name: p.name, text, at: now });
    if (R.chat.length > 60) R.chat.shift();
    for (let j = 0; j < R.players.length; j++) if (j !== me) fx(R, 'chat', j);
    push(R);
    return;
  }
  if (m.t === 'hagga') {
    const now = Date.now();
    const p = R.players[me];
    if (p.lastHagga && now - p.lastHagga < 3000) return;
    p.lastHagga = now;
    say(R, `<b>${p.name}</b> hits the Hagga.`);
    fx(R, 'hagga', null, esc2(p.name) + ' hits the Hagga', { who: p.name });
    push(R);
    return;
  }
  if (m.t === 'leave') { leaveRoom(ws); return; }
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
/* Standing up on purpose, as opposed to a phone going dark. In the lobby the
   seat is freed straight away instead of being held for the reconnect grace,
   because somebody who taps Leave is not coming back in ninety seconds. Once
   the cards are out the seat is kept either way, since it holds a hand and a
   score that have to go somewhere. */
function leaveRoom(ws) {
  const R = ws.room;
  ws.room = null;
  if (!R) return;
  const p = R.players.find(q => q.ws === ws);
  if (!p) return;
  clearTimeout(p.dropTimer);
  p.ws = null; p.connected = false;
  if (R.phase === 'lobby') releaseSeat(R, p);
  else { say(R, `${p.name} left the table.`); push(R); tick(R); }
}
function releaseSeat(R, p) {
  if (R.phase !== 'lobby' || p.connected) return;
  const wasHost = p.token === R.hostToken;
  R.players = R.players.filter(q => q !== p);
  if (R.players.length === 0) { clearTimeout(R.timer); clearTimeout(R.slowTimer); rooms.delete(R.code); return; }
  if (wasHost) {
    const next = R.players.find(q => q.connected && !q.bot) || R.players[0];
    R.hostToken = next.token;
    say(R, `<b>${next.name}</b> is now hosting.`);
  }
  push(R);
}
function cleanName(n) {
  n = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14);
  return n || 'Player';
}

/* keepalive + room reaping. Both are unref'd so that requiring this file for a
   test does not leave a process that will never exit. */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch (e) { }
  });
}, 30000).unref();
setInterval(() => {
  const now = Date.now();
  rooms.forEach((R, code) => {
    const live = R.players.some(p => !p.bot && p.connected);
    if (!live && now - R.lastTouch > 30 * 60 * 1000) { clearTimeout(R.timer); clearTimeout(R.slowTimer); rooms.delete(code); }
  });
}, 60000).unref();

/* ========================= SURVIVING A RESTART =========================
   A game in progress used to die with the process. Everything the table needs
   lives in plain data, so it can be written out on the way down and read back
   on the way up; players reconnect with the token their phone already holds and
   land in the same seat with the same cards.

   This covers a crash, a manual restart and an out of memory kill, all of which
   reuse the same disk. It does NOT cover a redeploy on a host that hands you a
   fresh container, because the file goes with the old one. Deploy between
   games, as before. */
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '.rooms.json');
const SKIP = new Set(['ws', 'timer', 'slowTimer', 'dropTimer', 'timerTag']);

function dumpRooms() {
  const out = [];
  rooms.forEach(R => {
    // a lobby has nothing to lose, and a finished game has nothing to resume
    if (R.phase === 'lobby' || R.phase === 'gameover') return;
    if (!R.players.some(p => !p.bot)) return;
    const o = {};
    for (const k of Object.keys(R)) {
      if (SKIP.has(k)) continue;
      const v = R[k];
      if (v instanceof Set) o[k] = [...v];
      else if (k === 'voids' && Array.isArray(v)) o[k] = v.map(s => [...s]);
      else if (k === 'bidState' && v) o[k] = Object.assign({}, v, { passed: [...v.passed] });
      else if (k === 'players') o[k] = v.map(p => {
        const q = {};
        for (const pk of Object.keys(p)) if (!SKIP.has(pk)) q[pk] = p[pk];
        q.connected = false;
        return q;
      });
      else o[k] = v;
    }
    out.push(o);
  });
  return out;
}
function saveRooms() {
  try {
    const data = dumpRooms();
    if (!data.length) { try { fs.unlinkSync(STATE_FILE); } catch (e) { } return 0; }
    fs.writeFileSync(STATE_FILE, JSON.stringify(data));
    return data.length;
  } catch (e) { console.error('could not save tables:', e.message); return 0; }
}
function loadRooms() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch (e) { return 0; }
  // read once: a file left lying around would restore stale tables on every boot
  try { fs.unlinkSync(STATE_FILE); } catch (e) { }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return 0; }
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const o of arr) {
    if (!o || !o.code || rooms.has(o.code)) continue;
    const R = Object.assign({}, o);
    R.team = new Set(o.team || []);
    R.privateTeam = new Set(o.privateTeam || []);
    if (o.bidState) R.bidState = Object.assign({}, o.bidState, { passed: new Set(o.bidState.passed || []) });
    R.voids = (o.voids || []).map(a => new Set(a));
    R.players = (o.players || []).map(p => Object.assign({}, p, { ws: null, connected: false }));
    R.timer = null; R.slowTimer = null; R.timerTag = null;
    R.turnKey = null; R.turnTimerKey = null; R.turnDeadline = 0;
    R.fxq = [];
    R.lastTouch = Date.now();
    rooms.set(R.code, R);
    n++;
  }
  /* Deliberately not resuming play here. Everyone is disconnected at this
     instant, and arming the clock now would have bots play the whole round
     before the first phone has finished reconnecting. The first rejoin calls
     tick and the table picks up where it left off. */
  return n;
}

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  const n = saveRooms();
  console.log(sig + ': saved ' + n + ' table' + (n === 1 ? '' : 's'));
  try { wss.clients.forEach(c => { try { c.close(1012, 'restarting'); } catch (e) { } }); } catch (e) { }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* The tests require this file to reach the rules engine directly. BQ_NO_LISTEN
   keeps it from taking a port when they do; nothing else changes. */
if (process.env.BQ_NO_LISTEN !== '1') {
  const restored = loadRooms();
  if (restored) console.log('restored ' + restored + ' table' + (restored === 1 ? '' : 's') + ' from the last run');
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('Black Queen listening on ' + PORT));
}

module.exports = {
  buildDeck, shuffle, ptsOf, beats, legal, sortHand, RANKS, SUITS, RV, TOTALPTS, COPIES,
  rooms, createRoom, startGame, dumpRooms, loadRooms, saveRooms, tok
};
