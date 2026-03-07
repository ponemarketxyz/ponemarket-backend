const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();

// ── CORS — must be first ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const BANKR_KEY     = process.env.BANKR_API_KEY;
const BANKR_LLM_KEY = process.env.BANKR_LLM_KEY;
const POLYMARKET    = 'https://gamma-api.polymarket.com';
const BANKR_API     = 'https://api.bankr.bot';
const BANKR_LLM     = 'https://llm.bankr.bot';

// ── POSTGRES ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      api_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT,
      twitter TEXT,
      strategy TEXT,
      webhook_url TEXT,
      balance NUMERIC DEFAULT 1000,
      pnl NUMERIC DEFAULT 0,
      trades INTEGER DEFAULT 0,
      win_rate NUMERIC DEFAULT 0,
      bankr_wallet TEXT,
      registered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      api_key TEXT,
      market_id TEXT,
      outcome_id TEXT,
      market_title TEXT,
      outcome_label TEXT,
      side TEXT,
      amount NUMERIC,
      price NUMERIC,
      shares NUMERIC,
      potential_payout NUMERIC,
      status TEXT DEFAULT 'filled',
      created_at TEXT
    );
  `);
  // Add missing columns to existing tables (safe to run multiple times)
  const migrations = [
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS twitter TEXT",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS strategy TEXT",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_url TEXT",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS pnl NUMERIC DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS trades INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS win_rate NUMERIC DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS bankr_wallet TEXT",
    "ALTER TABLE agents ADD COLUMN IF NOT EXISTS registered_at TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_key TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS market_title TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS outcome_label TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount NUMERIC",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS price NUMERIC",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shares NUMERIC",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS potential_payout NUMERIC",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS outcome_id TEXT",
    "ALTER TABLE orders ALTER COLUMN outcome_id DROP NOT NULL",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'filled'",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TEXT",
    "ALTER TABLE orders ALTER COLUMN amount_spent DROP NOT NULL",
    "ALTER TABLE orders ALTER COLUMN outcome_id DROP NOT NULL",
  ];
  for (const sql of migrations) {
    await pool.query(sql).catch(() => {});
  }
  console.log('✅ DB tables ready');
}

// In-memory fallback (used if DATABASE_URL not set)
const _agents = new Map();
const _orders = [];

// DB abstraction — uses Postgres if available, else in-memory
const db = {
  async getAgent(apiKey) {
    if (!process.env.DATABASE_URL) return _agents.get(apiKey) || null;
    const r = await pool.query('SELECT * FROM agents WHERE api_key=$1', [apiKey]);
    return r.rows[0] || null;
  },
  async saveAgent(agent) {
    if (!process.env.DATABASE_URL) { _agents.set(agent.api_key, agent); return; }
    await pool.query(`
      INSERT INTO agents (api_key,id,name,twitter,strategy,webhook_url,balance,pnl,trades,win_rate,bankr_wallet,registered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (api_key) DO UPDATE SET
        balance=EXCLUDED.balance, pnl=EXCLUDED.pnl, trades=EXCLUDED.trades,
        win_rate=EXCLUDED.win_rate, bankr_wallet=EXCLUDED.bankr_wallet,
        webhook_url=EXCLUDED.webhook_url
    `, [agent.api_key,agent.id,agent.name,agent.twitter,agent.strategy,agent.webhook_url,
        agent.balance,agent.pnl,agent.trades,agent.win_rate,agent.bankr_wallet,agent.registered_at]);
  },
  async getAllAgents() {
    if (!process.env.DATABASE_URL) return [..._agents.values()];
    const r = await pool.query('SELECT * FROM agents ORDER BY balance DESC');
    return r.rows;
  },
  async saveOrder(order, apiKey) {
    if (!process.env.DATABASE_URL) { _orders.push(order); return; }
    await pool.query(`
      INSERT INTO orders (id,agent_id,api_key,market_id,outcome_id,market_title,outcome_label,side,amount,price,shares,potential_payout,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO NOTHING
    `, [order.id,order.agent_id,apiKey,order.market_id,order.outcome_id||null,order.market_title,
        order.outcome_label,order.side,order.amount,order.price,order.shares,
        order.potential_payout,order.status,order.created_at]);
  },
  async getOrders(agentId) {
    if (!process.env.DATABASE_URL) return _orders.filter(o => o.agent_id === agentId);
    try {
      const r = await pool.query('SELECT * FROM orders WHERE agent_id=$1 ORDER BY created_at DESC NULLS LAST', [agentId]);
      return r.rows;
    } catch(e) {
      console.error('getOrders error:', e.message);
      return [];
    }
  },
  async deleteOrder(orderId, agentId) {
    if (!process.env.DATABASE_URL) {
      const idx = _orders.findIndex(o => o.id === orderId && o.agent_id === agentId);
      if (idx === -1) return false;
      _orders.splice(idx, 1); return true;
    }
    const r = await pool.query('DELETE FROM orders WHERE id=$1 AND agent_id=$2', [orderId, agentId]);
    return r.rowCount > 0;
  },
};

// ── HELPER ───────────────────────────────────────────────────────────────────
function authHeader(req) {
  return req.headers['authorization'] || '';
}

function getAgentKey(req) {
  const h = authHeader(req);
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function requireAgent(req, res, next) {
  const key = getAgentKey(req);
  if (!key) return res.status(401).json({ error: 'Invalid or missing API key' });
  try {
    const agent = await db.getAgent(key);
    if (!agent) return res.status(401).json({ error: 'Invalid or missing API key' });
    agent.api_key = key; // ensure api_key is always set on agent object
    req.agent = agent;
    req.apiKey = key;
    next();
  } catch(e) {
    res.status(500).json({ error: 'DB error', detail: e.message });
  }
}

// ── CACHE CLEAR ──────────────────────────────────────────────────────────────
app.get('/v1/cache/clear', (req, res) => {
  marketsCache = null;
  marketsCacheTs = 0;
  res.json({ message: 'Cache cleared' });
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bankr: !!BANKR_KEY, ts: Date.now() });
});

// ── MARKETS (proxy Polymarket + cache) ───────────────────────────────────────
let marketsCache = null;
let marketsCacheTs = 0;

app.get('/v1/markets', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const cat   = req.query.category;

    // cache 60 detik
    if (!marketsCache || Date.now() - marketsCacheTs > 30_000) {
      const r = await fetch(`${POLYMARKET}/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false`);
      const raw = await r.json();
      // Normalize to our format with real prices
      marketsCache = raw.map(m => {
        // Polymarket uses outcomePrices (stringified array) + outcomes (array of strings)
        let outcomes = [];
        try {
          const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []);
          const labels = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []);
          outcomes = labels.map((label, i) => ({
            label,
            price_yes: parseFloat(prices[i]) || 0.5,
            price_no: 1 - (parseFloat(prices[i]) || 0.5),
          }));
        } catch(_) {
          // fallback: tokens array
          if (m.tokens && m.tokens.length) {
            outcomes = m.tokens.map(t => ({
              label: t.outcome,
              price_yes: parseFloat(t.price) || 0.5,
              price_no: 1 - (parseFloat(t.price) || 0.5),
            }));
          }
        }
        return {
          id: m.id || m.conditionId,
          title: m.question || m.title,
          category: m.category || 'other',
          tags: m.tags || [],
          volume: parseFloat(m.volume) || parseFloat(m.volume24hr) || 0,
          volume_24h: parseFloat(m.volume24hr) || 0,
          closes_at: m.endDate || m.endDateIso || m.end_date_iso || m.expirationDate || m.closes_at,
          outcomes,
          active: m.active,
          image: m.image,
        };
      }).filter(m => {
        if (!m.title) return false;
        if (m.active === false) return false;
        // Filter out expired markets - check all possible date fields
        const closeStr = m.closes_at || m.endDate || m.endDateIso || m.end_date_iso || m.expirationDate;
        if (closeStr) {
          const closeDate = new Date(closeStr);
          if (!isNaN(closeDate) && closeDate < new Date()) return false;
        }
        return true;
      });
      marketsCacheTs = Date.now();
    }

    let markets = marketsCache.slice(0, limit);
    if (cat) markets = markets.filter(m =>
      (m.tags || []).some(t => t.toLowerCase().includes(cat.toLowerCase()))
    );

    res.json({ markets, count: markets.length, cached: true });
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch markets', detail: e.message });
  }
});

app.get('/v1/markets/:id', async (req, res) => {
  try {
    const r = await fetch(`${POLYMARKET}/markets/${req.params.id}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch market' });
  }
});

