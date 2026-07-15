/*
  Neon Drift — Backend Server
  Handles: Monetag postback verification, server-side balances, direct ETH withdrawals
  Deploy to Render.com as a Web Service (Node, free tier)

  Required env vars on Render:
    PAYOUT_WALLET_PRIVATE_KEY  — private key of your dedicated payout wallet
                                  (create a NEW wallet in MetaMask, never use your main one)
    INFURA_API_KEY             — free at infura.io
    ALLOWED_ORIGIN             — your Netlify URL e.g. https://neon-drifft.netlify.app
*/

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const { ethers } = require('ethers');

const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Simple JSON database (no native modules needed) ─────────────────────────
const DB_FILE = path.join(__dirname, 'db.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { players: {}, claims: {}, withdrawals: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { players: {}, claims: {}, withdrawals: [] };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getOrCreate(db, playerId) {
  if (!db.players[playerId]) {
    db.players[playerId] = { balanceUSD: 0, createdAt: Date.now() };
  }
  return db.players[playerId];
}

function todayVerifiedCount(db, playerId) {
  const dayAgo = Date.now() - 86400000;
  return Object.values(db.claims).filter(c =>
    c.playerId === playerId &&
    c.status === 'verified' &&
    c.verifiedAt > dayAgo
  ).length;
}

// ─── Constants (keep in sync with index.html) ─────────────────────────────────
const PAYOUT_PER_AD  = 0.003;
const WITHDRAW_MIN   = 2.00;
const DAILY_CAP      = 10;

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ ok: true, service: 'neon-drift-backend' }));

/*
  STEP 1 — Game calls this before showing a rewarded ad.
  Returns a one-time ymid token.
*/
app.post('/api/request-ad-token', (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ error: 'playerId required' });

  const db = readDB();
  getOrCreate(db, playerId);

  if (todayVerifiedCount(db, playerId) >= DAILY_CAP) {
    return res.status(429).json({ error: 'Daily limit reached' });
  }

  const ymid = playerId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  db.claims[ymid] = { playerId, status: 'pending', createdAt: Date.now() };
  writeDB(db);

  res.json({ ymid });
});

/*
  STEP 2a — Game calls this once the player finishes watching the ad.
  Marks ymid as used and credits the balance server-side.
*/
app.post('/api/confirm-watch', (req, res) => {
  const { playerId, ymid } = req.body;
  if (!playerId || !ymid) return res.status(400).json({ error: 'playerId and ymid required' });

  const db    = readDB();
  const claim = db.claims[ymid];

  if (!claim)                       return res.status(404).json({ error: 'Unknown token' });
  if (claim.playerId !== playerId)  return res.status(403).json({ error: 'Token mismatch' });
  if (claim.status !== 'pending')   return res.status(409).json({ error: 'Token already used' });

  if (todayVerifiedCount(db, playerId) >= DAILY_CAP) {
    return res.status(429).json({ error: 'Daily limit reached' });
  }

  claim.status     = 'verified';
  claim.verifiedAt = Date.now();

  const player = getOrCreate(db, playerId);
  player.balanceUSD += PAYOUT_PER_AD;
  writeDB(db);

  res.json({ ok: true, balanceUSD: player.balanceUSD });
});

/*
  STEP 2b — Monetag calls this on their own servers to independently confirm
  the ad was genuinely watched (reward_event_type = "valued").
  Set this as your postback URL in Monetag dashboard:
    https://YOUR-RENDER-URL.onrender.com/api/postback
*/
app.get('/api/postback', (req, res) => {
  res.sendStatus(200); // always respond fast

  const { ymid, reward_event_type, estimated_price, zone_id } = req.query;
  console.log('Monetag postback:', { ymid, reward_event_type, zone_id });

  if (!ymid || reward_event_type !== 'valued') return;

  const db    = readDB();
  const claim = db.claims[ymid];
  if (!claim || claim.status === 'verified') return;

  claim.status      = 'verified';
  claim.verifiedAt  = Date.now();
  claim.estimatedPrice = parseFloat(estimated_price) || null;

  const player = getOrCreate(db, claim.playerId);
  player.balanceUSD += PAYOUT_PER_AD;
  writeDB(db);
});

/*
  STEP 3 — Game polls this to display the real server-side balance.
*/
app.get('/api/balance/:playerId', (req, res) => {
  const db     = readDB();
  const player = getOrCreate(db, req.params.playerId);
  writeDB(db);
  res.json({ balanceUSD: player.balanceUSD });
});

/*
  STEP 4 — Player requests withdrawal.
  Converts USD → ETH at live price via CoinGecko, sends ETH directly
  from your payout wallet using ethers.js + Infura.
*/
app.post('/api/withdraw', async (req, res) => {
  const { playerId, walletAddress } = req.body;
  if (!playerId || !walletAddress) {
    return res.status(400).json({ error: 'playerId and walletAddress required' });
  }

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: 'Invalid Ethereum wallet address' });
  }

  const db     = readDB();
  const player = getOrCreate(db, playerId);

  if (player.balanceUSD < WITHDRAW_MIN) {
    return res.status(400).json({ error: `Minimum $${WITHDRAW_MIN} not reached` });
  }

  if (!process.env.PAYOUT_WALLET_PRIVATE_KEY || !process.env.INFURA_API_KEY) {
    return res.status(500).json({ error: 'Payout not configured on server' });
  }

  // Deduct immediately to prevent double-spend
  const amountUSD = player.balanceUSD;
  player.balanceUSD = 0;
  const withdrawal = { playerId, amountUSD, walletAddress, status: 'pending', createdAt: Date.now() };
  db.withdrawals.push(withdrawal);
  writeDB(db);

  try {
    // Live ETH price from CoinGecko (free, no key needed)
    const priceRes  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const priceData = await priceRes.json();
    const ethPrice  = priceData.ethereum.usd;

    const ethAmount = amountUSD / ethPrice;
    const weiAmount = ethers.parseEther(ethAmount.toFixed(18));

    const provider  = new ethers.InfuraProvider('mainnet', process.env.INFURA_API_KEY);
    const wallet    = new ethers.Wallet(process.env.PAYOUT_WALLET_PRIVATE_KEY, provider);

    // Check payout wallet has enough ETH
    const balance  = await provider.getBalance(wallet.address);
    const feeData  = await provider.getFeeData();
    const gasCost  = BigInt(21000) * feeData.gasPrice;

    if (balance < weiAmount + gasCost) {
      // Refund player — payout wallet needs topping up
      player.balanceUSD = amountUSD;
      withdrawal.status = 'insufficient_funds';
      writeDB(db);
      console.warn('Payout wallet too low, top it up:', wallet.address);
      return res.status(503).json({ error: 'Payout temporarily unavailable — try again later' });
    }

    const tx = await wallet.sendTransaction({ to: walletAddress, value: weiAmount });
    console.log('ETH sent:', tx.hash, '| USD:', amountUSD, '| ETH:', ethAmount, '| To:', walletAddress);

    withdrawal.status  = 'sent';
    withdrawal.txHash  = tx.hash;
    withdrawal.ethAmount = ethAmount;
    withdrawal.ethPrice  = ethPrice;
    writeDB(db);

    res.json({ ok: true, amountUSD, ethAmount, ethPrice, txHash: tx.hash });

  } catch (err) {
    // Refund on any error
    console.error('Withdrawal error:', err.message);
    player.balanceUSD = amountUSD;
    withdrawal.status = 'error';
    withdrawal.error  = err.message;
    writeDB(db);
    res.status(500).json({ error: 'Server error — your balance has been refunded' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Neon Drift backend running on port ${PORT}`));
