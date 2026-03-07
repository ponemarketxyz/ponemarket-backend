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
    if (!marketsCache || Date.now() - marketsCacheTs > 30_000) {
      const r = await fetch(`${POLYMARKET}/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false`);
      const raw = await r.json();
      // Normalize to our format with real prices
      marketsCache = raw.map(m => {
        const outcomes = m.tokens ? m.tokens.map(t => ({
          label: t.outcome,
          price_yes: parseFloat(t.price) || 0.5,
          price_no: 1 - (parseFloat(t.price) || 0.5),
        })) : [];
        return {
          id: m.id || m.conditionId,
          title: m.question || m.title,
          category: m.category || 'other',
          tags: m.tags || [],
          volume: parseFloat(m.volume) || parseFloat(m.volume24hr) || 0,
          volume_24h: parseFloat(m.volume24hr) || 0,
          closes_at: m.endDate || m.endDateIso,
          outcomes,
          active: m.active,
          image: m.image,
        };
      }).filter(m => m.title && m.active !== false);
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
  const yesSignals = ['will','win','pass','approve','succeed','launch','above','reach','increase','rise','gain','confirm','sign','declare','announce','beat','exceed','complete','achieve'];
  const noSignals  = ['fail','lose','reject','below','crash','ban','block','decline','drop','miss','cancel','delay','collapse','impeach','resign','suspend'];
  const skipSignals = ['predict','guess','exactly','precise','specific number','how many'];

  const yesScore = yesSignals.filter(k => q.includes(k)).length;
  const noScore  = noSignals.filter(k => q.includes(k)).length;
  const skipScore = skipSignals.filter(k => q.includes(k)).length;

  // ── Category detection ──
  const isCrypto   = /bitcoin|btc|eth|ethereum|crypto|sol|doge|coin/.test(q);
  const isPolitics = /election|president|congress|senate|vote|trump|biden|party|democrat|republican/.test(q);
  const isSports   = /win|championship|superbowl|nba|nfl|mlb|nhl|world cup|final|score/.test(q);
  const isTech     = /ipo|launch|release|acquire|merger|apple|google|microsoft|amazon|tesla/.test(q);

  // ── Volume tiers ── (treat 0 as medium - volume may not always be passed)
  const highVol = vol > 1000000;
  const medVol  = vol > 50000 || vol === 0; // default to medium if unknown
  const volLabel = highVol ? `$${(vol/1e6).toFixed(1)}M` : vol > 1000 ? `$${(vol/1000).toFixed(0)}K` : 'unknown';

  if (skipScore > 0) {
    rec = 'SKIP'; confidence = 48;
    reasoning = `This market asks for a precise prediction that's highly uncertain. Expected value is negative — pass.`;
    size = 0;
  } else if (isCrypto) {
    if (yesScore >= noScore) {
      rec = 'YES'; confidence = highVol ? 63 : 56;
      reasoning = `Crypto market with bullish framing. ${highVol ? 'High liquidity ($'+volLabel+') supports price discovery.' : 'Moderate volume.'} Crypto tends to overshoot expectations in bull cycles.`;
      size = highVol ? 50 : 25;
    } else {
      rec = 'NO'; confidence = highVol ? 61 : 54;
      reasoning = `Crypto market with bearish framing. ${highVol ? 'High volume ($'+volLabel+') suggests strong consensus.' : 'Low liquidity adds risk.'} Downside targets often hit faster than expected.`;
      size = highVol ? 40 : 20;
    }
  } else if (isPolitics) {
    if (yesScore > noScore + 1) {
      rec = 'YES'; confidence = highVol ? 67 : 58;
      reasoning = `Political market with strong YES signals. ${highVol ? 'Volume ($'+volLabel+') indicates high market conviction.' : ''} Incumbency and momentum favor the leading outcome.`;
      size = highVol ? 45 : 20;
    } else if (noScore > yesScore + 1) {
      rec = 'NO'; confidence = highVol ? 65 : 57;
      reasoning = `Political market with strong NO signals. ${highVol ? 'Heavy trading ($'+volLabel+') signals informed sellers.' : ''} Political outcomes rarely deviate from polling consensus.`;
      size = highVol ? 45 : 20;
    } else {
      rec = 'SKIP'; confidence = 52;
      reasoning = `Political market with mixed signals. Too close to call — current odds of ~50% offer no edge. Avoid.`;
      size = 0;
    }
  } else if (isSports) {
    const edge = Math.abs(yesScore - noScore);
    if (edge >= 2) {
      rec = yesScore > noScore ? 'YES' : 'NO';
      confidence = 61 + edge * 3;
      reasoning = `Sports market with ${rec === 'YES' ? 'strong favorite signals' : 'underdog scenario'}. ${medVol ? 'Decent liquidity ($'+volLabel+').' : 'Low volume — size down.'} Historical win rates support this call.`;
      size = medVol ? 35 : 15;
    } else {
      rec = 'SKIP'; confidence = 50;
      reasoning = `Sports market too close to call at current odds. Coin-flip probabilities offer no positive expected value.`;
      size = 0;
    }
  } else if (isTech) {
    rec = yesScore >= noScore ? 'YES' : 'NO';
    confidence = highVol ? 64 : medVol ? 58 : 52;
    reasoning = `Tech/business market. ${rec === 'YES' ? 'Positive catalysts detected — companies tend to execute on announced plans.' : 'Risk factors detected — execution risk is high in tech.'} ${highVol ? 'Strong volume ($'+volLabel+') confirms market attention.' : ''}`;
    size = highVol ? 40 : medVol ? 25 : 10;
  } else {
    // General market
    if (yesScore > noScore) {
      rec = 'YES'; confidence = medVol ? 59 : 53;
      reasoning = `Market framing suggests positive outcome more likely. ${medVol ? 'Sufficient volume ($'+volLabel+') for reliable price signal.' : 'Low volume — proceed with caution.'} Base rates favor the YES side here.`;
      size = medVol ? 30 : 10;
    } else if (noScore > yesScore) {
      rec = 'NO'; confidence = medVol ? 58 : 52;
      reasoning = `Market framing suggests negative outcome more likely. ${medVol ? 'Volume ($'+volLabel+') supports this thesis.' : 'Thin market — small position only.'} NO has better risk/reward at current pricing.`;
      size = medVol ? 30 : 10;
    } else {
      rec = 'SKIP'; confidence = 50;
      reasoning = `No clear edge detected in either direction. At 50/50 odds, expected value is zero. Wait for a better setup.`;
      size = 0;
    }
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
app.listen(PORT, () => {
  console.log(`🚀 PoneMarket backend running on port ${PORT}`);
  console.log(`🤖 Bankr: ${BANKR_KEY ? '✅ connected' : '❌ not configured'}`);
  console.log(`🧠 Bankr LLM: ${BANKR_LLM_KEY ? '✅ connected' : BANKR_KEY ? '⚠ using main key' : '❌ not configured'}`);
});
