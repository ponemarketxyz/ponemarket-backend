const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const BANKR_KEY     = process.env.BANKR_API_KEY;
const BANKR_LLM_KEY = process.env.BANKR_LLM_KEY;
const POLYMARKET    = 'https://gamma-api.polymarket.com';
const BANKR_API     = 'https://api.bankr.bot';
const BANKR_LLM     = 'https://llm.bankr.bot';

// In-memory stores (persisted to /tmp between restarts)
const agents = new Map();
const orders = [];

// ── PERSISTENCE ──────────────────────────────────────────────────────────────
const DATA_FILE = path.join('/tmp', 'ponemarket_data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw.agents) for (const [k,v] of Object.entries(raw.agents)) agents.set(k,v);
      if (raw.orders) orders.push(...raw.orders);
      console.log(`📦 Loaded ${agents.size} agents, ${orders.length} orders from disk`);
    }
  } catch(e) { console.warn('Could not load data:', e.message); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ agents: Object.fromEntries(agents), orders, saved_at: new Date().toISOString() }), 'utf8');
  } catch(e) { console.warn('Could not save data:', e.message); }
}

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

app.post('/v1/orders', requireAgent, (req, res) => {
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
  orders.push(order);
  saveData();

  res.status(201).json({ ...order, shares_received: order.shares });
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
  const myOrders = orders.filter(o => o.agent_id === req.agent.id && o.status === 'filled');
  const totalSpent = myOrders.reduce((s, o) => s + o.amount, 0);
  res.json({
    balance_usdc: parseFloat(req.agent.balance.toFixed(2)),
    total_pnl: parseFloat((req.agent.pnl || 0).toFixed(2)),
    total_trades: req.agent.trades || 0,
    win_rate: req.agent.win_rate || 0,
    bankr_wallet: req.agent.bankr_wallet,
    total_invested: parseFloat(totalSpent.toFixed(2)),
  });
});

app.get('/v1/portfolio/positions', requireAgent, (req, res) => {
  const positions = orders
    .filter(o => o.agent_id === req.agent.id && o.status === 'filled')
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

app.get('/v1/portfolio/history', requireAgent, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const trades = orders
    .filter(o => o.agent_id === req.agent.id)
    .slice(-limit)
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

// ── START ─────────────────────────────────────────────────────────────────────
loadData();
app.listen(PORT, () => {
  console.log(`🚀 PoneMarket backend running on port ${PORT}`);
  console.log(`🤖 Bankr: ${BANKR_KEY ? '✅ connected' : '❌ not configured'}`);
  console.log(`🧠 Bankr LLM: ${BANKR_LLM_KEY ? '✅ connected' : BANKR_KEY ? '⚠ using main key' : '❌ not configured'}`);
});
