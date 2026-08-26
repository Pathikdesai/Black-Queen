'use strict';
/* Black Queen tests. `npm test`.

   Two halves. The first pokes the rules engine directly, with the server
   required but not listening. The second starts a real server and plays real
   games through a real socket, which is the only way to catch the things that
   have actually gone wrong here before: a table that quietly stops moving, a
   room that never gets collected, a clock that never runs out. */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = +(process.env.TEST_PORT || 4501);
const URL = 'ws://localhost:' + PORT;

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}
function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===================== part one: the rules engine ===================== */
process.env.BQ_NO_LISTEN = '1';
const G = require(path.join(ROOT, 'server.js'));

function unitTests() {
  console.log('\nrules');
  const deck = G.buildDeck();
  eq('the deck is 84 cards', deck.length, 84);
  eq('there are exactly 200 points in it', deck.reduce((a, c) => a + G.ptsOf(c), 0), G.TOTALPTS);
  eq('every card id is unique', new Set(deck.map(c => c.id)).size, 84);
  eq('there is one 4 of spades, not two', deck.filter(c => c.r === '4' && c.s === 'S').length, 1);
  eq('there are two aces of spades', deck.filter(c => c.r === 'A' && c.s === 'S').length, 2);
  eq('both black queens are worth 20', deck.filter(c => c.r === 'Q' && c.s === 'S').every(c => G.ptsOf(c) === 20), true);

  console.log('\nwho takes the trick');
  const c = (r, s) => ({ r, s, id: r + s });
  ok('trump beats a plain ace', G.beats(c('4', 'S'), c('A', 'H'), 'S', 'H'), '');
  ok('a higher trump beats a lower one', G.beats(c('K', 'S'), c('9', 'S'), 'S', 'H'), '');
  ok('a lower trump does not beat a higher one', !G.beats(c('9', 'S'), c('K', 'S'), 'S', 'H'), '');
  ok('off suit does not beat the led suit', !G.beats(c('A', 'D'), c('5', 'H'), 'S', 'H'), '');
  ok('the led suit beats another off suit', G.beats(c('5', 'H'), c('A', 'D'), 'S', 'H'), '');
  ok('an identical card does not beat the one played first', !G.beats(c('A', 'H'), c('A', 'H'), 'S', 'H'), '');

  console.log('\nfollowing suit');
  const hand = [c('4', 'H'), c('K', 'H'), c('A', 'S')];
  eq('you must follow when you can', G.legal(hand, 'H').length, 2);
  eq('anything goes when you are void', G.legal(hand, 'D').length, 3);
  eq('the leader may play anything', G.legal(hand, null).length, 3);

  console.log('\nshuffling');
  const a = G.buildDeck(), b = G.shuffle(G.buildDeck());
  eq('a shuffle keeps every card', b.length, 84);
  eq('a shuffle keeps every id', new Set(b.map(x => x.id)).size, 84);
  ok('a shuffle actually moves cards', a.some((x, i) => x.id !== b[i].id), '');

  /* A static check, not a real one. Proving the sound pack stays quiet while it
     primes needs a browser, and pulling in a headless browser to test it would
     cost this project more than the bug did. What can be checked cheaply is
     that the silencing has not gone back to `volume`, which iOS ignores
     outright, and which is what made the whole pack blurt out on the first tap. */
  console.log('\nthe sound pack stays quiet while it primes');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const prime = client.slice(client.indexOf('function primeClips()'), client.indexOf('document.addEventListener(\'pointerdown\''));
  ok('priming exists to be checked', prime.length > 40 && prime.length < 2000, prime.length + ' chars');
  ok('it silences with muted, which iOS honours', /\.muted\s*=\s*true/.test(prime), '');
  ok('and not with volume, which iOS ignores', !/\.volume\s*=\s*0/.test(prime), '');
  ok('it unmutes again afterwards', /\.muted\s*=\s*false/.test(prime), '');
  ok('and a clip wanted for real is spared the prime\'s pause', /_priming/.test(prime), '');

  /* The bots play to rules a person at the table gave us, not to anything that
     can be derived from the rulebook. They are worth pinning down, because a
     later tidy-up could quietly undo one and nothing else would notice. */
  console.log('\nthe bots keep to the table rules');
  const C = (r, s, id) => ({ r, s, id });
  function table(hands) {
    const R = G.createRoom(6);
    hands.forEach((h, i) => R.players.push({
      name: 'B' + i, token: 'tok' + i, bot: true, connected: true,
      ws: null, score: 0, hand: h, won: 0
    }));
    R.hostToken = 'tok0';
    R.n = 6; R.handSize = 14; R.totalDeals = 9; R.dealNo = 1; R.dealer = 5;
    R.trick = []; R.lead = null; R.leader = 0; R.trickNo = 1;
    R.team = new Set(); R.privateTeam = new Set();
    R.called = [null, null]; R.calledDone = [false, false];
    R.seen = {}; R.voids = hands.map(() => new Set());
    R.cuts = {}; R.partnerAt = [null, null]; R.bigTrick = null;
    return R;
  }
  function stop(R) { clearTimeout(R.timer); clearTimeout(R.slowTimer); G.rooms.delete(R.code); }

  // a bidder void in clubs must not call a club: that call can never come down
  let id = 0;
  const voidHand = [
    C('A','S',id++),C('K','S',id++),C('Q','S',id++),C('J','S',id++),C('10','S',id++),
    C('9','S',id++),C('8','S',id++),C('A','H',id++),C('K','H',id++),C('7','H',id++),
    C('A','D',id++),C('K','D',id++),C('6','D',id++),C('5','D',id++)
  ];
  const R1 = table([voidHand, [], [], [], [], []]);
  R1.phase = 'declare'; R1.bidder = 0; R1.bidAmount = 130;
  R1.team = new Set([0]); R1.privateTeam = new Set([0]);
  G.botDeclare(R1, 0);
  const calls = R1.called || [];
  ok('a bidder void in clubs never calls a club',
    calls.length === 2 && calls.every(c => c.s !== 'C'),
    'called ' + calls.map(c => c && c.r + c.s).join(' + '));
  ok('and calls two real cards anyway', calls.length === 2 && calls[0] && calls[1], '');
  stop(R1);

  /* The black queen carries 20 points to whoever wins the trick, so it may only
     go down when the trick is already decided. Same seat, same cards, two
     different situations. */
  const qHand = [C('Q','S',90), C('Q','S',91), C('8','S',92)];
  const R2 = table([[], [], [], qHand, [], []]);
  R2.phase = 'play'; R2.trump = 'S'; R2.bidder = 3; R2.bidAmount = 135;
  R2.team = new Set([3]); R2.privateTeam = new Set([3]);
  R2.calledDone = [true, true]; R2.called = [C('A','D',0), C('K','D',0)];
  R2.leader = 0; R2.lead = 'S';
  R2.trick = [{ p: 0, card: C('J','S',80) }, { p: 1, card: C('7','S',81) }, { p: 2, card: C('5','C',82) }];
  const risky = G.safeToRisk(R2, 3, C('Q','S',90), false);
  ok('the queen is refused with opponents still to play and a higher spade out', !risky, '');
  const spare = G.safeToRisk(R2, 3, C('8','S',92), false);
  ok('an ordinary spade in the same spot is fine', spare, '');
  ok('and the queen is allowed from the last seat, where nothing can beat it',
    G.safeToRisk(R2, 3, C('Q','S',90), true), '');
  stop(R2);

  /* Holding A♠ 10♠ and nothing else high, the ace is the only card in the hand
     that beats a black queen. Spend it on some small trick and when the queen
     finally comes down there is nothing left to take it. So it waits for the
     trick that is actually worth catching. */
  function follows(hand, trickCards, played) {
    const R = table([[], [], [], hand, [], []]);
    R.phase = 'play'; R.trump = 'S'; R.bidder = 0; R.bidAmount = 130;
    /* Seat 2 is on the bidding side, so the card in front of our player is an
       opponent's whichever of the three tricks below is being played. Without
       that this table would be one bidder against five partners, and letting a
       partner's ten ride is the right play for a reason that has nothing to do
       with catching queens. */
    R.team = new Set([0, 2]); R.privateTeam = new Set([0, 2]);
    R.called = [{ r: 'A', s: 'D' }, { r: 'K', s: 'D' }]; R.calledDone = [true, true];
    R.trickNo = 6; R.leader = 0; R.lead = trickCards[0].s;
    R.trick = trickCards.map((c, n) => ({ p: n, card: c }));
    trickCards.forEach(c => { R.seen[c.r + c.s] = (R.seen[c.r + c.s] || 0) + 1; });
    (played || []).forEach(k => { R.seen[k] = (R.seen[k] || 0) + 1; });
    G.botPlay(R, 3);
    const out = R.trick.length > trickCards.length ? R.trick[R.trick.length - 1].card : null;
    stop(R);
    return out ? out.r + out.s : 'nothing';
  }
  let id3 = 0;
  const catcherHand = () => [
    C('A','S',id3++),C('10','S',id3++),C('9','S',id3++),C('8','S',id3++),C('7','S',id3++)
  ];
  const small = follows(catcherHand(), [C('6','S',70),C('5','S',71),C('4','S',72)]);
  ok('the ace of spades is kept back from a trick with no queen in it',
    small !== 'AS', 'played ' + small);
  const onQueen = follows(catcherHand(), [C('Q','S',73),C('5','S',74),C('4','S',75)]);
  eq('and spent the moment a black queen is actually on the table', onQueen, 'AS');
  const bothGone = follows(catcherHand(), [C('6','S',76),C('5','S',77),C('10','S',78)], ['QS','QS']);
  eq('once both queens are gone it is an ordinary winner again', bothGone, 'AS');

  /* Two hands a player talked through, kept here as the reference for what
     declaring should do. Both call cards the bidder is holding, which is the
     point of them: the second copy is out there and whoever has it joins you.
     Holding a called card is fine — laying it yourself is the mistake, and
     that is a play rule, tested further down. */
  function declares(hand, bidder) {
    const R = table([hand, [], [], [], [], []]);
    R.phase = 'declare'; R.bidder = 0; R.bidAmount = 125;
    R.team = new Set([0]); R.privateTeam = new Set([0]);
    G.botDeclare(R, 0);
    const out = { trump: R.trump, calls: (R.called || []).map(c => c && c.r + c.s) };
    stop(R);
    return out;
  }
  let id2 = 0;
  // five diamonds, five hearts, four clubs, void in spades: the strongest suit
  // is the long one carrying the ace, and both calls belong in it
  const twoFives = [
    C('A','H',id2++),C('K','H',id2++),C('8','H',id2++),C('7','H',id2++),C('6','H',id2++),
    C('A','D',id2++),C('K','D',id2++),C('9','D',id2++),C('7','D',id2++),C('6','D',id2++),
    C('A','C',id2++),C('10','C',id2++),C('10','C',id2++),C('8','C',id2++)
  ];
  const d1 = declares(twoFives);
  ok('a void suit is still never trump and never called',
    d1.trump !== 'S' && d1.calls.every(c => c[c.length - 1] !== 'S'),
    'trump ' + d1.trump + ', called ' + d1.calls.join(' + '));
  ok('both calls are made in the trump suit, where partners are useful',
    d1.calls.every(c => c[c.length - 1] === d1.trump),
    'trump ' + d1.trump + ', called ' + d1.calls.join(' + '));

  /* Five spades with the ace and a black queen beats six hearts with the same
     top cards: the hearts are worth nothing and the spades are worth forty. */
  const spadesOverLength = [
    C('A','S',id2++),C('K','S',id2++),C('Q','S',id2++),C('6','S',id2++),C('5','S',id2++),
    C('A','H',id2++),C('K','H',id2++),C('Q','H',id2++),C('Q','H',id2++),C('J','H',id2++),C('5','H',id2++),
    C('A','C',id2++),C('K','C',id2++),C('J','C',id2++)
  ];
  const d2 = declares(spadesOverLength);
  eq('a shorter spade holding with the queen outranks a longer worthless suit', d2.trump, 'S');
  ok('and it calls the black queen and the ace of spades',
    d2.calls.includes('QS') && d2.calls.includes('AS'),
    'called ' + d2.calls.join(' + '));

  /* Three spades and a black queen is not a spade hand. Naming spades there
     lets the suit run away with your own twenty points in it. Reported from a
     real table as "always kaali hakam": the bots were taking spades three
     deals in four and calling the queen in every single contract. */
  const shortSpades = [
    C('Q','S',id2++),C('7','S',id2++),C('4','S',id2++),
    C('A','H',id2++),C('K','H',id2++),C('J','H',id2++),C('9','H',id2++),C('8','H',id2++),C('6','H',id2++),
    C('A','D',id2++),C('9','D',id2++),C('8','D',id2++),
    C('K','C',id2++),C('7','C',id2++)
  ];
  const d3 = declares(shortSpades);
  eq('a black queen in a three card spade holding does not make spades trump', d3.trump, 'H');
  ok('and the queen is not called from outside the trump suit either',
    !d3.calls.includes('QS'), 'called ' + d3.calls.join(' + '));

  /* A partner already holds the trick. Cutting it takes the points off your own
     side and spends a trump to do it. */
  const cutter = [C('8','D',400), C('7','C',401), C('9','S',402)];
  const R6 = table([[], [], [], cutter, [], []]);
  R6.phase = 'play'; R6.trump = 'S'; R6.bidder = 0; R6.bidAmount = 130;
  R6.team = new Set([0, 3]); R6.privateTeam = new Set([0, 3]);
  R6.called = [{ r: 'A', s: 'D' }, { r: 'K', s: 'D' }]; R6.calledDone = [true, true];
  R6.trickNo = 7; R6.leader = 0; R6.lead = 'H';
  // seat 0 is a partner and is winning the trick with the ace of hearts
  R6.trick = [{ p: 0, card: C('A','H',403) }, { p: 1, card: C('6','H',404) }, { p: 2, card: C('5','H',405) }];
  G.botPlay(R6, 3);
  const thrown = R6.trick.length > 3 ? R6.trick[3].card : null;
  ok('a trick a partner is winning is not cut with a trump',
    thrown && thrown.s !== 'S', 'played ' + (thrown ? thrown.r + thrown.s : 'nothing'));
  stop(R6);

  /* Holding a called card that has not come down makes you the bidder's partner
     and you can work that out yourself: the calls are announced and you can see
     your own hand. Without that the bot took the bidder for an opponent and beat
     his king with the very ace it was about to partner him with. */
  let id9 = 900;
  function partnerPlays(hand, trick, leader) {
    const R = table([[], [], [], hand, [], []]);
    R.phase = 'play'; R.trump = 'S'; R.bidder = 0; R.bidAmount = 130;
    R.team = new Set([0]); R.privateTeam = new Set([0]);
    R.called = [{ r: 'A', s: 'H' }, { r: 'K', s: 'D' }]; R.calledDone = [false, false];
    R.trickNo = 4; R.leader = leader; R.lead = trick[0].s;
    R.trick = trick.map((c, n) => ({ p: (leader + n) % 6, card: c }));
    trick.forEach(c => { R.seen[c.r + c.s] = (R.seen[c.r + c.s] || 0) + 1; });
    const mate = G.knownMate(R, 3, 0);
    G.botPlay(R, 3);
    const out = R.trick.length > trick.length ? R.trick[R.trick.length - 1].card : null;
    stop(R);
    return { mate, played: out ? out.r + out.s : 'nothing' };
  }
  const aceHand = () => [
    C('A','H',id9++),C('9','H',id9++),C('6','H',id9++),
    C('8','C',id9++),C('7','C',id9++),C('9','D',id9++)
  ];
  const onBidder = partnerPlays(aceHand(),
    [C('K','H',960), C('5','H',961), C('4','H',962)], 0);
  ok('holding the called ace, you know the bidder is your side', onBidder.mate, '');
  ok('and you do not beat his king with it', onBidder.played !== 'AH',
    'played ' + onBidder.played);

  const onOpponent = partnerPlays(aceHand(), [C('Q','H',963), C('10','H',964)], 1);
  eq('but an opponent holding the trick is worth the ace', onOpponent.played, 'AH');

  /* The bidder led the king and an opponent has already put the other ace on
     it. Identical cards tie in favour of whoever played first, so this ace
     cannot take the trick back — it can only be handed over with ten points
     attached. It stays in hand. (This test used to expect the ace, which was
     simply wrong about the tie rule.) */
  const cannotWin = partnerPlays(aceHand(),
    [C('K','H',965), C('5','H',966), C('A','H',967)], 0);
  ok('an ace that cannot beat the ace already down is not thrown after it',
    cannotWin.played !== 'AH', 'played ' + cannotWin.played);

  /* From a real hand. A defender holds the ace of the led suit and the five of
     it. The trick is empty of points so far, so the bot decided the trick was
     not worth taking — and then threw the five straight into it. Declining a
     trick and feeding it in the same breath is incoherent: the points you would
     have to throw in are on the table too, they have just not been played yet. */
  const decliner = [
    C('A','D',1200), C('5','D',1201),
    C('9','C',1202), C('8','C',1203), C('7','H',1204)
  ];
  const R13 = table([[], [], decliner, [], [], []]);
  R13.phase = 'play'; R13.trump = 'S'; R13.bidder = 0; R13.bidAmount = 140;
  R13.called = [{ r: 'A', s: 'S' }, { r: 'A', s: 'S' }];
  R13.calledDone = [true, true];              // both down, so the sides are public
  R13.team = new Set([0, 4]); R13.privateTeam = new Set([0, 4]);
  R13.trickNo = 8; R13.leader = 5; R13.lead = 'D';
  R13.trick = [
    { p: 5, card: C('J','D',1205) },          // an opponent of the bidding side leads
    { p: 0, card: C('8','D',1206) },          // the bidder follows
    { p: 1, card: C('J','D',1207) }
  ];
  R13.trick.forEach(t => { R13.seen[t.card.r + t.card.s] = (R13.seen[t.card.r + t.card.s] || 0) + 1; });
  G.botPlay(R13, 2);
  const chose = R13.trick.length > 3 ? R13.trick[3].card : null;
  ok('a trick with no points yet is still taken rather than fed five',
    chose && chose.r === 'A', 'played ' + (chose ? chose.r + chose.s : 'nothing'));
  stop(R13);

  /* Everyone the bidder is not playing with is playing against him, and so with
     each other. The bots only ever recognised the bidding side, so once both
     calls were answered the defenders still treated one another as strangers.
     Nothing hidden is used to work this out: who is on the bidding side is
     announced when a called card is laid, and both calls being answered is on
     the table for all to see. */
  function defenders(hand, trick, opts) {
    const seats = [[], [], [], [], [], []];
    seats[3] = hand;
    const R = table(seats);
    R.phase = 'play'; R.trump = 'S'; R.bidder = 0; R.bidAmount = 140;
    R.called = [{ r: 'A', s: 'C' }, { r: 'K', s: 'C' }];
    R.calledDone = (opts && opts.calledDone) || [true, true];
    R.team = new Set([0, 1]); R.privateTeam = new Set([0, 1]);
    R.trickNo = 9;
    R.leader = trick.length ? trick[0].p : 3;
    R.lead = trick.length ? trick[0].card.s : null;
    R.trick = trick.map(t => ({ p: t.p, card: t.card }));
    R.trick.forEach(t => { R.seen[t.card.r + t.card.s] = (R.seen[t.card.r + t.card.s] || 0) + 1; });
    G.botPlay(R, 3);
    const out = R.trick.length > trick.length ? R.trick[R.trick.length - 1].card : null;
    stop(R);
    return out ? out.r + out.s : 'nothing';
  }
  const R14 = table([[], [], [], [], [], []]);
  R14.bidder = 0; R14.called = [{ r: 'A', s: 'C' }, { r: 'K', s: 'C' }];
  R14.team = new Set([0, 1]); R14.privateTeam = new Set([0, 1]);
  R14.calledDone = [true, false];
  ok('while a call is out, one defender cannot claim another',
    !G.knownMate(R14, 3, 4), '');
  R14.calledDone = [true, true];
  ok('once both calls are answered, two defenders are a side',
    G.knownMate(R14, 3, 4), '');
  ok('and a defender is still not the bidding side',
    !G.knownMate(R14, 3, 0) && !G.knownMate(R14, 3, 1), '');
  stop(R14);

  /* Seat 5 is a fellow defender and has the trick sewn up: he leads the ace of
     the suit, and the two behind our player are the last of the defenders. The
     ten goes to him rather than being kept back. */
  const fed = defenders(
    [C('10','D',1300), C('4','D',1301), C('9','C',1302), C('8','H',1303)],
    [{ p: 5, card: C('A','D',1304) }, { p: 0, card: C('6','D',1305) },
     { p: 1, card: C('5','D',1306) }, { p: 2, card: C('7','D',1307) }]);
  eq('and a defender feeds his ten to a defender who has the trick won', fed, '10D');

  /* Same trick, but the sides are not settled yet: one call is still out, so
     any of the others could still turn up as the bidder's partner. Nothing may
     be assumed, and the ten stays in hand. */
  const guarded = defenders(
    [C('10','D',1310), C('4','D',1311), C('9','C',1312), C('8','H',1313)],
    [{ p: 5, card: C('A','D',1314) }, { p: 0, card: C('6','D',1315) },
     { p: 1, card: C('5','D',1316) }, { p: 2, card: C('7','D',1317) }],
    { calledDone: [true, false] });
  ok('but not while a call is still out and anyone could be the partner',
    guarded !== '10D', 'played ' + guarded);

  /* A defender is winning the trick and our player is void in the suit. Cutting
     it with a trump takes the points off his own side and burns a trump to do
     it, so the trump stays and something worthless goes. */
  const notCut = defenders(
    [C('6','S',1320), C('9','C',1321), C('8','H',1322)],
    [{ p: 5, card: C('A','D',1323) }, { p: 0, card: C('6','D',1324) },
     { p: 1, card: C('5','D',1325) }, { p: 2, card: C('7','D',1326) }]);
  ok('and does not cut a fellow defender who is taking the trick',
    notCut !== '6S', 'played ' + notCut);

  /* Holding the ace and the queen of a long suit. The queen takes the trick and
     costs nothing, so the ace is not spent on it — but the ace must not then sit
     in the hand either. It only wins while people can still follow, and a long
     suit in one hand is a short suit in everybody else's, so that is the suit
     that runs dry soonest. Cash it at the next lead. */
  let id15 = 1400;
  const longSuit = () => [
    C('A','D',id15++), C('Q','D',id15++), C('9','D',id15++),
    C('8','D',id15++), C('7','D',id15++), C('6','D',id15++),
    C('8','S',id15++), C('4','C',id15++)
  ];
  const cheapWin = defenders(longSuit(), [
    { p: 0, card: C('5','D', id15++) },      // the bidder leads low
    { p: 1, card: C('J','D', id15++) },      // his partner, winning it
    { p: 2, card: C('10','D', id15++) }      // a fellow defender
  ]);
  eq('a trick is won with the cheapest card that takes it, not the ace', cheapWin, 'QD');

  const cashIt = defenders(longSuit(), []);
  eq('and the ace is cashed at the next lead, before it can be cut', cashIt, 'AD');

  /* Unless somebody has already shown out of the suit: then it is too late and
     the ace is worth more in the hand than under a trump. */
  const tooLate = (() => {
    const seats = [[], [], [], [], [], []];
    seats[3] = longSuit();
    const R = table(seats);
    R.phase = 'play'; R.trump = 'S'; R.bidder = 0; R.bidAmount = 140;
    R.called = [{ r: 'A', s: 'C' }, { r: 'K', s: 'C' }]; R.calledDone = [true, true];
    R.team = new Set([0, 1]); R.privateTeam = new Set([0, 1]);
    R.trickNo = 9; R.leader = 3; R.lead = null; R.trick = [];
    R.voids[1].add('D');
    G.botPlay(R, 3);
    const out = R.trick.length ? R.trick[0].card : null;
    stop(R);
    return out ? out.r + out.s : 'nothing';
  })();
  ok('but not into a suit an opponent has already shown out of',
    tooLate !== 'AD', 'played ' + tooLate);

  /* From a real hand, and an expensive one. Bidder, spades trump, called A♠ and
     Q♠. The bidder leads 10♠, an opponent covers with the king, and the player
     holding the called black queen drops her straight under it to come in.
     Twenty points handed over, plus the ten already in the trick. The reveal
     was ignoring the queen rule entirely: it only asked whether coming in was
     worth it, never what the card cost on the way. */
  const queenHolder = [C('Q','S',1100), C('6','S',1101), C('4','S',1102)];
  const R11 = table([[], [], [], [], queenHolder, []]);
  R11.phase = 'play'; R11.trump = 'S'; R11.bidder = 0; R11.bidAmount = 130;
  R11.called = [{ r: 'A', s: 'S' }, { r: 'Q', s: 'S' }];
  R11.calledDone = [false, false];
  R11.team = new Set([0]); R11.privateTeam = new Set([0]);
  R11.trickNo = 1; R11.leader = 0; R11.lead = 'S';
  R11.trick = [
    { p: 0, card: C('10','S',1103) },     // the bidder leads
    { p: 1, card: C('5','S',1104) },
    { p: 2, card: C('J','S',1105) },
    { p: 3, card: C('K','S',1106) }       // an opponent takes charge
  ];
  R11.trick.forEach(t => { R11.seen[t.card.r + t.card.s] = 1; });
  G.botPlay(R11, 4);
  const dropped = R11.trick.length > 4 ? R11.trick[4].card : null;
  ok('the black queen is not dropped under a king just to come in as a partner',
    dropped && !(dropped.r === 'Q' && dropped.s === 'S'),
    'played ' + (dropped ? dropped.r + dropped.s : 'nothing'));
  stop(R11);

  /* A called card that wins the trick still goes down, and one worth nothing
     may go down freely. It is only the losing, point-carrying card that waits. */
  const winsIt = [C('A','D',1110), C('8','C',1111), C('7','C',1112)];
  const R12 = table([[], [], [], [], [], winsIt]);
  R12.phase = 'play'; R12.trump = 'S'; R12.bidder = 0; R12.bidAmount = 130;
  R12.called = [{ r: 'A', s: 'D' }, { r: 'K', s: 'H' }];
  R12.calledDone = [false, false];
  R12.team = new Set([0]); R12.privateTeam = new Set([0]);
  R12.trickNo = 4; R12.leader = 1; R12.lead = 'D';
  R12.trick = [
    { p: 1, card: C('Q','D',1113) }, { p: 2, card: C('9','D',1114) },
    { p: 3, card: C('10','D',1115) }, { p: 4, card: C('6','D',1116) }
  ];
  G.botPlay(R12, 5);
  const taken = R12.trick.length > 4 ? R12.trick[4].card : null;
  eq('but a called card that takes the trick is still laid',
    taken ? taken.r + taken.s : 'nothing', 'AD');
  stop(R12);

  /* From a real hand. Bidder, spades trump, called K♠ and A♥. One partner lays
     the called ace and is winning the trick. The other holds the called king of
     trumps, is void in hearts, and has plenty else to throw — and cut his own
     partner's winning trick with it to come in. Two called cards spent on one
     trick that was already won, and the king of trumps gone with them. */
  const secondPartner = [
    C('K','S',1000),C('8','D',1001),C('7','D',1002),C('9','C',1003),C('8','C',1004)
  ];
  const R10 = table([[], [], [], [], secondPartner, []]);
  R10.phase = 'play'; R10.trump = 'S'; R10.bidder = 0; R10.bidAmount = 140;
  R10.called = [{ r: 'K', s: 'S' }, { r: 'A', s: 'H' }];
  R10.calledDone = [false, true];          // the ace is down, the king is not
  R10.team = new Set([0, 2]);              // seat 2 came in on the ace
  R10.privateTeam = new Set([0, 2]);
  R10.partnerAt = [null, 2];
  R10.trickNo = 5; R10.leader = 1; R10.lead = 'H';
  R10.seen = { AH: 1 };
  R10.trick = [
    { p: 1, card: C('9','H',1005) },       // an opponent leads
    { p: 2, card: C('A','H',1006) },       // the first partner takes it with the called ace
    { p: 3, card: C('6','H',1007) }
  ];
  ok('the second partner knows the first one is on his side',
    G.knownMate(R10, 4, 2), '');
  G.botPlay(R10, 4);
  const cutWith = R10.trick.length > 3 ? R10.trick[3].card : null;
  ok('and does not cut that trick with the called king of trumps',
    cutWith && cutWith.s !== 'S',
    'played ' + (cutWith ? cutWith.r + cutWith.s : 'nothing'));
  stop(R10);

  /* A partner has already cut the trick, so the points are coming to your side
     whatever you do. Throwing a trump on top of that is gone for nothing, even
     when the trump carries points itself — that card could have cut a whole
     trick later. Reported from a real table: "partner ne kaata hai toh bhi
     hakam daalke waste karenge". */
  const wastrel = [C('5','S',600), C('8','D',601), C('7','C',602)];
  const R8 = table([[], [], [], [], [], wastrel]);
  R8.phase = 'play'; R8.trump = 'S'; R8.bidder = 1; R8.bidAmount = 130;
  R8.team = new Set([1, 5]); R8.privateTeam = new Set([1, 5]);
  R8.called = [{ r: 'A', s: 'D' }, { r: 'K', s: 'D' }]; R8.calledDone = [true, true];
  R8.trickNo = 9; R8.leader = 0; R8.lead = 'H';
  R8.trick = [
    { p: 0, card: C('A','H',603) },   // an opponent leads the ace
    { p: 1, card: C('6','S',604) },   // the partner cuts it and now holds the trick
    { p: 2, card: C('9','H',605) }, { p: 3, card: C('8','H',606) }, { p: 4, card: C('7','H',607) }
  ];
  G.botPlay(R8, 5);
  const gave = R8.trick.length > 5 ? R8.trick[5].card : null;
  ok('no trump is thrown onto a trick a partner has already cut',
    gave && gave.s !== 'S', 'played ' + (gave ? gave.r + gave.s : 'nothing'));
  stop(R8);

  /* Coming in as a partner is right in general, but not from the last seat on
     an empty trick: it wins nothing and tells the whole table who you are. */
  const revealer = [C('A','D',500), C('9','C',501), C('8','C',502)];
  const R7 = table([[], [], [], [], [], revealer]);
  R7.phase = 'play'; R7.trump = 'S'; R7.bidder = 0; R7.bidAmount = 130;
  R7.team = new Set([0]); R7.privateTeam = new Set([0]);
  R7.called = [{ r: 'A', s: 'D' }, { r: 'K', s: 'H' }]; R7.calledDone = [false, false];
  R7.trickNo = 4; R7.leader = 0; R7.lead = 'C';
  R7.trick = [
    { p: 0, card: C('J','C',503) }, { p: 1, card: C('7','C',504) }, { p: 2, card: C('6','C',505) },
    { p: 3, card: C('4','C',506) }, { p: 4, card: C('J','C',507) }
  ];
  G.botPlay(R7, 5);
  const held7 = R7.trick.length > 5 ? R7.trick[5].card : null;
  ok('a called card is not spent from the last seat on a pointless trick',
    held7 && !(held7.r === 'A' && held7.s === 'D'),
    'played ' + (held7 ? held7.r + held7.s : 'nothing'));
  stop(R7);

  /* The bidder's own copy of a called card never goes down. There is no
     version of laying it that is worth the ace: even with the king behind it,
     leading the king does the same job better — whoever holds the other copy
     has to spend it to win the trick, so the partnership comes out anyway,
     while the ace stays in hand for the big card that turns up later. And the
     opposition is a round of the suit lighter for it. */
  let id5 = 700;
  function bidderLeads(hand) {
    const R = table([hand, [], [], [], [], []]);
    R.phase = 'play'; R.trump = 'S'; R.bidder = 0; R.bidAmount = 130;
    R.team = new Set([0]); R.privateTeam = new Set([0]);
    R.called = [{ r: 'A', s: 'H' }, { r: 'K', s: 'D' }]; R.calledDone = [false, false];
    R.trickNo = 3; R.leader = 0; R.lead = null; R.trick = [];
    G.botPlay(R, 0);
    const led = R.trick.length ? R.trick[0].card : null;
    stop(R);
    return led ? led.r + led.s : 'nothing';
  }
  const H = (...ranks) => ranks.map(r => C(r, 'H', id5++));
  const filler = () => [
    C('9','S',id5++),C('8','S',id5++),C('7','S',id5++),C('6','S',id5++),C('5','S',id5++),
    C('9','D',id5++),C('8','D',id5++),C('7','D',id5++)
  ];
  // no singletons in any of these, or the lead-your-singleton rule answers first
  const gap = [...H('A','10','7','6','5'), ...filler().slice(0, 9)];
  ok('an ace with a gap under it is kept back', bidderLeads(gap) !== 'AH',
    'led ' + bidderLeads(gap));

  const backed = [...H('A','K','10','7','6'), ...filler().slice(0, 9)];
  eq('an ace with the king behind it leads the king, not the ace',
    bidderLeads(backed), 'KH');

  const twoAces = [...H('A','A','10','7','6'), ...filler().slice(0, 9)];
  ok('holding both aces is still no reason to spend one',
    bidderLeads(twoAces) !== 'AH', 'led ' + bidderLeads(twoAces));

  /* Length looks like a reason to spend the ace and is the opposite. A long
     suit already has small cards for the routine work; what it does not have is
     anything else that beats a big card later. Cut with the low ones. */
  const sevenLong = [...H('A','10','9','8','7','6','5'), ...filler().slice(0, 7)];
  ok('seven cards is a reason to keep the ace, not to spend it',
    bidderLeads(sevenLong) !== 'AH', 'led ' + bidderLeads(sevenLong));

  // length beats raw points: two hands with the same points, different shapes
  const flat = [
    C('A','S',1),C('5','S',2),C('10','H',3),C('A','H',4),C('5','D',5),C('10','D',6),
    C('A','C',7),C('5','C',8),C('6','S',9),C('7','H',10),C('8','D',11),C('9','C',12),
    C('4','S',13),C('6','H',14)
  ];
  const long = [
    C('A','S',1),C('5','S',2),C('10','S',3),C('A','S',4),C('5','S',5),C('10','S',6),
    C('A','C',7),C('5','C',8),C('K','S',9),C('J','S',10),C('9','S',11),C('8','S',12),
    C('7','S',13),C('6','S',14)
  ];
  const R3 = table([flat, long, [], [], [], []]);
  const flatPts = flat.reduce((a, c) => a + G.ptsOf(c), 0);
  const longPts = long.reduce((a, c) => a + G.ptsOf(c), 0);
  let flatWins = 0;
  for (let k = 0; k < 40; k++) if (G.botCeiling(R3, 1) > G.botCeiling(R3, 0)) flatWins++;
  ok('a long suit is bid higher than the same points spread across four',
    flatWins >= 34, 'the long hand bid higher in ' + flatWins + ' of 40 deals'
      + ' (flat holds ' + flatPts + ' pts, long holds ' + longPts + ')');
  stop(R3);

  /* The bots are not allowed to look at anybody else's cards. Reading the code
     is weaker evidence than watching it, so every hand is wrapped and every
     read recorded, with the seat that is currently deciding noted alongside.
     Any read of another seat's cards from inside the brain is a peek.

     What the brain may use: its own hand, the cards already played, who has
     failed to follow which suit, the announced calls, and the revealed team.
     All of it visible to a person in that seat. */
  console.log('\nthe bots do not look at anyone else\'s cards');
  const BRAIN = new Set(['botCeiling','suitStrength','botDeclare','botPlay','botBid',
    'knownMate','holdsOpenCall','stillOut','topOut','opponentVoid','trumpsOut','trumpsIn',
    'queenCatcher','trickHasQueen','suitOut','revealNow','ownCallToHold','safeToRisk']);
  let deciding = null;
  const peeks = [], secretPeeks = [];
  function watched(R, seat) {
    return new Proxy(R.players[seat].hand, {
      get(t, prop) {
        if (deciding !== null && deciding !== seat && typeof prop !== 'symbol') {
          const stack = (new Error().stack || '').split('\n').slice(1, 12);
          for (const line of stack) {
            const m = /at (?:Object\.)?(\w+)/.exec(line);
            if (m && BRAIN.has(m[1])) { peeks.push(m[1] + ' read seat ' + seat); break; }
            if (m && !BRAIN.has(m[1])) break;   // referee frame, allowed
          }
        }
        return Reflect.get(t, prop);
      }
    });
  }
  let decisions = 0;
  for (let d = 0; d < 8; d++) {
    const deck = G.shuffle(G.buildDeck());
    const R = G.createRoom(6);
    for (let i = 0; i < 6; i++) R.players.push({
      name: 'S' + i, token: 'z' + i, bot: true, connected: true, ws: null,
      score: 0, hand: deck.slice(i * 14, (i + 1) * 14), won: 0
    });
    R.hostToken = 'z0';
    R.n = 6; R.handSize = 14; R.totalDeals = 9; R.dealNo = 1; R.dealer = d % 6;
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
    for (let i = 0; i < 6; i++) R.players[i].hand = watched(R, i);
    // and the one genuinely hidden thing the server keeps: who is secretly on side
    const realPrivate = R.privateTeam;
    R.privateTeam = {
      has(x) { if (deciding !== null && x !== deciding) secretPeeks.push(x); return realPrivate.has(x); },
      add: x => realPrivate.add(x), delete: x => realPrivate.delete(x),
      forEach: f => realPrivate.forEach(f),
      get size() { return realPrivate.size; },
      [Symbol.iterator]() { return realPrivate[Symbol.iterator](); }
    };
    let guard = 0;
    while (R.phase !== 'dealover' && R.phase !== 'gameover' && guard++ < 4000) {
      let seat = null;
      if (R.phase === 'bid') seat = R.bidState.turn;
      else if (R.phase === 'declare') seat = R.bidder;
      else if (R.phase === 'play') seat = (R.leader + R.trick.length) % 6;
      if (seat !== null) {
        deciding = seat; decisions++;
        try {
          if (R.phase === 'bid') G.botBid(R, seat);
          else if (R.phase === 'declare') G.botDeclare(R, seat);
          else G.botPlay(R, seat);
        } finally { deciding = null; }
      } else if (R.phase === 'resolve') { clearTimeout(R.timer); G.resolveTrick(R); }
      else break;
    }
    stop(R);
  }
  ok('enough decisions to be worth checking', decisions > 400, decisions + ' decisions');
  ok('no bot decision ever reads another player\'s cards', peeks.length === 0,
    peeks.length ? peeks.slice(0, 3).join('; ') : '');
  ok('nor the hidden record of who is secretly on the bidding side',
    secretPeeks.length === 0, secretPeeks.length + ' reads');

  console.log('\nsaving a table for the next boot');
  const R = G.createRoom(6);
  for (let i = 0; i < 6; i++) {
    R.players.push({ name: 'P' + i, token: 'tok' + i, bot: i > 0, connected: true, ws: null, score: i * 10, hand: [], won: 0 });
  }
  R.hostToken = 'tok0';
  G.startGame(R);
  const code = R.code, phase = R.phase, hand0 = R.players[0].hand.map(x => x.id).join(',');
  const dumped = G.dumpRooms();
  ok('an in-progress table is written out', dumped.some(x => x.code === code), '');
  const json = JSON.stringify(dumped);
  ok('what gets written is really JSON', json.length > 100, '');
  // hand it back exactly as a restart would
  const tmp = path.join(os.tmpdir(), 'bq-test-' + Date.now() + '.json');
  fs.writeFileSync(tmp, json);
  const before = process.env.STATE_FILE;
  G.rooms.delete(code);
  eq('the table is gone before the restore', G.rooms.has(code), false);
  // loadRooms reads the module level STATE_FILE, so drive it through the file it knows
  const target = process.env.STATE_FILE || path.join(ROOT, '.rooms.json');
  fs.copyFileSync(tmp, target);
  const n = G.loadRooms();
  fs.unlinkSync(tmp);
  if (before === undefined) delete process.env.STATE_FILE;
  ok('the table comes back', n >= 1 && G.rooms.has(code), 'restored ' + n);
  const back = G.rooms.get(code);
  if (back) {
    eq('it comes back mid-game, not in the lobby', back.phase, phase);
    eq('the hands are the same cards', back.players[0].hand.map(x => x.id).join(','), hand0);
    eq('the scores survive', back.players[0].score, 0);
    ok('the sets are sets again, not arrays', back.team instanceof Set && back.bidState.passed instanceof Set, '');
    ok('everybody is marked away until they reconnect', back.players.every(p => !p.connected), '');
  }
  ok('the state file is consumed, not left to reload forever', !fs.existsSync(target), '');
  G.rooms.forEach((_, k) => G.rooms.delete(k));
}