app.get('/v1/markets/:id/orderbook', async (req, res) => {
  try {
    const r = await fetch(`${POLYMARKET}/book?market=${req.params.id}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch orderbook' });
  }
});

// ── AGENT REGISTER ───────────────────────────────────────────────────────────
app.post('/v1/agents/register', async (req, res) => {
  const { name, twitter, strategy, webhook_url } = req.body;
  if (!name || !twitter) {
    return res.status(400).json({ error: 'name and twitter required' });
  }

  // Generate API key
  const apiKey = 'pm_live_' + Math.random().toString(36).slice(2) +
                              Math.random().toString(36).slice(2);

  const agent = {
    id: 'agent_' + Date.now(),
    name, twitter, strategy,
    webhook_url: webhook_url || null,
    api_key: apiKey,
    balance: 1000,        // starter balance USDC (sandbox)
    pnl: 0,
    trades: 0,
    win_rate: 0,
    rank: null,
    registered_at: new Date().toISOString(),
    bankr_wallet: null,   // akan diisi kalau Bankr wallet provisioning aktif
  };

  agent.api_key = apiKey;
  await db.saveAgent(agent);

  // ── Opsional: Provisioning Bankr wallet ─────────────────────────────────
  if (BANKR_KEY) {
    try {
      const br = await fetch(`${BANKR_API}/agent/wallet/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': BANKR_KEY,
        },
        body: JSON.stringify({ agentName: name, agentId: agent.id }),
      });
      if (br.ok) {
        const bdata = await br.json();
        agent.bankr_wallet = bdata.wallet || bdata.address || null;
        await db.saveAgent(agent);
      }
    } catch (_) { /* wallet provisioning optional */ }
  }

  res.status(201).json({
    message: 'Agent registered',
    agent_id: agent.id,
    api_key: apiKey,
    balance: agent.balance,
    bankr_wallet: agent.bankr_wallet,
  });
});

