'use strict';
/* Searches for better bot strategy numbers by replaying fixed deals.

     npm run tune              -- search from the current settings
     npm run tune -- --check   -- just measure the current settings against themselves
     npm run tune -- --deals=120 --rounds=25

   ------------------------------------------------------------------
   Why fixed deals

   Comparing two versions of the brain by playing them a few hundred random
   games barely works: the cards decide most of it, and the difference you are
   looking for is a few percent buried under that. Every measurement in this
   project has had a few percent of noise for exactly that reason.

   So the deals are generated from a seed and reused. Both versions play the
   same cards, from the same seats, with the same dealer. Then the whole set is
   played again with the two sides swapped, so a lucky seat helps each of them
   exactly once. What is left after that is the strategy and almost nothing
   else. It is how duplicate bridge is scored, and for the same reason.

   ------------------------------------------------------------------
   What this is not

   It is not AlphaZero. There is no network and no tree search, and it does not
   learn the game from nothing — it starts from the rules a player gave us and
   only adjusts the weights those rules are applied with. It cannot discover a
   new idea; it can only tell you that a void is worth four rather than three.
   Anything it finds should still be read by somebody who plays, because a
   number that wins against these bots is not automatically a number that wins
   against people. */

process.env.BQ_NO_LISTEN = '1';
process.env.BOT_MS = process.env.BOT_MS || '0';
process.env.TRICK_MS = process.env.TRICK_MS || '0';
process.env.NEXT_MS = process.env.NEXT_MS || '0';

const path = require('path');
const G = require(path.join(__dirname, '..', 'server.js'));

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : dflt;
};
const DEALS = +arg('deals', 90);
const ROUNDS = +arg('rounds', 20);
const SEED = +arg('seed', 20260824);
const CHECK_ONLY = process.argv.includes('--check');
const KEEP_NOISE = process.argv.includes('--noise');

/* The bidding carries a deliberate random wobble so the bots do not all value a
   hand identically. For measurement that wobble is poison: it makes the same
   brain play the same cards two different ways, and the difference it produces
   swamps the difference being looked for. Every evaluation therefore runs with
   it switched off, which makes a deal a pure function of the cards and the
   settings. Pass --noise to leave it in and watch the measurement fall apart. */
const flat = t => KEEP_NOISE ? t : Object.assign({}, t, { bidNoise: 0 });

/* ---------- reproducible deals ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeDeals(n, seed) {
  const r = rng(seed);
  const out = [];
  for (let d = 0; d < n; d++) {
    const deck = G.buildDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    out.push({ hands: Array.from({ length: 6 }, (_, s) => deck.slice(s * 14, (s + 1) * 14)),
               dealer: d % 6 });
  }
  return out;
}

/* ---------- play one fixed deal to the end ---------- */
function playDeal(deal, tunes) {
  const R = G.createRoom(6);
  for (let i = 0; i < 6; i++) {
    R.players.push({
      name: 'S' + i, token: 'k' + i, bot: true, connected: true, ws: null,
      score: 0, hand: deal.hands[i].map(c => ({ r: c.r, s: c.s, id: c.id })),
      won: 0, tune: tunes[i]
    });
  }
  R.hostToken = 'k0';
  R.n = 6; R.handSize = 14; R.totalDeals = 9; R.dealNo = 1; R.dealer = deal.dealer;
  R.trump = null; R.called = [null, null]; R.calledDone = [false, false];
  R.bidder = null; R.bidAmount = null;
  R.team = new Set(); R.privateTeam = new Set();
  R.trick = []; R.lead = null; R.leader = null; R.trickNo = 0;
  R.lastTrick = null; R.result = null; R.bigTrick = null;
  R.partnerAt = [null, null]; R.cuts = {};
  R.seen = {}; R.voids = R.players.map(() => new Set());
  R.bidState = { turn: (R.dealer + 1) % 6, high: null, highBidder: null,
                 passed: new Set(), opened: false };
  R.phase = 'bid';

  /* Driven by hand rather than by the timers, so a deal finishes in a
     millisecond and nothing depends on the clock. */
  let guard = 0;
  while (R.phase !== 'dealover' && R.phase !== 'gameover' && guard++ < 4000) {
    if (R.phase === 'bid') G.botBid(R, R.bidState.turn);
    else if (R.phase === 'declare') G.botDeclare(R, R.bidder);
    else if (R.phase === 'play') G.botPlay(R, (R.leader + R.trick.length) % 6);
    else if (R.phase === 'resolve') { clearTimeout(R.timer); G.resolveTrick(R); }
    else break;
  }
  clearTimeout(R.timer); clearTimeout(R.slowTimer);
  const res = R.result;
  const out = { ok: !!res, gain: new Array(6).fill(0) };
  if (res) res.winners.forEach(i => { out.gain[i] = res.award; });
  G.rooms.delete(R.code);
  return out;
}

/* ---------- one side against the other, on identical cards ---------- */
const EVEN = [0, 2, 4], ODD = [1, 3, 5];
function duel(deals, tuneA, tuneB) {
  let a = 0, b = 0, played = 0;
  for (const deal of deals) {
    // A on the even seats, then the same deal again with A on the odd ones
    for (const aSeats of [EVEN, ODD]) {
      const A = flat(tuneA), B = flat(tuneB);
      const tunes = Array.from({ length: 6 }, (_, i) => aSeats.includes(i) ? A : B);
      const r = playDeal(deal, tunes);
      if (!r.ok) continue;
      played++;
      for (let i = 0; i < 6; i++) {
        if (aSeats.includes(i)) a += r.gain[i]; else b += r.gain[i];
      }
    }
  }
  return { a, b, played, edge: a - b };
}

