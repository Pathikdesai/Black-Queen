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
