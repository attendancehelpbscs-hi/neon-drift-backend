/*
  Neon Drift — Backend Server
  Handles: Monetag postback verification, server-side balances, FaucetPay ETH withdrawals
  Deploy this to Render.com as a Web Service (Node, free tier works)
*/

const express = require('express');
const cors    = require('cors');
const Database = require('better-sqlite3');
const path    = require('path');

const app = express();

// Allow your Netlify domain (and any origin in dev)
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*'
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Database (SQLite) ────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'neon_drift.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id          TEXT PRIMARY KEY,
    balance_usd REAL    DEFAULT 0,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS claims (
    ymid        TEXT    PRIMARY KEY,
    player_id   TEXT    NOT NULL,
    status      TEXT    DEFAULT 'pending',
    created_at  INTEGER DEFAULT (strftime('%s','now')),
    verified_at INTEGER,
    est_price   REAL
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT    NOT NULL,
    amount_usd  REAL    NOT NULL,
    wallet      TEXT    NOT NULL,
    status      TEXT    DEFAULT 'pending',
    fp_response TEXT,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ─── Constants (keep in sync with index.html) ─────────────────────────────────
const PAYOUT_PER_AD  = 0.003;  // USD credited per verified ad watch
const WITHDRAW_MIN   = 2.00;   // USD minimum before withdrawal unlocks
const DAILY_CAP      = 10;     // max ad watches credited per player per day

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getOrCreate(playerId) {
  let p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!p) {
    db.prepare('INSERT OR IGNORE INTO players (id) VALUES (?)').run(playerId);
    p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  }
  return p;
}

function todayCount(playerId) {
  const dayStart = Math.floor(Date.now() / 1000) - 86400;
  return db.prepare(
    "SELECT COUNT(*) AS c FROM claims WHERE player_id = ? AND status = 'verified' AND verified_at > ?"
  ).get(playerId, dayStart).c;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ ok: true, service: 'neon-drift-backend' }));

/*
  STEP 1 — Game calls this before showing a rewarded ad.
  Returns a one-time ymid token that can only be used once.
*/
app.post('/api/request-ad-token', (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ error: 'playerId required' });

  getOrCreate(playerId);

  if (todayCount(playerId) >= DAILY_CAP) {
    return res.status(429).json({ error: 'Daily limit reached' });
  }

  const ymid = playerId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  db.prepare('INSERT INTO claims (ymid, player_id) VALUES (?, ?)').run(ymid, playerId);

  res.json({ ymid });
});