/* ===================== part two: a real server ===================== */
function client() {
  const ws = new WebSocket(URL);
  const c = { ws, V: null, seat: null, code: null, token: null, errs: [], states: 0, onState: null };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'seated') { c.seat = m.seat; c.code = m.code; c.token = m.token; }
    else if (m.t === 'state') { c.V = m.v; c.states++; if (c.onState) c.onState(m.v); }
    else if (m.t === 'err') c.errs.push(m.msg);
  });
  c.send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.open = () => new Promise(r => ws.readyState === 1 ? r() : ws.on('open', r));
  c.close = () => new Promise(r => { ws.on('close', r); ws.close(); setTimeout(r, 300); });
  return c;
}
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
  throw new Error('timed out waiting for ' + what);
}

// a seat that plays legally but with no thought at all
function autopilot(c, opts) {
  opts = opts || {};
  c.onState = V => {
    if (V.phase === 'bid' && V.bid && V.bid.turn === V.you) c.send(V.bid.opened ? { t: 'pass' } : { t: 'bid', amount: 100 });
    else if (V.phase === 'declare' && V.bidder === V.you) c.send({ t: 'declare', trump: 'S', calls: [{ r: 'A', s: 'H' }, { r: 'A', s: 'D' }] });
    else if (V.phase === 'play' && V.turn === V.you && V.legalIds && V.legalIds.length && !opts.stall) c.send({ t: 'play', cardId: V.legalIds[0] });
  };
}

