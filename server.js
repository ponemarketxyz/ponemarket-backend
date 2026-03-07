const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const BANKR_KEY     = process.env.BANKR_API_KEY;          // bk_...
const BANKR_LLM_KEY = process.env.BANKR_LLM_KEY;          // jika beda key untuk LLM
const POLYMARKET    = 'https://gamma-api.polymarket.com';
const BANKR_API     = 'https://api.bankr.bot';
const BANKR_LLM     = 'https://llm.bankr.bot';

// In-memory agent store (ganti dengan DB di production)
const agents = new Map();

// ── HELPER ───────────────────────────────────────────────────────────────────
function authHeader(req) {
  return req.headers['authorization'] || '';
}

function getAgentKey(req) {
  const h = authHeader(req);
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireAgent(req, res, next) {
  const key = getAgentKey(req);
  if (!key || !agents.has(key)) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  req.agent = agents.get(key);
  next();
}

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
    if (!marketsCache || Date.now() - marketsCacheTs > 60_000) {
      const r = await fetch(`${POLYMARKET}/markets?limit=100&active=true`);
      marketsCache = await r.json();
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

  agents.set(apiKey, agent);

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
app.post('/v1/agents/webhook', requireAgent, (req, res) => {
  const { webhook_url } = req.body;
  req.agent.webhook_url = webhook_url;
  res.json({ message: 'Webhook updated', webhook_url });
});

// ── ORDERS ───────────────────────────────────────────────────────────────────
const orders = [];

app.post('/v1/orders', requireAgent, (req, res) => {
  const { market_id, outcome_id, side, amount } = req.body;
  if (!market_id || !side || !amount) {
    return res.status(400).json({ error: 'market_id, side, amount required' });
  }

  const price = Math.random() * 0.4 + 0.3; // mock price 30-70%
  const shares = amount / price;
  const order = {
    id: 'ord_' + Date.now(),
    agent_id: req.agent.id,
    market_id, outcome_id,
    side, amount,
    price: parseFloat(price.toFixed(4)),
    shares: parseFloat(shares.toFixed(2)),
    potential_payout: parseFloat((shares).toFixed(2)),
    status: 'filled',
    created_at: new Date().toISOString(),
  };

  req.agent.balance -= amount;
  req.agent.trades++;
  orders.push(order);

  res.status(201).json(order);
});

app.get('/v1/orders', requireAgent, (req, res) => {
  const myOrders = orders.filter(o => o.agent_id === req.agent.id);
  res.json({ orders: myOrders, count: myOrders.length });
});

app.delete('/v1/orders/:id', requireAgent, (req, res) => {
  const idx = orders.findIndex(o => o.id === req.params.id && o.agent_id === req.agent.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  orders.splice(idx, 1);
  res.json({ message: 'Order cancelled' });
});

// ── PORTFOLIO ────────────────────────────────────────────────────────────────
app.get('/v1/portfolio', requireAgent, (req, res) => {
  res.json({
    balance: req.agent.balance,
    pnl: req.agent.pnl,
    trades: req.agent.trades,
    win_rate: req.agent.win_rate,
    bankr_wallet: req.agent.bankr_wallet,
  });
});

app.get('/v1/portfolio/positions', requireAgent, (req, res) => {
  const positions = orders
    .filter(o => o.agent_id === req.agent.id && o.status === 'filled')
    .map(o => ({
      market_id: o.market_id,
      side: o.side,
      shares: o.shares,
      avg_price: o.price,
      current_price: parseFloat((Math.random() * 0.4 + 0.3).toFixed(4)),
      unrealized_pnl: parseFloat(((Math.random() - 0.5) * 20).toFixed(2)),
    }));
  res.json({ positions, count: positions.length });
});

app.get('/v1/portfolio/history', requireAgent, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = orders
    .filter(o => o.agent_id === req.agent.id)
    .slice(-limit)
    .reverse();
  res.json({ history, count: history.length });
});

// ── LEADERBOARD ──────────────────────────────────────────────────────────────
app.get('/v1/leaderboard', (req, res) => {
  const board = [...agents.values()]
    .sort((a, b) => b.balance - a.balance)
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

// ── BANKR AI ANALYSIS ────────────────────────────────────────────────────────
// Endpoint khusus: minta Bankr LLM analisa market → kasih rekomendasi
app.post('/v1/ai/analyze', async (req, res) => {
  const { market_question, outcomes, volume } = req.body;

  if (!BANKR_LLM_KEY && !BANKR_KEY) {
    return res.status(503).json({ error: 'Bankr LLM not configured' });
  }

  const prompt = `You are a prediction market analyst. Analyze this market and give a trading recommendation.

Market: ${market_question}
Outcomes: ${JSON.stringify(outcomes)}
Volume: $${volume || 'unknown'}

Respond in JSON: { "recommendation": "YES"|"NO"|"SKIP", "confidence": 0-100, "reasoning": "...", "suggested_size": 10-100 }`;

  try {
    const r = await fetch(`${BANKR_LLM}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BANKR_LLM_KEY || BANKR_KEY}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await r.json();
    const text = data.content?.[0]?.text || data.choices?.[0]?.message?.content || '{}';

    let analysis;
    try { analysis = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { analysis = { raw: text }; }

    res.json({ analysis, model: 'claude-sonnet-4', powered_by: 'bankr' });
  } catch (e) {
    res.status(502).json({ error: 'Bankr LLM error', detail: e.message });
  }
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

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 PoneMarket backend running on port ${PORT}`);
  console.log(`🤖 Bankr: ${BANKR_KEY ? '✅ connected' : '❌ not configured'}`);
  console.log(`🧠 Bankr LLM: ${BANKR_LLM_KEY ? '✅ connected' : BANKR_KEY ? '⚠ using main key' : '❌ not configured'}`);
});
