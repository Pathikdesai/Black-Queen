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
| `tools/tune.js` | Searches for better bot strategy numbers by replaying fixed deals. `npm run tune`. |
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

**The bots count cards, and play to table rules.** They track which cards have been played and who has failed to follow which suit, and only ever use what is visible at the table, so they are counting rather than peeking.

That last part is checked rather than asserted. `npm test` wraps every hand at the table, records every read of it along with the seat that is currently deciding, and fails if any bot decision ever touches another player's cards — or the server's private record of who is secretly on the bidding side. Across a few hundred decisions it comes out at zero. What a bot may use is its own hand, the cards already played, who has failed to follow which suit, the announced calls, and the revealed team: everything a person in that seat can see.

One consequence worth knowing: if you are holding a card the bidder called, you are going to be his partner, and the app now tells you so. The bots work that out for themselves, so leaving it off your screen would have given them the one thing they knew that you were not being shown.

On top of that they follow a handful of conventions that came from a player rather than from the rulebook:

- Length wins hands, not points in hand. Length in spades counts for a little more than length elsewhere, since the black queens ride in that suit.
- Bid up one step at a time. A strong hand takes the auction anyway, and every five it climbs is five more to find later.
- Trump is the suit you are strongest in, not simply the longest. Five spades with the ace and a black queen beats six hearts with the same top cards, because the hearts are worth nothing and the spades are worth forty. A black queen only argues for spades when there are enough spades behind it to protect her: three spades and a queen is not a spade hand.
- Never call a card in a suit you are void in; that call can never come down.
- Never call a card you hold every copy of, either. There is no third one to call for, so nobody can join on it: lay it yourself and it is announced dead, sit on it and it never comes down. Either way one of your two chances at a partner is gone and you play a man short for it. Worth about three points a deal, and it was happening on a tenth of all calls.
- Call in the trump suit where you can. A partner found in the suit you control is a partner you can work with.
- Calling a card you are holding is fine — the second copy is out there and whoever has it joins you. But your own copy never goes down. Lead the card just below it instead: whoever holds the other one has to spend it to win the trick, so the partnership comes out anyway, the opposition is a round of the suit lighter, and your ace is still there for the big card that turns up later. Holding A-K of the called suit, lead the king. Length changes nothing — a long suit is a reason to keep the ace, since the small cards can do the cutting and the one thing they cannot do is beat something big. This is about the called card and only the called card: it is being held to bring a partner out, not because aces keep well. An ordinary ace is the opposite case — see the two rules below.
- Do not take a trick that has nothing in it unless the card will actually hold up. Winning an empty trick is worth nothing by definition, so the only thing it can do is cost you: play the ten to sit in front for one seat, watch the jack that was plainly still unaccounted for come down on it, and five points cross the table with the trick. Worth about a point a deal.
- Win a trick with the cheapest card that takes it. Holding the ace and the queen of the led suit with a ten already in the trick, the queen takes it and costs nothing; the ace would take the same trick and throw ten more points into it.
- But do not then sit on that ace. A top card only wins while people can still follow — the moment somebody runs dry it is cut, and an ace cut is ten points handed over on top of the trick. So cash it at the first lead you get, ahead of anything speculative. Among cards worth the same, cash the one in your longest suit first: length in your hand means shortage in everybody else's, so that is the suit that runs dry soonest and the top card in it is the one most at risk. Not into a suit an opponent has already shown out of — there the damage is done and it stays in hand.
- As bidder, lead a suit you hold one card of. It empties the suit for cutting later. Cashing a top card comes first, though: a void is a thing you might use, and ten points banked is a thing you have.
- Holding a called card that has not come down, you already know you are the bidder's partner: he named that card out loud to find one, and you can see your own hand. So do not beat his king with the called ace. Between them those two cards could win two tricks; spent together they win one. That is true whether or not he is holding the other copy, so it does not rest on guessing where that copy is. Hold it and you can still come in on the next lower lead — and in the hands where that chance never arrives, you are left with a card nobody can take off you.
- Otherwise, lay a called card early: until the partnership is shown, neither of you knows which way to push a trick. But never at a price. A called card that cannot take the trick and carries points is not laid at all — coming in is supposed to help your side, not pay an opponent for the privilege. The black queen dropped under a king is twenty points given away, whoever it reveals. But not from the last seat on a trick with no points in it, and not in a hurry when the called card is a trump, since a trump cannot be cut. A called card in a side suit still full of cards is the one to spend now, before somebody runs dry and cuts the round it would have won.
- Everyone the bidder is not playing with is playing against him — and so with each other. Once both calls have been answered there is nothing left pending, and the defenders are a side: they feed each other points and stop cutting each other's tricks. Obvious at a table and it was the single biggest thing missing here, worth about five points a deal on its own, more than any other rule on this list. Nothing hidden is needed to see it: a called card being laid is announced, and both calls being answered is there for everyone. Until then no assumption is allowed, because anyone still might turn up as the partner.
- A partner winning the trick is not the same as your side taking it. With opponents still to play and a better card unaccounted for, the trick is not yours yet — hold the ace and take it. Letting a partner's jack ride and watching an opponent take the trick with the queen is a trick given away for nothing.
- Never cut a trick your side is already taking, and never throw a trump onto one a partner has already cut. The points were coming to you either way, and that trump could have cut a whole trick later. A trump goes only when there is genuinely nothing else in the hand.
- When the trick is safely your side's, put your points into it. Waiting to be the last to play is too cautious: with none but partners left behind you, a ten kept back is a ten your own side did not collect.
- The black queen only goes down when the trick is already settled — nothing outstanding can beat her, or none but partners are left to play — and never onto a trick the other side is taking. Being last to play is not on its own a reason: last into a trick an opponent has won is twenty points handed over.
- The ace and king of spades are held back while a black queen is still out. They are the only cards that take one off the table, and spending the ace on a five point trick means having nothing left when the queen finally appears.
- One exception, and it is deliberate: leading a black queen who has become the top spade left. That is the one lead the rule above does not police, and she gets cut about two times in three when it happens — which looks like a straightforward bug until you check where she ends up otherwise. Blocking the lead moved it not at all: over 3,900 queens the holder's own side finished with her 60.0% of the time either way, and holding her scored 0.3 a deal *worse*. Off trump she is a liability from the moment she is dealt, and refusing to lead her only postpones losing her, usually to the last trick where there is no choice left. Recorded here because it reads like an oversight and has been "fixed" once already.