// ── AGENT ME ─────────────────────────────────────────────────────────────────
app.get('/v1/agents/me', requireAgent, (req, res) => {
  const { api_key, ...safe } = req.agent;
  res.json(safe);
});

// ── AGENT WEBHOOK ─────────────────────────────────────────────────────────────
app.post('/v1/agents/webhook', requireAgent, async (req, res) => {
  const { webhook_url } = req.body;
  req.agent.webhook_url = webhook_url;
  await db.saveAgent(req.agent);
  res.json({ message: 'Webhook updated', webhook_url });
});

// ── ORDERS ───────────────────────────────────────────────────────────────────

app.post('/v1/orders', requireAgent, async (req, res) => {
  const { market_id, outcome_id, side, amount } = req.body;
  if (!market_id || !side || !amount) {
    return res.status(400).json({ error: 'market_id, side, amount required' });
  }

  const { market_title, outcome_label } = req.body;
  const price = Math.random() * 0.4 + 0.3; // mock fill price 30-70%
  const shares = amount / price;
  const order = {
    id: 'ord_' + Date.now(),
    agent_id: req.agent.id,
    market_id, outcome_id,
    market_title: market_title || market_id,
    outcome_label: outcome_label || (side === 'yes' ? 'Yes' : 'No'),
    side, amount,
    price: parseFloat(price.toFixed(4)),
    shares: parseFloat(shares.toFixed(2)),
    potential_payout: parseFloat(shares.toFixed(2)),
    status: 'filled',
    created_at: new Date().toISOString(),
  };

  req.agent.balance = parseFloat((req.agent.balance - amount).toFixed(2));
  req.agent.trades++;
  await db.saveOrder(order, req.apiKey);
  await db.saveAgent(req.agent);

  res.status(201).json({ ...order, shares_received: order.shares });
});

