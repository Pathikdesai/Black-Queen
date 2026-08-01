# Black Queen, online

A table for 6 or 7 players. One person creates a table, shares a four letter code, everyone else joins from the same link. Empty seats can be filled by bots so you can start short-handed.

The cards live on the server. Each phone only ever receives its own hand, so nobody can peek by opening the browser inspector.

---

## What is in here

| File | What it does |
|---|---|
| `server.js` | The referee. Deck, bidding, trick logic, scoring, bots, WebSocket rooms. |
| `public/index.html` | Everything players see. One file, no build step. |
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

**One caveat.** A redeploy restarts the server, which ends any game in progress. Deploy between games, not mid-round.

---

## Things worth knowing

**The free plan sleeps.** After 15 minutes with nobody connected, Render puts the service to sleep. The next person to open the link waits about a minute for it to wake. Once a game is running, traffic keeps it awake. If that wait irritates people, Render's Starter plan removes it for roughly 600 rupees a month.

**Dropped connections are handled.** If a phone locks or loses signal, that seat is held. Reopen the link and you are back in the same seat with the same cards and scores. While you are away the table does not freeze: after 30 seconds a bot plays your turns so the round keeps moving.

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

---

## Rules as implemented

- 84 cards: two packs, all 2s and 3s removed, and the 4s from one pack only.
- 14 cards each at six-handed over 9 rounds, 12 each at seven-handed over 10 rounds.
- 200 points on the table: every 5 and 10 is 5, every ace is 10, each queen of spades is 20.
- Bidding opens at 100 from the dealer's left, who cannot pass. Raises in fives to a ceiling of 200.
- The bidder names trump and calls two cards. The first player to lay each one joins the team. The bidder may call a card he holds; if he lays that copy himself, whoever holds the second copy is the partner.
- Follow suit if you can. Highest trump wins, else highest of the led suit. Identical cards tie in favour of whoever played first.
- Making the bid pays the team what it actually collected. Falling short pays every opponent the bid amount, except in the final round where it pays what the opponents actually collected.
- Highest personal total after the last round wins.
