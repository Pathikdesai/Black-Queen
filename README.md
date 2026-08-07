# Black Queen, online

A table for 6 or 7 players. One person creates a table, shares a four letter code, everyone else joins from the same link. Empty seats can be filled by bots so you can start short-handed.

The cards live on the server. Each phone only ever receives its own hand, so nobody can peek by opening the browser inspector.

---

## What is in here

| File | What it does |
|---|---|
| `server.js` | The referee. Deck, bidding, trick logic, scoring, bots, WebSocket rooms. |
| `public/index.html` | Everything players see. One file, no build step. |
| `public/manifest.webmanifest`, `public/icons/` | Lets phones add the game to the home screen. |
| `test/run.js` | The test suite. `npm test`. |
| `tools/make-icons.js` | Redraws the icons. Only needed if you change the artwork. |
| `package.json` | Tells the host how to run it. |

---

## Putting it online

You need two free accounts: **GitHub** and **Render**. No credit card, about 15 minutes once.

### Step 1. Put the code on GitHub

1. Go to `github.com` and sign up or sign in.
2. Click the **+** at the top right, then **New repository**.
3. Name it `black-queen`. Leave it Public. Click **Create repository**.
4. On the next screen click **uploading an existing file**.
5. Drag in `server.js`, `package.json`, `README.md` and the whole `public` folder. Do not upload `node_modules` if you have it.
6. Click **Commit changes**.

### Step 2. Deploy on Render

1. Go to `render.com` and sign up with your GitHub account.
2. Click **New**, then **Web Service**.
3. Choose **Build and deploy from a Git repository**, then pick `black-queen`.
4. Fill in:
   - **Region**: Singapore, the closest one to India
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click **Create Web Service** and wait about two minutes.

Render gives you a URL like `https://black-queen-xxxx.onrender.com`. That link is the game. Send it to your group.

### Step 3. Play

One person opens the link, enters a name, taps **Start a new table**, and reads out the four letter code. Everyone else opens the same link, enters the code, taps **Join table**. The host picks 6 or 7 seats and deals.

---

## Fixing bugs later

You do **not** rebuild anything or ask anyone to reinstall.

1. Open the changed file in your GitHub repo.
2. Click the pencil icon, paste the new version, click **Commit changes**.
3. Render notices within seconds and redeploys. Takes about a minute.
4. Players pull down to refresh the page. They are now on the new version.

Everyone always loads the same page, so there is no such thing as one person being on an old version.

**Before you push, run the tests.** `npm test` plays whole games against the real server and checks the things that are hard to spot by eye: that all 200 points are still accounted for, that a table cannot silently stop moving, that a seat comes back with the right cards after a phone drops. It takes about half a minute.

**One caveat.** A redeploy on Render hands you a fresh machine, which ends any game in progress. Deploy between games, not mid-round. A plain restart or a crash is now survivable, see below.

---

## Table talk and sound

Tap the speech bubble in the top bar to open chat. There are tap-to-send phrases for mid-hand use plus a normal text box. Incoming messages appear briefly as a tap-through notice even when chat is closed, with an unread count on the bubble.

Sound is synthesised in the browser, so there are no audio files to host and nothing to download. The speaker icon mutes it, and the choice is remembered on that phone. Cues fire for: your turn, a card landing, a trump cut, a queen of spades appearing, winning a trick, a trick worth 20 or more, a partner revealing themselves, a contract being taken, and the contract being made or broken.

Phones need one tap anywhere before audio can start. That is a browser rule, not a bug, and the first tap on the name screen handles it.

## At the table

**Nobody can stall the game.** Each turn has a clock. It stays hidden until the last twenty seconds, then counts down on that player's seat and turns red near the end. If it runs out, a card is played for them and the log says so. A phone that has locked or lost signal is given less time than someone who is present but has put the phone down.

**The scorecard.** Under the `...` menu, and on every round summary. One row per round showing who bid what, whether they made it, and what each player took, with running totals underneath. It scrolls sideways at seven-handed.

**The last trick.** The cards leave the cloth after a couple of seconds, which is not long enough if you looked away. `...` then **Last trick**, or the link under the table between tricks, brings back all six or seven cards with the winner marked.