async function fullGame() {
  console.log('\na whole game, end to end');
  const c = client();
  await c.open();
  autopilot(c);
  c.send({ t: 'create', name: 'Alice', size: 6 });
  await until(() => c.code, 3000, 'a table');
  c.send({ t: 'start' });
  await until(() => c.V && c.V.phase === 'gameover', 45000, 'the game to finish');
  const V = c.V;
  eq('nine rounds were played', V.history.length, 9);
  const bad = V.history.filter(h => !h.early && h.tp + h.op !== 200);
  eq('every completed round accounts for all 200 points', bad.length, 0);
  ok('the early finishes really were early', V.history.every(h => !h.early || h.tp + h.op < 200), '');
  // every player's total must be the sum of what they were awarded round by round
  let consistent = true;
  V.seats.forEach((s, i) => {
    let run = 0;
    V.history.forEach(h => { if (h.winners.includes(i)) run += h.award; });
    if (run !== s.score) consistent = false;
  });
  ok('every score is the sum of that player\'s winning rounds', consistent, '');
  ok('somebody actually scored', V.seats.some(s => s.score > 0), '');
  eq('the scorecard ends where the seats do', V.history[8].scores.join(','), V.seats.map(s => s.score).join(','));
  await c.close();
}

async function turnClock() {
  console.log('\nthe turn clock');
  const c = client();
  await c.open();
  autopilot(c, { stall: true });   // connected, and refusing to move
  c.send({ t: 'create', name: 'Statue', size: 6 });
  await until(() => c.code, 3000, 'a table');
  c.send({ t: 'start' });
  // bid and declare still get answered, so the game reaches the play phase
  c.onState = V => {
    if (V.phase === 'bid' && V.bid && V.bid.turn === V.you) c.send(V.bid.opened ? { t: 'pass' } : { t: 'bid', amount: 100 });
    else if (V.phase === 'declare' && V.bidder === V.you) c.send({ t: 'declare', trump: 'S', calls: [{ r: 'A', s: 'H' }, { r: 'A', s: 'D' }] });
  };
  await until(() => c.V && c.V.phase === 'play', 8000, 'the cards to come out');
  await until(() => c.V.turn === c.V.you, 15000, 'my turn');
  const held = c.V.hand.length;
  /* Not just "a number": the deadline used to be computed after the state had
     already gone out, so every client was told its turn had already expired. */
  ok('the clock is ticking and the app can see it', typeof c.V.turnMs === 'number' && c.V.turnSeat === c.V.you,
    'turnMs=' + c.V.turnMs);
  ok('the time it reports is time you actually still have', c.V.turnMs > 200 && c.V.turnMs <= 1200,
    'turnMs=' + c.V.turnMs + ', the whole turn is 1200');
  // never plays a card, and the table must move on regardless
  await until(() => c.V.hand.length < held, 8000, 'the table to play for me');
  ok('a card gets played for a player who has stopped responding', c.V.hand.length < held, '');
  ok('and the table says so out loud', (c.V.log || []).some(l => /ran out of time/.test(l)), '');
  await c.close();
}