app.get('/v1/orders', requireAgent, async (req, res) => {
  const myOrders = await db.getOrders(req.agent.id);
  res.json({ orders: myOrders, count: myOrders.length });
});

app.delete('/v1/orders/:id', requireAgent, async (req, res) => {
  const deleted = await db.deleteOrder(req.params.id, req.agent.id);
  if (!deleted) return res.status(404).json({ error: 'Order not found' });
  res.json({ message: 'Order cancelled' });
});

// ── PORTFOLIO ────────────────────────────────────────────────────────────────
app.get('/v1/portfolio', requireAgent, async (req, res) => {
  const myOrders = await db.getOrders(req.agent.id);
  const totalSpent = myOrders.filter(o => o.status === 'filled').reduce((s, o) => s + parseFloat(o.amount), 0);
  res.json({
    balance_usdc: parseFloat(req.agent.balance),
    total_pnl: parseFloat(req.agent.pnl || 0),
    total_trades: parseInt(req.agent.trades) || 0,
    win_rate: parseFloat(req.agent.win_rate || 0),
    bankr_wallet: req.agent.bankr_wallet,
    total_invested: parseFloat(totalSpent.toFixed(2)),
  });
});

app.get('/v1/portfolio/positions', requireAgent, async (req, res) => {
  const allOrders = await db.getOrders(req.agent.id);
  const positions = allOrders
    .filter(o => o.status === 'filled')
    .map(o => ({
      order_id: o.id,
      market_id: o.market_id,
      market_title: o.market_title || o.market_id,
      outcome_label: o.outcome_label || (o.side === 'yes' ? 'Yes' : 'No'),
      side: o.side,
      shares: o.shares,
      avg_entry_price: o.price,
      current_price: o.price, // static until market resolves
      unrealized_pnl: 0,
      amount: o.amount,
      created_at: o.created_at,
    }));
  res.json({ positions, count: positions.length });
});

app.get('/v1/portfolio/history', requireAgent, async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const allOrders = await db.getOrders(req.agent.id);
  const trades = allOrders
    .slice(0, limit)
    .reverse()
    .map(o => ({
      id: o.id,
      market_title: o.market_title || o.market_id,
      side: o.side,
      amount: o.amount,
      shares: o.shares,
      price: o.price,
      status: o.status,
      pnl: 0,
      created_at: o.created_at,
    }));
  res.json({ trades, count: trades.length });
});

// ── LEADERBOARD ──────────────────────────────────────────────────────────────
app.get('/v1/leaderboard', async (req, res) => {
  const allAgents = await db.getAllAgents();
  const board = allAgents
    .slice(0, 20)
    .map((a, i) => ({
      rank: i + 1,
      name: a.name,
      twitter: a.twitter,
      balance: a.balance,
      pnl: a.pnl,
      trades: a.trades,
      win_rate: a.win_rate,
    }));
  res.json({ leaderboard: board });
});

// ── DEBUG ────────────────────────────────────────────────────────────────────
app.get('/v1/debug/orders', requireAgent, async (req, res) => {
  const orders = await db.getOrders(req.agent.id);
  res.json({ agent_id: req.agent.id, count: orders.length, orders });
});