**Confirm each card.** Off by default. Turn it on under `...` and a tap only lifts a card clear of your hand; a second tap on the same card plays it. Worth it if you have ever thrown a queen away with your thumb.

**Add it to your home screen.** Both phones offer this from the browser's share or menu button. It then opens full screen with its own icon, with no address bar taking up room.

## Things worth knowing

**The bots count cards.** They track which cards have been played and who has failed to follow which suit, and use it to cash winners that can no longer be beaten, to avoid leading into a suit somebody is waiting to trump, and to throw away from their shortest suit. They only ever use what is visible at the table, so they are counting, not peeking. They make their contract about seven times in ten.

**A restart no longer ends the game.** Tables in progress are written to disk when the server goes down and read back when it comes up. Everyone's phone reconnects on its own and lands in the same seat with the same cards. This covers a crash, a manual restart and the server running out of memory. It does not cover a Render redeploy, because that replaces the whole machine and the file goes with it.

**The free plan sleeps.** After 15 minutes with nobody connected, Render puts the service to sleep. The next person to open the link waits about a minute for it to wake. Once a game is running, traffic keeps it awake. If that wait irritates people, Render's Starter plan removes it for roughly 600 rupees a month.

**Dropped connections are handled.** If a phone locks or loses signal, that seat is held. Reopen the link and you are back in the same seat with the same cards and scores. While you are away the table does not freeze: after 30 seconds a bot plays your turns so the round keeps moving.

**Switching to another app and back is safe.** Every time the game comes back to the foreground it checks that its connection is genuinely alive, rather than trusting the browser's word for it. A phone that lost the network in your pocket looks connected but is not, which used to leave the game sitting there frozen; now the dead connection is thrown away and a new one made, usually before you have finished looking at the screen. A brass **Reconnecting** strip across the top means it is working on it. Meanwhile the table carries on without you, so you come back to the current state rather than a stale one.

**Tables clean themselves up.** A room with nobody connected is deleted after 30 minutes.

---

## Running it on your own machine first

If you want to try it before deploying:

```
npm install
npm start
```

Then open `http://localhost:3000`. Other devices on the same wifi can reach it at your computer's local IP, for example `http://192.168.1.5:3000`.

To speed up bot moves while testing:

```
BOT_MS=200 TRICK_MS=400 npm start
```

Everything with a timer can be set the same way, in milliseconds:

| Variable | Default | What it controls |
|---|---|---|
| `BOT_MS` | 900 | How long a bot pretends to think. |
| `TRICK_MS` | 2600 | How long a completed trick stays on the cloth. |
| `NEXT_MS` | 7000 | The pause between rounds. |
| `TURN_MS` | 60000 | How long a player who is present gets before a card is played for them. |
| `AWAY_MS` | 30000 | The same, for a seat whose phone has dropped. |
| `SLOW_MS` | 15000 | When the "is thinking" nudge fires. |
| `CHAT_MS` | 600 | Minimum gap between one player's chat messages. |
| `LOBBY_GRACE_MS` | 90000 | How long a lobby seat is held for a dropped phone. |
| `MAX_ROOMS` | 500 | Ceiling on tables open at once. |
| `STATE_FILE` | `.rooms.json` | Where tables are saved when the server stops. |

To run the tests:

```
npm test
```

---

## Rules as implemented

- 84 cards: two packs, all 2s and 3s removed, and the 4s from one pack only.
- 14 cards each at six-handed over 9 rounds, 12 each at seven-handed over 10 rounds.
- 200 points on the table: every 5 and 10 is 5, every ace is 10, each queen of spades is 20.
- Bidding opens at 100 from the dealer's left, who cannot pass. Raises in fives to a ceiling of 200.
- The bidder names trump and calls any two cards, and may call the same card twice to bring in a partner on each copy. The first player to lay each one joins the team. The bidder may call a card he holds; if he lays that copy himself, whoever holds the second copy is the partner. If one player lays both called cards, he is the sole partner and the bidder plays two against the rest.
- Follow suit if you can. Highest trump wins, else highest of the led suit. Identical cards tie in favour of whoever played first.
- Making the bid pays the team what it actually collected. Falling short pays every opponent the bid amount, except in the final round where it pays what the opponents actually collected.
- Highest personal total after the last round wins.
