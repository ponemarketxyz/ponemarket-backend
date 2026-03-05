const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin:'*', methods:['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      api_key      TEXT UNIQUE NOT NULL,
      provider     TEXT NOT NULL DEFAULT 'custom',
      strategy     TEXT,
      balance      REAL NOT NULL DEFAULT 0,
      total_pnl    REAL NOT NULL DEFAULT 0,
      total_trades INT  NOT NULL DEFAULT 0,
      wins         INT  NOT NULL DEFAULT 0,
      losses       INT  NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'active',
      wallet       TEXT,
      webhook_url  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS markets (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      category   TEXT NOT NULL,
      volume     REAL NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'active',
      closes_at  TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id         TEXT PRIMARY KEY,
      market_id  TEXT NOT NULL REFERENCES markets(id),
      label      TEXT NOT NULL,
      price_yes  REAL NOT NULL DEFAULT 0.5,
      price_no   REAL NOT NULL DEFAULT 0.5
    );
    CREATE TABLE IF NOT EXISTS synced_txs (
      tx        TEXT PRIMARY KEY,
      agent_id  TEXT NOT NULL,
      amount    REAL NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id),
      market_id    TEXT NOT NULL REFERENCES markets(id),
      outcome_id   TEXT NOT NULL REFERENCES outcomes(id),
      side         TEXT NOT NULL,
      amount_spent REAL NOT NULL,
      shares       REAL NOT NULL,
      avg_price    REAL NOT NULL,
      fee          REAL NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'filled',
      pnl          REAL,
      result       TEXT,
      payout       REAL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at    TIMESTAMPTZ
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM markets');
  if (rows[0].c === '0') {
    const SEED = [
      {id:'mkt_gov_shutdown',title:'How long will the Government Shutdown last?',category:'politics',closes_at:'2026-03-14T23:59:59Z',outcomes:[{id:'out_5d',label:'5+ days',py:0.21},{id:'out_6d',label:'6+ days',py:0.07}]},
      {id:'mkt_btc_feb',title:'What price will Bitcoin hit in February?',category:'crypto',closes_at:'2026-02-28T23:59:59Z',outcomes:[{id:'out_95k',label:'↑ $95,000',py:0.12},{id:'out_90k',label:'↑ $90,000',py:0.26}]},
      {id:'mkt_fed',title:'Fed decision in March?',category:'finance',closes_at:'2026-03-20T23:59:59Z',outcomes:[{id:'out_cut',label:'Rate Cut',py:0.08},{id:'out_hold',label:'Hold',py:0.87}]},
      {id:'mkt_ukraine',title:'Russia × Ukraine ceasefire by end of 2026?',category:'geopolitics',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_yes',label:'Yes',py:0.46}]},
      {id:'mkt_oscars',title:'Oscars 2026: Best Picture Winner?',category:'culture',closes_at:'2026-03-28T23:59:59Z',outcomes:[{id:'out_conclave',label:'Conclave',py:0.69},{id:'out_emilia',label:'Emilia Pérez',py:0.18}]},
      {id:'mkt_giannis',title:'Where will Giannis be traded?',category:'sports',closes_at:'2026-02-06T23:59:59Z',outcomes:[{id:'out_heat',label:'Miami Heat',py:0.34},{id:'out_warriors',label:'Golden State',py:0.22}]},
      {id:'mkt_greenland',title:'Will the US acquire part of Greenland in 2026?',category:'politics',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_yes2',label:'Yes',py:0.20}]},
      {id:'mkt_eth',title:'Will Ethereum reach $5,000 in 2025?',category:'crypto',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_eth_yes',label:'Yes',py:0.44}]},
      {id:'mkt_sp500',title:'Will the S&P 500 hit 7,000 in 2025?',category:'finance',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_sp_yes',label:'Yes',py:0.58}]},
      {id:'mkt_gpt5',title:'Will OpenAI release GPT-5 in 2025?',category:'tech',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_gpt_yes',label:'Yes',py:0.78}]},
      {id:'mkt_taiwan',title:'Will China invade Taiwan in 2025?',category:'geopolitics',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_tw_yes',label:'Yes',py:0.09}]},
      {id:'mkt_recession',title:'Will the US enter a recession in 2025?',category:'finance',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_rec_yes',label:'Yes',py:0.34}]},
      {id:'mkt_trump',title:'Will Trump be impeached in his second term?',category:'politics',closes_at:'2029-01-20T23:59:59Z',outcomes:[{id:'out_tr_yes',label:'Yes',py:0.12}]},
      {id:'mkt_doge',title:'Will DOGE cut $1 trillion from US federal spending?',category:'politics',closes_at:'2026-12-31T23:59:59Z',outcomes:[{id:'out_dg_yes',label:'Yes',py:0.29}]},
      {id:'mkt_agi',title:'Will AGI be achieved before 2030?',category:'tech',closes_at:'2029-12-31T23:59:59Z',outcomes:[{id:'out_agi_yes',label:'Yes',py:0.24}]},
    ];
    for (const m of SEED) {
      await pool.query('INSERT INTO markets (id,title,category,closes_at,volume) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [m.id,m.title,m.category,m.closes_at,Math.floor(Math.random()*50000000)+1000000]);
      for (const o of m.outcomes)
        await pool.query('INSERT INTO outcomes (id,market_id,label,price_yes,price_no) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [o.id,m.id,o.label,o.py,+(1-o.py).toFixed(2)]);
    }
    console.log('✅ Seeded markets');
  }
  console.log('✅ Database ready');
}

const apiKey = () => 'pm_live_' + crypto.randomBytes(20).toString('hex');
const auth = async (req,res,next) => {
  const h = req.headers['authorization'];
  if (!h?.startsWith('Bearer ')) return res.status(401).json({error:{code:401,type:'UNAUTHORIZED',message:'Missing Authorization header.'}});
  const {rows} = await pool.query('SELECT * FROM agents WHERE api_key=$1',[h.split(' ')[1]]);
  if (!rows[0]) return res.status(401).json({error:{code:401,type:'UNAUTHORIZED',message:'Invalid API key.'}});
  req.agent=rows[0]; next();
};

app.get('/', async (req,res) => {
  const m=await pool.query('SELECT COUNT(*) as c FROM markets');
  const a=await pool.query('SELECT COUNT(*) as c FROM agents');
  res.json({name:'PoneMarket API',version:'2.0.0',mode:'live',markets:+m.rows[0].c,agents:+a.rows[0].c});
});

app.post('/v1/agents/register', async (req,res) => {
  const {name,provider,strategy,webhook_url}=req.body;
  if (!name||!provider) return res.status(400).json({error:{code:400,type:'BAD_REQUEST',message:'name and provider required.'}});
  if (!['anthropic','openai','google','custom'].includes(provider)) return res.status(400).json({error:{code:400,type:'INVALID_PROVIDER',message:'provider must be: anthropic, openai, google, or custom.'}});
  const id=`agent_${uuidv4().split('-')[0]}`,key=apiKey();
  await pool.query('INSERT INTO agents (id,name,api_key,provider,strategy,balance,webhook_url) VALUES ($1,$2,$3,$4,$5,0,$6)',[id,name,key,provider,strategy||'',webhook_url||null]);
  res.status(201).json({agent_id:id,name,provider,api_key:key,balance_usdc:0,created_at:new Date().toISOString(),message:'Save your api_key — shown only once. Deposit USDC to start trading.'});
});

app.get('/v1/agents/me', auth, async (req,res) => {
  const a=req.agent;
  const rank=await pool.query('SELECT COUNT(*)+1 as r FROM agents WHERE total_pnl > $1',[a.total_pnl]);
  res.json({agent_id:a.id,name:a.name,provider:a.provider,strategy:a.strategy,status:a.status,balance_usdc:+a.balance.toFixed(2),total_pnl:+a.total_pnl.toFixed(2),total_trades:a.total_trades,win_rate:a.total_trades?+(a.wins/a.total_trades).toFixed(2):null,leaderboard_rank:+rank.rows[0].r});
});

app.post('/v1/wallet/sync', auth, async (req,res) => {
  const {amount,wallet,tx}=req.body;
  if (!amount||+amount<=0) return res.status(400).json({error:{code:400,type:'BAD_REQUEST',message:'amount required.'}});
  if (tx) {
    const {rows:ex}=await pool.query('SELECT tx FROM synced_txs WHERE tx=$1',[tx]);
    if (ex.length>0) {
      const {rows:[a]}=await pool.query('SELECT balance FROM agents WHERE id=$1',[req.agent.id]);
      return res.json({success:true,amount_added:0,new_balance:+a.balance.toFixed(2),tx,already_synced:true});
    }
    await pool.query('INSERT INTO synced_txs (tx,agent_id,amount) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[tx,req.agent.id,+amount]);
  }
  const {rows}=await pool.query('UPDATE agents SET balance=$1,wallet=$2 WHERE id=$3 RETURNING balance',[+amount,wallet||null,req.agent.id]);
  res.json({success:true,amount_added:+amount,new_balance:+rows[0].balance.toFixed(2),tx});
});

app.get('/v1/markets', async (req,res) => {
  let {category,status='active',limit=20,offset=0,sort='volume'}=req.query;
  limit=Math.min(+limit,100); offset=+offset;
  let q='SELECT * FROM markets WHERE 1=1'; const p=[];
  if (status!=='all'){q+=` AND status=$${p.length+1}`;p.push(status);}
  if (category){q+=` AND category=$${p.length+1}`;p.push(category);}
  if (sort==='volume') q+=' ORDER BY volume DESC';
  else if (sort==='newest') q+=' ORDER BY created_at DESC';
  else if (sort==='closing_soon') q+=' ORDER BY closes_at ASC';
  q+=` LIMIT $${p.length+1} OFFSET $${p.length+2}`;p.push(limit,offset);
  const {rows:markets}=await pool.query(q,p);
  for (const m of markets){const {rows:o}=await pool.query('SELECT * FROM outcomes WHERE market_id=$1',[m.id]);m.outcomes=o;}
  const total=await pool.query('SELECT COUNT(*) as c FROM markets',[]);
  res.json({markets,total:+total.rows[0].c,limit,offset});
});

app.get('/v1/markets/:id', auth, async (req,res) => {
  const {rows}=await pool.query('SELECT * FROM markets WHERE id=$1',[req.params.id]);
  if (!rows[0]) return res.status(404).json({error:{code:404,type:'NOT_FOUND',message:'Market not found.'}});
  const {rows:outcomes}=await pool.query('SELECT * FROM outcomes WHERE market_id=$1',[req.params.id]);
  res.json({...rows[0],outcomes});
});

app.post('/v1/orders', auth, async (req,res) => {
  const {market_id,outcome_id,side,amount,type='market'}=req.body;
  const a=req.agent;
  if (!market_id||!outcome_id||!side||!amount) return res.status(400).json({error:{code:400,type:'BAD_REQUEST',message:'market_id, outcome_id, side, amount required.'}});
  if (!['yes','no'].includes(side)) return res.status(400).json({error:{code:400,type:'INVALID_SIDE',message:'side must be yes or no.'}});
  if (+amount<1) return res.status(400).json({error:{code:400,type:'INVALID_AMOUNT',message:'Minimum 1 USDC.'}});
  const {rows:[m]}=await pool.query('SELECT * FROM markets WHERE id=$1',[market_id]);
  if (!m) return res.status(404).json({error:{code:404,type:'NOT_FOUND',message:'Market not found.'}});
  if (m.status!=='active') return res.status(422).json({error:{code:422,type:'MARKET_CLOSED',message:'Market already resolved.'}});
  const {rows:[out]}=await pool.query('SELECT * FROM outcomes WHERE id=$1',[outcome_id]);
  if (!out) return res.status(404).json({error:{code:404,type:'NOT_FOUND',message:'Outcome not found.'}});
  const {rows:[fresh]}=await pool.query('SELECT balance FROM agents WHERE id=$1',[a.id]);
  if (fresh.balance<+amount) return res.status(403).json({error:{code:403,type:'INSUFFICIENT_BALANCE',message:`Balance: $${fresh.balance.toFixed(2)} USDC. Deposit more USDC to continue.`}});
  const fee=+(+amount*0.02).toFixed(4),price=side==='yes'?out.price_yes:out.price_no,shares=+((+amount-fee)/price).toFixed(4);
  const oid=`ord_${uuidv4().split('-')[0]}`;
  const d=Math.min(+amount/50000,0.05),ny=side==='yes'?Math.min(0.99,+(+out.price_yes+d).toFixed(4)):Math.max(0.01,+(+out.price_yes-d).toFixed(4));
  await pool.query('BEGIN');
  await pool.query('UPDATE agents SET balance=balance-$1,total_trades=total_trades+1 WHERE id=$2',[+amount,a.id]);
  await pool.query('UPDATE markets SET volume=volume+$1 WHERE id=$2',[+amount,market_id]);
  await pool.query('UPDATE outcomes SET price_yes=$1,price_no=$2 WHERE id=$3',[ny,+(1-ny).toFixed(4),outcome_id]);
  const {rows:[order]}=await pool.query('INSERT INTO orders (id,agent_id,market_id,outcome_id,side,amount_spent,shares,avg_price,fee,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[oid,a.id,market_id,outcome_id,side,+amount,shares,+price.toFixed(4),fee,'filled']);
  await pool.query('COMMIT');
  res.status(201).json({order_id:order.id,agent_id:a.id,market_id,market_title:m.title,outcome_id,outcome_label:out.label,side,amount_spent:+amount,shares_received:shares,avg_price:+price.toFixed(4),fee,potential_payout:+shares.toFixed(4),type,status:'filled',pnl:null,result:null,timestamp:order.created_at});
});

app.get('/v1/orders', auth, async (req,res) => {
  let {status,market_id,limit=50,offset=0}=req.query;
  limit=Math.min(+limit,200); offset=+offset;
  let q='SELECT o.*,m.title as market_title,oc.label as outcome_label FROM orders o JOIN markets m ON o.market_id=m.id JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.agent_id=$1';
  const p=[req.agent.id];
  if (status&&status!=='all'){q+=` AND o.status=$${p.length+1}`;p.push(status);}
  if (market_id){q+=` AND o.market_id=$${p.length+1}`;p.push(market_id);}
  q+=` ORDER BY o.created_at DESC LIMIT $${p.length+1} OFFSET $${p.length+2}`;p.push(limit,offset);
  const {rows}=await pool.query(q,p);
  const total=await pool.query('SELECT COUNT(*) as c FROM orders WHERE agent_id=$1',[req.agent.id]);
  res.json({orders:rows.map(o=>({...o,order_id:o.id,shares_received:o.shares,timestamp:o.created_at})),total:+total.rows[0].c});
});

app.post('/v1/orders/sell', auth, async (req,res) => {
  const {order_id}=req.body;
  if (!order_id) return res.status(400).json({error:{code:400,type:'BAD_REQUEST',message:'order_id required.'}});
  const {rows:[o]}=await pool.query('SELECT o.*,oc.price_yes,oc.price_no FROM orders o JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.id=$1',[order_id]);
  if (!o) return res.status(404).json({error:{code:404,type:'NOT_FOUND',message:'Order not found.'}});
  if (o.agent_id!==req.agent.id) return res.status(403).json({error:{code:403,type:'FORBIDDEN',message:'Not your order.'}});
  if (o.pnl!==null) return res.status(422).json({error:{code:422,type:'ALREADY_CLOSED',message:'Position already closed.'}});
  const cp=o.side==='yes'?o.price_yes:o.price_no,payout=+(o.shares*cp).toFixed(4),fee=+(payout*0.02).toFixed(4),net=+(payout-fee).toFixed(4),pnl=+(net-o.amount_spent).toFixed(4);
  await pool.query('BEGIN');
  await pool.query('UPDATE agents SET balance=balance+$1,total_pnl=total_pnl+$2,wins=wins+$3,losses=losses+$4 WHERE id=$5',[net,pnl,pnl>0?1:0,pnl<=0?1:0,req.agent.id]);
  await pool.query('UPDATE orders SET pnl=$1,result=$2,payout=$3,status=$4,closed_at=NOW() WHERE id=$5',[pnl,pnl>0?'won':'lost',net,'closed',order_id]);
  await pool.query('COMMIT');
  const {rows:[b]}=await pool.query('SELECT balance FROM agents WHERE id=$1',[req.agent.id]);
  res.json({order_id,shares_sold:o.shares,sell_price:cp,payout:net,fee,pnl,new_balance:+b.balance.toFixed(2)});
});

app.get('/v1/portfolio', auth, async (req,res) => {
  const a=req.agent;
  const {rows:[fresh]}=await pool.query('SELECT balance,total_pnl,total_trades FROM agents WHERE id=$1',[a.id]);
  const {rows:[open]}=await pool.query('SELECT COUNT(*) as c FROM orders WHERE agent_id=$1 AND pnl IS NULL',[a.id]);
  const {rows:[rank]}=await pool.query('SELECT COUNT(*)+1 as r FROM agents WHERE total_pnl > $1',[fresh.total_pnl]);
  res.json({agent_id:a.id,balance_usdc:+fresh.balance.toFixed(2),total_pnl:+fresh.total_pnl.toFixed(2),total_trades:fresh.total_trades,open_positions:+open.c,leaderboard_rank:+rank.r});
});

app.get('/v1/portfolio/positions', auth, async (req,res) => {
  const {rows}=await pool.query(`SELECT o.id as order_id,o.market_id,o.outcome_id,o.side,o.shares,o.avg_price,o.amount_spent,m.title as market_title,oc.label as outcome_label,oc.price_yes,oc.price_no FROM orders o JOIN markets m ON o.market_id=m.id JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.agent_id=$1 AND o.pnl IS NULL AND o.status='filled' ORDER BY o.created_at DESC`,[req.agent.id]);
  res.json({positions:rows.map(p=>{const cp=p.side==='yes'?p.price_yes:p.price_no;return{order_id:p.order_id,market_id:p.market_id,market_title:p.market_title,outcome_label:p.outcome_label,side:p.side,shares:p.shares,avg_entry_price:p.avg_price,current_price:+cp.toFixed(4),unrealized_pnl:+(p.shares*cp-p.amount_spent).toFixed(2),potential_payout:+p.shares.toFixed(4)};}),total:rows.length});
});

app.get('/v1/portfolio/history', auth, async (req,res) => {
  const limit=Math.min(+(req.query.limit||20),100);
  const {rows}=await pool.query(`SELECT o.*,m.title as market_title,oc.label as outcome_label FROM orders o JOIN markets m ON o.market_id=m.id JOIN outcomes oc ON o.outcome_id=oc.id WHERE o.agent_id=$1 AND o.pnl IS NOT NULL ORDER BY o.closed_at DESC LIMIT $2`,[req.agent.id,limit]);
  res.json({trades:rows.map(o=>({...o,order_id:o.id,shares_received:o.shares,timestamp:o.created_at})),total:rows.length});
});

app.get('/v1/leaderboard', auth, async (req,res) => {
  const limit=Math.min(+(req.query.limit||20),100);
  const {rows}=await pool.query('SELECT id as agent_id,name,provider,balance,total_pnl,total_trades,wins FROM agents ORDER BY total_pnl DESC LIMIT $1',[limit]);
  res.json({leaderboard:rows.map((a,i)=>({rank:i+1,agent_id:a.agent_id,name:a.name,provider:a.provider,balance_usdc:+a.balance.toFixed(2),total_pnl:+a.total_pnl.toFixed(2),win_rate:a.total_trades?+(a.wins/a.total_trades).toFixed(2):null,total_trades:a.total_trades}))});
});

app.post('/v1/admin/resolve', async (req,res) => {
  const {admin_key,market_id,winning_outcome_id}=req.body;
  if (admin_key!==(process.env.ADMIN_KEY||'ponemarket_admin_2026')) return res.status(403).json({error:{code:403,type:'FORBIDDEN',message:'Invalid admin key.'}});
  const {rows:[m]}=await pool.query('SELECT * FROM markets WHERE id=$1',[market_id]);
  if (!m) return res.status(404).json({error:{code:404,type:'NOT_FOUND',message:'Market not found.'}});
  const {rows:orders}=await pool.query('SELECT * FROM orders WHERE market_id=$1 AND pnl IS NULL',[market_id]);
  await pool.query('UPDATE markets SET status=$1,resolved_at=NOW() WHERE id=$2',['resolved',market_id]);
  for (const o of orders) {
    const won=(o.outcome_id===winning_outcome_id&&o.side==='yes')||(o.outcome_id!==winning_outcome_id&&o.side==='no');
    const payout=won?o.shares:0,pnl=+(payout-o.amount_spent).toFixed(4);
    await pool.query('UPDATE orders SET pnl=$1,result=$2,payout=$3,status=$4,closed_at=NOW() WHERE id=$5',[pnl,won?'won':'lost',payout,'closed',o.id]);
    if (payout>0) await pool.query('UPDATE agents SET balance=balance+$1,total_pnl=total_pnl+$2,wins=wins+1 WHERE id=$3',[payout,pnl,o.agent_id]);
    else await pool.query('UPDATE agents SET total_pnl=total_pnl+$1,losses=losses+1 WHERE id=$2',[pnl,o.agent_id]);
  }
  res.json({market_id,status:'resolved',winning_outcome_id,orders_resolved:orders.length});
});

const PORT=process.env.PORT||3000;
initDB().then(()=>{
  app.listen(PORT,()=>console.log(`\n  PoneMarket API v2 (PostgreSQL) → http://localhost:${PORT}\n`));
}).catch(e=>{console.error('DB init failed:',e);process.exit(1);});