async function chatIds() {
  console.log('\nchat past the forty message window');
  const a = client(), b = client();
  await a.open(); await b.open();
  a.send({ t: 'create', name: 'Talker', size: 6 });
  await until(() => a.code, 3000, 'a table');
  b.send({ t: 'join', name: 'Listener', code: a.code });
  await until(() => b.seat !== null, 3000, 'the second player');
  for (let i = 1; i <= 45; i++) { a.send({ t: 'chat', text: 'msg ' + i }); await sleep(30); }
  await until(() => b.V && (b.V.chat || []).length >= 40, 5000, 'the messages');
  const chat = b.V.chat;
  eq('the window still holds forty', chat.length, 40);
  ok('every message carries an id', chat.every(m => typeof m.id === 'number'), '');
  ok('the ids only ever go up', chat.every((m, i) => i === 0 || m.id > chat[i - 1].id), '');
  ok('the newest id is past the window, which is what the unread count needs',
    chat[chat.length - 1].id > 40, 'newest id ' + chat[chat.length - 1].id);
  await a.close(); await b.close();
}

async function roomHygiene() {
  console.log('\ntables clean up after themselves');
  const c = client();
  await c.open();
  for (let i = 0; i < 5; i++) c.send({ t: 'create', name: 'Spammer', size: 6 });
  await sleep(600);
  eq('one socket gets one table, however many times it asks', c.states > 0 && c.code ? 1 : 0, 1);

  // a table whose only human walks away should not survive
  const d = client();
  await d.open();
  d.send({ t: 'create', name: 'Passing', size: 6 });
  await until(() => d.code, 3000, 'a table');
  const gone = d.code;
  d.send({ t: 'leave' });
  await sleep(300);
  const e = client();
  await e.open();
  e.send({ t: 'join', name: 'Latecomer', code: gone });
  await until(() => e.errs.length > 0, 3000, 'a refusal');
  ok('an abandoned lobby is gone straight away, not held for the grace period',
    /No table with that code/.test(e.errs[0]), e.errs[0]);
  await c.close(); await d.close(); await e.close();
}