/*
  STEP 2a — Game calls this once the player finishes watching the ad.
  We mark the ymid as client-confirmed and credit the balance.
  This is the primary credit path since Vignette Banner doesn't pass ymid in postbacks.
*/
app.post('/api/confirm-watch', (req, res) => {
  const { playerId, ymid } = req.body;
  if (!playerId || !ymid) return res.status(400).json({ error: 'playerId and ymid required' });

  const claim = db.prepare('SELECT * FROM claims WHERE ymid = ?').get(ymid);

  if (!claim)                        return res.status(404).json({ error: 'Unknown token' });
  if (claim.player_id !== playerId)  return res.status(403).json({ error: 'Token mismatch' });
  if (claim.status !== 'pending')    return res.status(409).json({ error: 'Token already used' });

  if (todayCount(playerId) >= DAILY_CAP) {
    return res.status(429).json({ error: 'Daily limit reached' });
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE claims SET status = 'verified', verified_at = ? WHERE ymid = ?").run(now, ymid);
  db.prepare('UPDATE players SET balance_usd = balance_usd + ? WHERE id = ?').run(PAYOUT_PER_AD, playerId);

  const player = db.prepare('SELECT balance_usd FROM players WHERE id = ?').get(playerId);
  res.json({ ok: true, balanceUSD: player.balance_usd });
});

/*
  STEP 2b — Monetag calls this endpoint on their own servers when an ad is
  verified as genuinely watched and monetized (reward_event_type = "valued").
  Configure this URL in your Monetag dashboard → zone settings → postback URL:
    https://YOUR-RENDER-URL.onrender.com/api/postback
  
  Note: Vignette Banner postbacks don't carry ymid, so this reconciles
  any claims Monetag verified that the client didn't report.
*/
app.get('/api/postback', (req, res) => {
  // Always respond 200 fast — Monetag retries on anything else
  res.sendStatus(200);

  const { ymid, reward_event_type, estimated_price, zone_id } = req.query;
  console.log('Postback received:', { ymid, reward_event_type, zone_id });

  if (!ymid || reward_event_type !== 'valued') return;

  const claim = db.prepare('SELECT * FROM claims WHERE ymid = ?').get(ymid);
  if (!claim || claim.status === 'verified') return;

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE claims SET status = 'verified', verified_at = ?, est_price = ? WHERE ymid = ?")
    .run(now, parseFloat(estimated_price) || null, ymid);
  db.prepare('UPDATE players SET balance_usd = balance_usd + ? WHERE id = ?')
    .run(PAYOUT_PER_AD, claim.player_id);
});

/*
  STEP 3 — Game polls this to show the real server-side balance.
*/
app.get('/api/balance/:playerId', (req, res) => {
  const player = getOrCreate(req.params.playerId);
  res.json({ balanceUSD: player.balance_usd });
});

/*
  STEP 4 — Player requests a withdrawal. Backend calls FaucetPay to send ETH.
  Requires env var: FAUCETPAY_API_KEY
  
  FaucetPay amount is in Gwei (1 ETH = 1,000,000,000 Gwei).
  We convert USD → ETH using CoinGecko's free price API, then to Gwei.
*/
app.post('/api/withdraw', async (req, res) => {
  const { playerId, walletAddress } = req.body;
  if (!playerId || !walletAddress) {
    return res.status(400).json({ error: 'playerId and walletAddress required' });
  }

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player || player.balance_usd < WITHDRAW_MIN) {
    return res.status(400).json({ error: `Minimum $${WITHDRAW_MIN} not reached` });
  }

  if (!process.env.FAUCETPAY_API_KEY) {
    return res.status(500).json({ error: 'Payout not configured on server' });
  }

  // Deduct balance immediately to prevent double-spend
  const amountUSD = player.balance_usd;
  db.prepare('UPDATE players SET balance_usd = 0 WHERE id = ?').run(playerId);

  const withdrawalId = db.prepare(
    'INSERT INTO withdrawals (player_id, amount_usd, wallet) VALUES (?, ?, ?)'
  ).run(playerId, amountUSD, walletAddress).lastInsertRowid;

  try {
    // Get live ETH price from CoinGecko (free, no key needed)
    const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const priceData = await priceRes.json();
    const ethPrice  = priceData.ethereum.usd;

    const ethAmount  = amountUSD / ethPrice;           // e.g. 0.000000666 ETH
    const gweiAmount = Math.floor(ethAmount * 1e9);    // convert to Gwei for FaucetPay

    // Call FaucetPay send API
    const fpRes = await fetch('https://faucetpay.io/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key:  process.env.FAUCETPAY_API_KEY,
        amount:   gweiAmount.toString(),
        to:       walletAddress,
        currency: 'ETH',
        referral: 'yes',
        act:      'send'
      })
    });

    const fpData = await fpRes.json();
    console.log('FaucetPay response:', fpData);

    db.prepare("UPDATE withdrawals SET status = 'sent', fp_response = ? WHERE id = ?")
      .run(JSON.stringify(fpData), withdrawalId);

    if (fpData.status === 200) {
      res.json({ ok: true, amountUSD, gweiAmount, ethPrice });
    } else {
      // FaucetPay rejected — refund player
      db.prepare('UPDATE players SET balance_usd = ? WHERE id = ?').run(amountUSD, playerId);
      db.prepare("UPDATE withdrawals SET status = 'failed' WHERE id = ?").run(withdrawalId);
      res.status(502).json({ error: fpData.message || 'FaucetPay error', code: fpData.status });
    }
  } catch (err) {
    // Network/unexpected error — refund player
    console.error('Withdrawal error:', err);
    db.prepare('UPDATE players SET balance_usd = ? WHERE id = ?').run(amountUSD, playerId);
    db.prepare("UPDATE withdrawals SET status = 'error' WHERE id = ?").run(withdrawalId);
    res.status(500).json({ error: 'Server error during withdrawal' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Neon Drift backend listening on port ${PORT}`));