Played head to head against the bots that came before all this, three a side over 250 games, the current ones score about 5% more and win nearly three tables in five. Individual rules were measured the same way; the queen catchers are worth about 3% on their own, and teaching the defenders that they are a side is worth around five points a deal, measured on 8,400 fixed deals each played twice with the sides swapped, ahead on five of six independent sets.


### Tuning them

Every number the bots weigh a decision with lives in one `TUNE` block in `server.js`, and `npm run tune` searches it.

The searching matters less than the measuring. Comparing two versions over random games barely works — the cards decide most of it, and a few hundred games still carries several percent of noise, which is more than the difference you are usually looking for. So the tuner deals from a seed and replays the *same* deals for both versions, then plays the whole set again with the sides swapped. Run `npm run tune -- --check` and it puts identical settings on both sides: the answer is exactly zero, every time. That is a measuring instrument you can trust.

The search on top of it is a plain hill climb, and its output needs reading rather than pasting. It plays against these same bots, so it will happily find settings that beat them and lose to people. One run reported a confident gain that turned out to come from bidding far higher and taking spades in most deals — exactly what a player had just reported as wrong at a real table. The tool now checks any winner against three separate sets of unseen deals and refuses to recommend anything that does not win all three. Nothing it has produced so far has cleared that bar, which is why the numbers in `server.js` are still the ones that came from a person.

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