// ── WALLET SYNC ──────────────────────────────────────────────────────────────
app.post('/v1/wallet/sync', requireAgent, async (req, res) => {
  const { wallet, amount } = req.body;
  if (!wallet || !amount) return res.status(400).json({ error: 'wallet and amount required' });

  const newBalance = parseFloat(parseFloat(amount).toFixed(2));
  req.agent.balance = newBalance;
  await db.saveAgent(req.agent);

  res.json({
    message: 'Balance synced',
    wallet,
    new_balance: newBalance,
  });
});

// ── AI ANALYSIS ─────────────────────────────────────────────────────────────
app.post('/v1/ai/analyze', async (req, res) => {
  const { market_question, outcomes, volume } = req.body;
  if (!market_question) return res.status(400).json({ error: 'market_question required' });

  const prompt = `You are a prediction market analyst. Analyze this market and give a trading recommendation.

Market: ${market_question}
Outcomes: ${JSON.stringify(outcomes || [])}
Volume: $${volume || 'unknown'}

Respond ONLY with valid JSON (no markdown, no backticks, no explanation outside JSON):
{"recommendation":"YES","confidence":75,"reasoning":"your reasoning here","suggested_size":50}

recommendation must be YES, NO, or SKIP.`;

  // Try Bankr LLM Gateway
  if (BANKR_KEY) {
    try {
      const r = await fetch('https://api.bankr.bot/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BANKR_KEY}`,
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (r.ok) {
        const data = await r.json();
        const text = data.content?.[0]?.text || data.choices?.[0]?.message?.content || '';
        if (text) {
          try {
            const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());
            return res.json({ analysis, powered_by: 'bankr-x-claude' });
          } catch(_) {}
        }
      }
    } catch(_) {}
  }

  // Fallback: advanced heuristic analysis
  const q = market_question.toLowerCase();
  const vol = parseFloat(volume) || 0;

  let rec = 'SKIP', confidence = 50, reasoning = '', size = 0;

  // ── Keyword scoring ──
  // NOTE: Don't include 'will' - almost all Polymarket questions start with "Will..."
  const yesSignals = ['win','pass','approve','succeed','launch','above','reach','increase','rise','gain','confirm','sign','beat','exceed','complete','achieve','re-elect','stay','remain','keep'];
  const noSignals  = ['fail','lose','reject','below','crash','ban','block','decline','drop','miss','cancel','delay','collapse','impeach','resign','suspend','fall','never','not','without'];
  const skipSignals = ['exactly','precise','specific number','how many','what price','what will'];

  const yesScore = yesSignals.filter(k => q.includes(k)).length;
  const noScore  = noSignals.filter(k => q.includes(k)).length;
  const skipScore = skipSignals.filter(k => q.includes(k)).length;

  // If no clear signal either way, default to SKIP not YES
  const noEdge = yesScore === 0 && noScore === 0;

  // ── Category detection ──
  const isCrypto   = /bitcoin|btc|eth|ethereum|crypto|sol|doge|coin/.test(q);
  const isPolitics = /election|president|congress|senate|vote|trump|biden|party|democrat|republican/.test(q);
  const isSports   = /win|championship|superbowl|nba|nfl|mlb|nhl|world cup|final|score/.test(q);
  const isTech     = /ipo|launch|release|acquire|merger|apple|google|microsoft|amazon|tesla/.test(q);

  // ── Volume tiers ── (treat 0 as medium - volume may not always be passed)
  const highVol = vol > 1000000;
  const medVol  = vol > 50000 || vol === 0; // default to medium if unknown
  const volLabel = highVol ? `$${(vol/1e6).toFixed(1)}M` : vol > 1000 ? `$${(vol/1000).toFixed(0)}K` : 'unknown';

  const catLabel = isCrypto ? 'Crypto' : isPolitics ? 'Politics' : isSports ? 'Sports' : isTech ? 'Tech' : 'General';

  // ── Price-based signals ──
  const yesPrice = outcomes && outcomes.length > 0 ? parseFloat(outcomes[0].price_yes) || 0.5 : 0.5;
  const noPrice  = 1 - yesPrice;
  const strongYes = yesPrice >= 0.70;
  const strongNo  = yesPrice <= 0.30;
  const leanYes   = yesPrice >= 0.55 && yesPrice < 0.70;
  const leanNo    = yesPrice <= 0.45 && yesPrice > 0.30;

  if (strongYes) {
    rec = 'YES';
    confidence = Math.min(Math.round(55 + yesPrice * 30), 85);
    reasoning = 'Market pricing YES at ' + Math.round(yesPrice*100) + '% — strong consensus. ' + catLabel + ' market, ' + volLabel + ' volume. High-conviction setup: informed buyers dominate. Follow the smart money.';
    size = vol > 500000 ? 60 : vol > 100000 ? 40 : 25;
  } else if (strongNo) {
    rec = 'NO';
    confidence = Math.min(Math.round(55 + noPrice * 30), 85);
    reasoning = 'Market pricing YES at only ' + Math.round(yesPrice*100) + '% — overwhelmingly NO. ' + catLabel + ' market, ' + volLabel + ' volume. Strong NO signal from price action.';
    size = vol > 500000 ? 60 : vol > 100000 ? 40 : 25;
  } else if (leanYes) {
    rec = 'YES';
    confidence = Math.min(Math.round(52 + yesPrice * 20), 85);
    reasoning = 'Market pricing YES at ' + Math.round(yesPrice*100) + '% — leaning positive. ' + catLabel + ' market, ' + volLabel + ' volume. Modest edge detected. Size conservatively.';
    size = vol > 500000 ? 35 : vol > 100000 ? 20 : 10;
  } else if (leanNo) {
    rec = 'NO';
    confidence = Math.min(Math.round(52 + noPrice * 20), 85);
    reasoning = 'Market pricing YES at ' + Math.round(yesPrice*100) + '% — leaning negative. ' + catLabel + ' market, ' + volLabel + ' volume. Slight edge on NO side. Keep position small.';
    size = vol > 500000 ? 35 : vol > 100000 ? 20 : 10;
  } else {
    rec = 'SKIP';
    confidence = 50;
    reasoning = 'Market at ' + Math.round(yesPrice*100) + '% YES — essentially a coin flip. No edge at current pricing. ' + catLabel + ' market, ' + volLabel + ' volume. Wait for odds to move.';
    size = 0;
  }

  // unused branch placeholder
  if (false) { const isCrypto2 = false;
  }

  // Cap confidence at 85
  confidence = Math.min(confidence, 85);

  res.json({
    analysis: { recommendation: rec, confidence, reasoning, suggested_size: size },
    powered_by: 'ponemarket-ai'
  });
});

// ── BANKR AGENT PROMPT ───────────────────────────────────────────────────────
// Full agentic Bankr: bisa execute Polymarket trades on-chain
app.post('/v1/ai/agent', requireAgent, async (req, res) => {
  const { prompt } = req.body;
  if (!BANKR_KEY) return res.status(503).json({ error: 'Bankr agent not configured' });

  try {
    const r = await fetch(`${BANKR_API}/agent/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': BANKR_KEY,
      },
      body: JSON.stringify({ prompt, context: 'polymarket prediction market trading' }),
    });
    const data = await r.json();
    res.json({ response: data, powered_by: 'bankr-agent' });
  } catch (e) {
    res.status(502).json({ error: 'Bankr agent error', detail: e.message });
  }
});

// ── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ── START ─────────────────────────────────────────────────────────────────────
initDB().catch(console.error);
app.listen(PORT, () => {
  console.log(`🚀 PoneMarket backend running on port ${PORT}`);
  console.log(`🤖 Bankr: ${BANKR_KEY ? '✅ connected' : '❌ not configured'}`);
  console.log(`🧠 Bankr LLM: ${BANKR_LLM_KEY ? '✅ connected' : BANKR_KEY ? '⚠ using main key' : '❌ not configured'}`);
});