async function pingPong() {
  console.log('\nchallenging a socket that may be dead');
  const c = client();
  await c.open();
  let pongs = 0;
  c.ws.on('message', raw => { if (JSON.parse(raw).t === 'pong') pongs++; });
  /* A phone coming back from another app pings to find out whether its socket
     is still real. It has to be answered whether or not that phone is seated,
     and it must not disturb the table. */
  c.send({ t: 'ping' });
  await until(() => pongs > 0, 3000, 'a pong before being seated');
  ok('a ping is answered before you even have a seat', pongs > 0, '');
  c.send({ t: 'create', name: 'Pinger', size: 6 });
  await until(() => c.code, 3000, 'a table');
  const seenBefore = c.states, was = pongs;
  c.send({ t: 'ping' });
  await until(() => pongs > was, 3000, 'a pong at the table');
  ok('and answered once you are at one', pongs > was, '');
  await sleep(200);
  eq('a ping does not stir up the table', c.states, seenBefore);
  await c.close();
}

async function reconnect() {
  console.log('\nlosing a phone mid-game');
  const c = client();
  await c.open();
  autopilot(c);
  c.send({ t: 'create', name: 'Dropper', size: 6 });
  await until(() => c.code, 3000, 'a table');
  const code = c.code, token = c.token;
  c.send({ t: 'start' });
  await until(() => c.V && c.V.phase === 'play', 8000, 'the cards to come out');
  const score = c.V.seats[c.V.you].score;
  await c.close();
  await sleep(200);
  const back = client();
  await back.open();
  autopilot(back);
  back.send({ t: 'join', code, token });
  await until(() => back.V, 4000, 'the seat back');
  eq('you come back to the same seat', back.seat, 0);
  ok('with your own cards', Array.isArray(back.V.hand), '');
  eq('and your own score', back.V.seats[back.V.you].score, score);
  await back.close();
}

