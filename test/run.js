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
    R.team = new Set([0]); R.privateTeam = new Set([0]);
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

  /* Laying your own called card spends the call to gain a partner, and the
     price is the suit. Worth paying only when the suit stays yours afterwards:
     A-K goes down happily because the king still holds it, A-then-10 does not,
     because once the ace is gone the king and queen are both still out. A long
     enough holding wins the later rounds by weight of cards either way. */
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
  // no singletons in any of these, or the lead-your-singleton rule answers first
  const gap = ['A H','10 H','7 H','6 H','5 H','9 S','8 S','7 S','6 S','5 S','4 S','9 D','8 D','7 D']
    .map(t => { const [r, s] = t.split(' '); return C(r, s, id5++); });
  ok('an ace with a gap under it is kept back', bidderLeads(gap) !== 'AH',
    'led ' + bidderLeads(gap));

  const backed = ['A H','K H','10 H','7 H','6 H','9 S','8 S','7 S','6 S','5 S','4 S','9 D','8 D','7 D']
    .map(t => { const [r, s] = t.split(' '); return C(r, s, id5++); });
  eq('an ace with the king behind it goes down', bidderLeads(backed), 'AH');

  const twoAces = ['A H','A H','10 H','7 H','6 H','9 S','8 S','7 S','6 S','5 S','4 S','9 D','8 D','7 D']
    .map(t => { const [r, s] = t.split(' '); return C(r, s, id5++); });
  eq('holding both aces, laying one keeps control', bidderLeads(twoAces), 'AH');

  const sevenLong = ['A H','10 H','9 H','8 H','7 H','6 H','5 H','9 S','8 S','7 S','6 S','5 S','9 D','8 D']
    .map(t => { const [r, s] = t.split(' '); return C(r, s, id5++); });
  eq('a seven card suit carries itself whatever sits under the ace',
    bidderLeads(sevenLong), 'AH');

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