/* ---------- the search ---------- */
const KNOBS = {
  bidBase: [40, 80, 2], bidLongest: [2, 12, 0.5], bidSpadeLen: [0, 4, 0.25],
  bidAce: [2, 12, 0.5], bidQueen: [0, 14, 0.5], bidKing: [0, 6, 0.25],
  bidVoid: [0, 8, 0.5], bidPoints: [0, 0.6, 0.05],
  // bidNoise is deliberately absent: it exists to stop the bots being identical
  // to each other, not to make them stronger, and it is switched off to measure
  suitAce: [0, 3, 0.25], suitKing: [0, 2, 0.25],
  suitQueenBonus: [0, 4, 0.25], suitQueenNeeds: [3, 8, 1],
  callQueenTrump: [40, 110, 4], callQueenOff: [0, 100, 4], callQueenHeld: [0, 40, 2],
  callAceTrump: [40, 110, 4], callAceOff: [20, 100, 4], callAceHeld: [0, 30, 2],
  callKingTrump: [20, 100, 4], callKingOff: [0, 60, 3], callKingHeld: [0, 20, 2],
  drawTrumpsFrom: [2, 8, 1], catcherPot: [0, 45, 5],
  revealSuitOut: [0, 10, 1], cheapWinner: [6, 14, 1]
};
const NAMES = Object.keys(KNOBS);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function search(deals) {
  const r = rng(SEED ^ 0x5f3759df);
  let best = Object.assign({}, G.TUNE);
  console.log(`hill climbing over ${NAMES.length} numbers`);
  console.log(`${deals.length} fixed deals, each played twice with the sides swapped`);
  console.log(`that is ${deals.length * 2} deals per comparison\n`);
  let improved = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    // nudge a few knobs at once, so the search can cross a ridge
    const trial = Object.assign({}, best);
    const howMany = 1 + Math.floor(r() * 3);
    const touched = [];
    for (let k = 0; k < howMany; k++) {
      const name = NAMES[Math.floor(r() * NAMES.length)];
      const [lo, hi, step] = KNOBS[name];
      const dir = r() < 0.5 ? -1 : 1;
      const size = 1 + Math.floor(r() * 3);
      trial[name] = clamp(+(trial[name] + dir * step * size).toFixed(3), lo, hi);
      if (trial[name] !== best[name]) touched.push(`${name} ${best[name]}->${trial[name]}`);
    }
    if (!touched.length) { round--; continue; }
    const d = duel(deals, trial, best);
    const per = (d.edge / d.played).toFixed(1);
    const verdict = d.edge > 0 ? 'KEEP' : 'drop';
    console.log(`${String(round).padStart(3)}. ${verdict}  ${String(per).padStart(7)} per deal   ${touched.join(', ')}`);
    if (d.edge > 0) { best = trial; improved++; }
  }
  return { best, improved };
}

/* ---------- run ---------- */
const deals = makeDeals(DEALS, SEED);
const baseline = Object.assign({}, G.TUNE);

if (CHECK_ONLY) {
  /* The same settings on both sides. Anything other than a dead heat is the
     measurement's own noise, which is what you want to know before trusting
     any number this tool prints. */
  console.log(`sanity check: identical settings on both sides, ${deals.length} deals\n`);
  const d = duel(deals, baseline, Object.assign({}, baseline));
  console.log(`  side A ${d.a}`);
  console.log(`  side B ${d.b}`);
  console.log(`  edge   ${d.edge} over ${d.played} deals (${(d.edge / d.played).toFixed(2)} per deal)`);
  console.log(`\nthe closer that is to zero, the more a real difference can be trusted.`);
  process.exit(0);
}

const t0 = Date.now();
const { best, improved } = search(deals);
console.log(`\n${improved} of ${ROUNDS} trials were kept, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const changed = NAMES.filter(k => best[k] !== baseline[k]);
if (!changed.length) {
  console.log('\nnothing beat the settings already in server.js.');
  process.exit(0);
}
console.log('\nwhat changed:');
changed.forEach(k => console.log(`  ${k}: ${baseline[k]} -> ${best[k]}`));

/* Re-measure the winner on deals it has never seen, and on more than one set
   of them. A hill climb always looks good on the deals it was fitted to, and a
   single holdout is not much better: the first version of this check reported
   a confident +16.9 a deal for settings that turned out to lose on one fresh
   seed in three. Three sets, and it only counts if it wins all three. */
const holdouts = [SEED + 99991, SEED + 31337, SEED + 8675309];
console.log('\nre-checked on deals it was never tuned on:');
let wins = 0;
holdouts.forEach((hs, n) => {
  const check = duel(makeDeals(DEALS, hs), best, baseline);
  const per = check.edge / check.played;
  if (per > 0) wins++;
  console.log(`  set ${n + 1}: ${per > 0 ? '+' : ''}${per.toFixed(1)} points per deal`);
});
if (wins === holdouts.length) {
  console.log('\nwins on all three, so it is worth a look.');
  console.log('to adopt, paste into the TUNE block in server.js:');
  changed.forEach(k => console.log(`  ${k}: ${best[k]},`));
} else {
  console.log(`\nwins on only ${wins} of ${holdouts.length}: this is fitted to the search deals,`);
  console.log('not a real improvement. Nothing to adopt. Try more --deals, or a different --seed.');
}
console.log(`
Whatever it prints, read it before pasting it. The search plays against these
same bots, so it will happily find settings that beat them and lose to people:
an earlier run "improved" the game by bidding far higher and taking spades
almost every deal, which is precisely the behaviour a player had just reported
as wrong.`);
