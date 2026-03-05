const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(cors({ origin:'*', methods:['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

const apiKey = () => 'pm_live_' + crypto.randomBytes(20).toString('hex');

const auth = (req, res, next) => {
  const h = req.headers['authorization'];
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error:{ code:401, type:'UNAUTHORIZED', message:'Missing Authorization header.' }});
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(h.split(' ')[1]);
  if (!agent) return res.status(401).json({ error:{ code:401, type:'UNAUTHORIZED', message:'Invalid API key.' }});
  req.agent = agent;
  next();
};

const getMarket = (id) => {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(id);
  if (!m) return null;
  m.outcomes = db.prepare('SELECT * FROM outcomes WHERE market_id = ?').all(id);
  return m;
};

// Add wallet_address column if missing
try { db.prepare('ALTER TABLE agents ADD COLUMN wallet_address TEXT').run(); } catch(e) {}

app.get('/', (req, res) => {
  res.json({ name:'PoneMarket API', version:'2.0.0', mode:'live',
    markets: db.prepare('SELECT COUNT(*) as c FROM markets').get().c,
    agents:  db.prepare('SELECT COUNT(*) as c FROM agents').get().c });
});

app.post('/v1/agents/register', (req, res) => {
  const { name, provider, strategy, starting_balance, webhook_url } = req.body;
  if (!name || !provider) return res.status(400).json({ error:{ code:400, type:'BAD_REQUEST', message:'name and provider required.' }});
  if (!['anthropic','openai','google','custom'].includes(provider))
    return res.status(400).json({ error:{ code:400, type:'INVALID_PROVIDER', message:'provider must be: anthropic, openai, google, or custom.' }});
  const id = 'agent_' + uuidv4().split('-')[0];
  const key = apiKey();
  db.prepare('INSERT INTO agents (id,name,api_key,provider,strategy,balance,webhook_url,status) VALUES (?,?,?,?,?,?,?,?)').run(id,name,key,provider,strategy||'',0,webhook_url||null,'active');
  res.status(201).json({ agent_id:id, name, provider, api_key:key, balance_usdc:0, created_at:new Date().toISOString(), message:'Save your api_key — shown only once. Deposit USDC to start trading.' });
});

app.get('/v1/agents/me', auth, (req, res) => {
  const a = req.agent;
  const fresh = db.prepare('SELECT balance FROM agents WHERE id = ?').get(a.id);
  const stats = db.prepare('SELECT COUNT(*) as t, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as w, SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as p FROM orders WHERE agent_id=?').get(a.id);
  const rank  = db.prepare('SELECT id FROM agents ORDER BY balance DESC').all().findIndex(x=>x.id===a.id)+1;
  res.json({ agent_id:a.id, name:a.name, provider:a.provider, strategy:a.strategy, status:a.status, balance_usdc:+fresh.balance.toFixed(2), total_pnl:+(stats.p||0).toFixed(2), total_trades:stats.t||0, win_rate:stats.t?+(stats.w/stats.t).toFixed(2):null, leaderboard_rank:rank });
});

// On-chain deposit sync
app.post('/v1/wallet/sync', auth, (req, res) => {
  const { amount, wallet, tx } = req.body;
  if (!amount || +amount <= 0) return res.status(400).json({ error:{ code:400, type:'BAD_REQUEST', message:'amount required.' }});
  db.prepare('UPDATE agents SET balance = balance + ?, wallet_address = ? WHERE id = ?').run(+amount, wallet||null, req.agent.id);
  const b = db.prepare('SELECT balance FROM agents WHERE id = ?').get(req.agent.id);
  res.json({ success:true, amount_added:+amount, new_balance:+b.balance.toFixed(2), tx });
});

app.get('/v1/markets', auth, (req, res) => {
  let { category, status='active', limit=20, offset=0, sort='volume' } = req.query;
  limit=Math.min(+limit,100); offset=+offset;
  let markets = db.prepare('SELECT * FROM markets').all().map(m=>{m.outcomes=db.prepare('SELECT * FROM outcomes WHERE market_id=?').all(m.id);return m;});
  if (status!=='all') markets=markets.filter(m=>m.status===status);
  if (category) markets=markets.filter(m=>m.category===category);
  if (sort==='volume') markets.sort((a,b)=>b.volume-a.volume);
  else if (sort==='newest') markets.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  else if (sort==='closing_soon') markets.sort((a,b)=>new Date(a.closes_at)-new Date(b.closes_at));
  res.json({ markets:markets.slice(offset,offset+limit), total:markets.length, limit, offset });
});

app.get('/v1/markets/:id', auth, (req, res) => {
  const m = getMarket(req.params.id);
  if (!m) return res.status(404).json({ error:{ code:404, type:'NOT_FOUND', message:'Market not found.' }});
  res.json(m);
});

app.post('/v1/orders', auth, (req, res) => {
  const { market_id, outcome_id, side, amount, type='market' } = req.body;
  const a = req.agent;
  if (!market_id||!outcome_id||!side||!amount) return res.status(400).json({ error:{ code:400, type:'BAD_REQUEST', message:'market_id, outcome_id, side, amount required.' }});
  if (!['yes','no'].includes(side)) return res.status(400).json({ error:{ code:400, type:'INVALID_SIDE', message:'side must be yes or no.' }});
  if (+amount<1) return res.status(400).json({ error:{ code:400, type:'INVALID_AMOUNT', message:'Minimum 1 USDC.' }});
  const m = getMarket(market_id);
  if (!m) return res.status(404).json({ error:{ code:404, type:'NOT_FOUND', message:'Market not found.' }});
  if (m.status!=='active') return res.status(422).json({ error:{ code:422, type:'MARKET_CLOSED', message:'Market already resolved.' }});
  const out = m.outcomes.find(o=>o.id===outcome_id);
  if (!out) return res.status(404).json({ error:{ code:404, type:'NOT_FOUND', message:'Outcome not found.' }});

  // Check real balance from DB
  const fresh = db.prepare('SELECT balance FROM agents WHERE id=?').get(a.id);
  if (fresh.balance < +amount) return res.status(403).json({ error:{ code:403, type:'INSUFFICIENT_BALANCE', message:`Balance: $${fresh.balance.toFixed(2)} USDC. Deposit more USDC to continue trading.` }});

  const fee=+(+amount*0.02).toFixed(4);
  const price=side==='yes'?out.price_yes:out.price_no;
  const shares=+((+amount-fee)/price).toFixed(4);
  const oid='ord_'+uuidv4().split('-')[0];

  db.transaction(()=>{
    db.prepare('UPDATE agents SET balance=balance-? WHERE id=?').run(+amount,a.id);
    db.prepare('UPDATE markets SET volume=volume+? WHERE id=?').run(+amount,market_id);
    const d=Math.min(+amount/50000,0.05);
    const ny=side==='yes'?Math.min(0.99,+(out.price_yes+d).toFixed(4)):Math.max(0.01,+(out.price_yes-d).toFixed(4));
    db.prepare('UPDATE outcomes SET price_yes=?,price_no=? WHERE id=?').run(ny,+(1-ny).toFixed(4),outcome_id);
    db.prepare('INSERT INTO orders (id,agent_id,market_id,outcome_id,side,type,amount,shares,avg_price,fee,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(oid,a.id,market_id,outcome_id,side,type,+amount,shares,+price.toFixed(4),fee,'filled');
  })();

  res.status(201).json({ order_id:oid, agent_id:a.id, market_id, market_title:m.title, outcome_id, outcome_label:out.label, side, amount_spent:+amount, shares_received:shares, avg_price:+price.toFixed(4), fee, potential_payout:+shares.toFixed(4), type, status:'filled', pnl:null, result:null, timestamp:new Date().toISOString() });
});

app.get('/v1/orders', auth, (req, res) => {
  let { status, market_id, limit=50, offset=0 } = req.query;
  limit=Math.min(+limit,200); offset=+offset;
  let q='SELECT o.*,m.title as market_title,oc.label as outcome_label FROM orders o JOIN markets m ON o.market_id=m.id JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.agent_id=?';
  const p=[req.agent.id];
  if (status&&status!=='all'){q+=' AND o.status=?';p.push(status);}
  if (market_id){q+=' AND o.market_id=?';p.push(market_id);}
  q+=' ORDER BY o.created_at DESC LIMIT ? OFFSET ?'; p.push(limit,offset);
  const orders=db.prepare(q).all(...p);
  const total=db.prepare('SELECT COUNT(*) as c FROM orders WHERE agent_id=?').get(req.agent.id).c;
  res.json({orders,total});
});

app.post('/v1/orders/sell', auth, (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error:{ code:400, type:'BAD_REQUEST', message:'order_id required.' }});
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
  if (!o) return res.status(404).json({ error:{ code:404, type:'NOT_FOUND', message:'Order not found.' }});
  if (o.agent_id!==req.agent.id) return res.status(403).json({ error:{ code:403, type:'FORBIDDEN', message:'Not your order.' }});
  if (o.pnl!==null) return res.status(422).json({ error:{ code:422, type:'ALREADY_CLOSED', message:'Position already closed.' }});
  const out=db.prepare('SELECT * FROM outcomes WHERE id=?').get(o.outcome_id);
  const cp=o.side==='yes'?out.price_yes:out.price_no;
  const payout=+(o.shares*cp).toFixed(4);
  const fee=+(payout*0.02).toFixed(4);
  const net=+(payout-fee).toFixed(4);
  const pnl=+(net-o.amount).toFixed(4);
  db.transaction(()=>{
    db.prepare('UPDATE agents SET balance=balance+? WHERE id=?').run(net,req.agent.id);
    db.prepare('UPDATE orders SET pnl=?,result=?,payout=?,status=?,resolved_at=? WHERE id=?').run(pnl,pnl>0?'won':'lost',net,'closed',new Date().toISOString(),order_id);
  })();
  const b=db.prepare('SELECT balance FROM agents WHERE id=?').get(req.agent.id);
  res.json({order_id,shares_sold:o.shares,sell_price:cp,payout:net,fee,pnl,new_balance:+b.balance.toFixed(2)});
});

app.get('/v1/portfolio', auth, (req, res) => {
  const fresh=db.prepare('SELECT balance FROM agents WHERE id=?').get(req.agent.id);
  const stats=db.prepare('SELECT COUNT(*) as t,SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as w,SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as p,SUM(CASE WHEN pnl IS NULL THEN 1 ELSE 0 END) as op FROM orders WHERE agent_id=?').get(req.agent.id);
  const rank=db.prepare('SELECT id FROM agents ORDER BY balance DESC').all().findIndex(x=>x.id===req.agent.id)+1;
  res.json({agent_id:req.agent.id,balance_usdc:+fresh.balance.toFixed(2),total_pnl:+(stats.p||0).toFixed(2),total_trades:stats.t||0,open_positions:stats.op||0,leaderboard_rank:rank});
});

app.get('/v1/portfolio/positions', auth, (req, res) => {
  const rows=db.prepare('SELECT o.*,m.title as market_title,oc.label as outcome_label,oc.price_yes,oc.price_no FROM orders o JOIN markets m ON o.market_id=m.id JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.agent_id=? AND o.pnl IS NULL AND o.status=\'filled\' ORDER BY o.created_at DESC').all(req.agent.id);
  const positions=rows.map(p=>({order_id:p.id,market_id:p.market_id,market_title:p.market_title,outcome_label:p.outcome_label,side:p.side,shares:p.shares,avg_entry_price:p.avg_price,current_price:+(p.side==='yes'?p.price_yes:p.price_no).toFixed(4),unrealized_pnl:+(p.shares*(p.side==='yes'?p.price_yes:p.price_no)-p.amount).toFixed(2),potential_payout:+p.shares.toFixed(4)}));
  res.json({positions,total:positions.length});
});

app.get('/v1/portfolio/history', auth, (req, res) => {
  const limit=Math.min(+(req.query.limit||20),100);
  const trades=db.prepare('SELECT o.*,m.title as market_title,oc.label as outcome_label FROM orders o JOIN markets m ON o.market_id=m.id JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.agent_id=? AND o.pnl IS NOT NULL ORDER BY o.resolved_at DESC LIMIT ?').all(req.agent.id,limit);
  res.json({trades,total:trades.length});
});

app.get('/v1/leaderboard', auth, (req, res) => {
  const limit=Math.min(+(req.query.limit||20),100);
  const board=db.prepare('SELECT a.id as agent_id,a.name,a.provider,a.balance,COUNT(o.id) as t,SUM(CASE WHEN o.pnl>0 THEN 1 ELSE 0 END) as w,SUM(CASE WHEN o.pnl IS NOT NULL THEN o.pnl ELSE 0 END) as p FROM agents a LEFT JOIN orders o ON a.id=o.agent_id GROUP BY a.id ORDER BY p DESC LIMIT ?').all(limit);
  res.json({leaderboard:board.map((a,i)=>({rank:i+1,agent_id:a.agent_id,name:a.name,provider:a.provider,balance_usdc:+a.balance.toFixed(2),total_pnl:+(a.p||0).toFixed(2),win_rate:a.t?+(a.w/a.t).toFixed(2):null,total_trades:a.t||0}))});
});

app.post('/v1/admin/resolve', (req, res) => {
  const{admin_key,market_id,winning_outcome_id}=req.body;
  if(admin_key!==(process.env.ADMIN_KEY||'ponemarket_admin_2026')) return res.status(403).json({error:{code:403,type:'FORBIDDEN',message:'Invalid admin key.'}});
  const m=db.prepare('SELECT * FROM markets WHERE id=?').get(market_id);
  if(!m) return res.status(404).json({error:{code:404,type:'NOT_FOUND',message:'Market not found.'}});
  const orders=db.prepare('SELECT * FROM orders WHERE market_id=? AND pnl IS NULL').all(market_id);
  db.transaction(()=>{
    db.prepare('UPDATE markets SET status=?,resolved_at=? WHERE id=?').run('resolved',new Date().toISOString(),market_id);
    for(const o of orders){
      const won=(o.outcome_id===winning_outcome_id&&o.side==='yes')||(o.outcome_id!==winning_outcome_id&&o.side==='no');
      const payout=won?o.shares:0;
      const pnl=+(payout-o.amount).toFixed(4);
      db.prepare('UPDATE orders SET pnl=?,result=?,payout=?,status=?,resolved_at=? WHERE id=?').run(pnl,won?'won':'lost',payout,'closed',new Date().toISOString(),o.id);
      if(payout>0) db.prepare('UPDATE agents SET balance=balance+? WHERE id=?').run(payout,o.agent_id);
    }
  })();
  res.json({market_id,status:'resolved',winning_outcome_id,orders_resolved:orders.length});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`\n  PoneMarket API v2 → http://localhost:${PORT}\n  Mode: LIVE (SQLite + on-chain sync)\n`));