async function lastTrickAndHost() {
  console.log('\nthe table remembers');
  const c = client();
  await c.open();
  autopilot(c);
  c.send({ t: 'create', name: 'Watcher', size: 6 });
  await until(() => c.code, 3000, 'a table');
  eq('the host is whoever holds the host token', c.V.hostSeat, 0);
  c.send({ t: 'start' });
  await until(() => c.V && c.V.lastTrick && c.V.lastTrick.cards, 15000, 'a completed trick');
  const t = c.V.lastTrick;
  eq('a finished trick keeps one card per seat', t.cards.length, 6);
  ok('and knows who took it', typeof t.winner === 'number' && t.cards.some(x => x.p === t.winner), '');
  ok('and what it was worth', typeof t.pts === 'number', '');
  ok('and which suit was led', !!t.lead, '');
  await until(() => c.V.history.length >= 1, 30000, 'a scored round');
  const h = c.V.history[0];
  ok('the scorecard records the contract', typeof h.bidder === 'number' && h.amount >= 100, '');
  eq('and a running total for every seat', h.scores.length, 6);
  await c.close();
}

/* ===================== driver ===================== */
(async () => {
  unitTests();

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      BQ_NO_LISTEN: '', PORT: String(PORT),
      BOT_MS: '5', TRICK_MS: '15', NEXT_MS: '15',
      TURN_MS: '1200', AWAY_MS: '600', SLOW_MS: '400', CHAT_MS: '1',
      STATE_FILE: path.join(os.tmpdir(), 'bq-test-state-' + process.pid + '.json')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.error('server: ' + d));
  const stop = () => { try { srv.kill('SIGKILL'); } catch (e) { } };
  process.on('exit', stop);

  try {
    await until(() => true, 1, 'nothing');
    await sleep(700);
    await fullGame();
    await turnClock();
    await chatIds();
    await roomHygiene();
    await pingPong();
    await reconnect();
    await lastTrickAndHost();
  } catch (e) {
    failed++;
    fails.push('threw: ' + e.message);
    console.log('  ✗ ' + e.message);
  }
  stop();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (fails.length) { console.log('\nfailures:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(failed ? 1 : 0);
})();
