const express  = require('express');
const cors     = require('cors');
const twilio   = require('twilio');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Main (Marcus/Evertrust) Twilio credentials ──
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY     = process.env.TWILIO_API_KEY;
const API_SECRET  = process.env.TWILIO_API_SECRET;

// ── Sherrie subaccount credentials (from Render env vars) ──
const SHERRIE_ACCOUNT_SID = process.env.SHERRIE_ACCOUNT_SID;
const SHERRIE_API_KEY     = process.env.SHERRIE_API_KEY;
const SHERRIE_API_SECRET  = process.env.SHERRIE_API_SECRET;

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

// ── MongoDB ──
const MONGO_URI = process.env.MONGO_URI || '';
let dbConnected = false;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => { dbConnected = true; console.log('MongoDB connected'); })
    .catch(e  => console.error('MongoDB error:', e.message));
}

// ── Agent Schema ──
const agentSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  username:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  pin:          { type: String, required: true },
  number:       { type: String, default: '' },
  cell:         { type: String, default: '' },
  identity:     { type: String, default: '' },
  token_server: { type: String, default: '' },
  twiml_app:    { type: String, default: '' },
  active:       { type: Boolean, default: true },
  created:      { type: Date, default: Date.now },
  accountSid:   { type: String, default: '' },
  apiKey:       { type: String, default: '' },
  apiSecret:    { type: String, default: '' },
});
const Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);

// ── Fallback agents (no secrets hardcoded — all from env vars) ──
const FALLBACK_AGENTS = [
  {
    _id:          'marcus_fb',
    name:         'Marcus Hayes',
    username:     'marcus',
    pin:          '1234',
    number:       '+18437735293',
    cell:         process.env.MARCUS_CELL || '',
    identity:     'marcus_agent',
    token_server: 'https://evertrust-backend-1or5.onrender.com/token',
    twiml_app:    'AP3a9c6ad4134e905e88daaa9369a2a705',
    active:       true,
    accountSid:   '',
    apiKey:       '',
    apiSecret:    '',
  },
  {
    _id:          'sherry_fb',
    name:         'Sherrie Hayes',
    username:     'sherrie',
    pin:          '5124',
    number:       '+18033038650',
    cell:         process.env.SHERRIE_CELL || '',
    identity:     'sherry_agent',
    token_server: 'https://evertrust-backend-1or5.onrender.com/token',
    twiml_app:    'APc2597f343780d26e24de777734153c1e',
    active:       true,
    accountSid:   SHERRIE_ACCOUNT_SID || '',
    apiKey:       SHERRIE_API_KEY     || '',
    apiSecret:    SHERRIE_API_SECRET  || '',
  },
];

// ── Agent lookup helpers ──
async function agentByIdentity(identity) {
  if (dbConnected) {
    return await Agent.findOne({ identity, active: true }).lean();
  }
  return FALLBACK_AGENTS.find(a => a.identity === identity && a.active) || null;
}

async function agentByNumber(rawNumber) {
  const clean = rawNumber.replace(/\D/g, '');
  if (dbConnected) {
    const all = await Agent.find({ active: true }).lean();
    return all.find(a => a.number.replace(/\D/g, '') === clean) || null;
  }
  return FALLBACK_AGENTS.find(a => a.number.replace(/\D/g, '') === clean && a.active) || null;
}

async function findAgent(username, pin) {
  const u = (username || '').toLowerCase().trim();
  const p = String(pin || '').trim();
  if (dbConnected) {
    const agent = await Agent.findOne({ username: u, active: true });
    if (!agent) return null;
    const ok = agent.pin === p || (agent.pin.startsWith('$2') && await bcrypt.compare(p, agent.pin));
    return ok ? agent.toObject() : null;
  }
  return FALLBACK_AGENTS.find(a => a.username === u && String(a.pin) === p && a.active) || null;
}

async function getAllAgents() {
  if (dbConnected) {
    const agents = await Agent.find({}).sort({ created: -1 }).lean();
    return agents.map(a => ({ ...a, pin: '••••', apiSecret: '••••' }));
  }
  return FALLBACK_AGENTS.map(a => ({ ...a, pin: '••••', apiSecret: '••••' }));
}

// ── Admin middleware ──
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'agentsedge2025';
function requireAdmin(req, res, next) {
  const s = req.headers['x-admin-secret'] || req.query.secret;
  if (s !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Routes ──
app.get('/', (req, res) => res.json({
  status:  'ok',
  service: 'Evertrust Dialer Backend',
  db:      dbConnected ? 'connected' : 'fallback',
  version: '3.1.0',
}));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// ── Token endpoint ──
// Uses per-agent subaccount credentials if set, falls back to main account
app.get('/token', async (req, res) => {
  const identity = (req.query.identity || 'marcus_agent').trim();

  let agent;
  try {
    agent = await agentByIdentity(identity);
  } catch (e) {
    return res.status(500).json({ error: 'Agent lookup failed' });
  }

  if (!agent) {
    return res.status(403).json({ error: 'Unknown agent: ' + identity });
  }

  // Use agent subaccount creds if available, else fall back to main account
  const accountSid = (agent.accountSid && agent.accountSid.length > 5) ? agent.accountSid : ACCOUNT_SID;
  const apiKey     = (agent.apiKey     && agent.apiKey.length     > 5) ? agent.apiKey     : API_KEY;
  const apiSecret  = (agent.apiSecret  && agent.apiSecret.length  > 5) ? agent.apiSecret  : API_SECRET;

  try {
    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 3600,
    });
    const grant = new VoiceGrant({
      outgoingApplicationSid: agent.twiml_app,
      incomingAllow: true,
    });
    token.addGrant(grant);
    res.json({ token: token.toJwt(), identity });
  } catch (e) {
    console.error('Token generation error for', identity, ':', e.message);
    res.status(500).json({ error: 'Token generation failed: ' + e.message });
  }
});

// ── Voice endpoint — outbound calls ──
app.post('/voice', async (req, res) => {
  const twiml    = new twilio.twiml.VoiceResponse();
  const to       = req.body.To || req.query.To;
  const identity = req.body.identity || req.query.identity || 'marcus_agent';

  let agent;
  try {
    agent = await agentByIdentity(identity);
  } catch (e) {
    agent = null;
  }

  // Use agent's own number as caller ID
  const callerId = (agent && agent.number) ? agent.number : '+18437735293';

  if (to) {
    const dial = twiml.dial({ callerId, answerOnBridge: true });
    dial.number(to);
  } else {
    twiml.say('No destination number provided.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Incoming call — routes to correct agent by their number ──
// Rings the agent's browser client AND their cell phone at the same time.
// Whichever answers first gets the call; the other stops ringing.
app.post('/incoming-call', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to    = req.body.To   || req.query.To   || '';
  const from  = req.body.From || req.query.From || '';

  let agent;
  try {
    agent = to ? await agentByNumber(to) : null;
  } catch (e) {
    agent = null;
  }

  const clientIdentity = agent ? agent.identity : 'marcus_agent';
  // Pass the ACTUAL caller's number through so the agent sees who's calling —
  // not their own Twilio number.
  const callerId = from || (agent ? agent.number : '+18437735293');

  // Cell number: prefer the DB agent's own 'cell' field, but fall back to the
  // matching FALLBACK_AGENTS entry (which reads from env vars) in case the
  // DB record predates the cell field or MongoDB isn't connected.
  const fallbackMatch = FALLBACK_AGENTS.find(fa => fa.identity === clientIdentity);
  const cellNumber = (agent && agent.cell) || (fallbackMatch && fallbackMatch.cell) || '';

  const dial = twiml.dial({ answerOnBridge: true, callerId });
  dial.client(clientIdentity);
  if (cellNumber) {
    dial.number(cellNumber);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Auth ──
app.post('/auth', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });
  try {
    const agent = await findAgent(username, pin);
    if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, agent: {
      name:         agent.name,
      username:     agent.username,
      number:       agent.number,
      identity:     agent.identity,
      token_server: agent.token_server,
      twiml_app:    agent.twiml_app,
    }});
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Agents CRUD ──
app.get('/agents', requireAdmin, async (req, res) => {
  try { res.json({ agents: await getAllAgents() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/agents', requireAdmin, async (req, res) => {
  const { name, username, pin, number, identity, token_server, twiml_app, accountSid, apiKey, apiSecret } = req.body;
  if (!name || !username || !pin) return res.status(400).json({ error: 'name, username, pin required' });
  try {
    if (dbConnected) {
      const exists = await Agent.findOne({ username: username.toLowerCase().trim() });
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const agent = new Agent({ name, username, pin, number, identity, token_server, twiml_app, accountSid, apiKey, apiSecret, active: true });
      await agent.save();
      res.json({ success: true, agent: { ...agent.toObject(), pin: '••••', apiSecret: '••••' } });
    } else {
      const a = { _id: Date.now().toString(), name, username, pin, number, identity, token_server, twiml_app, accountSid, apiKey, apiSecret, active: true };
      FALLBACK_AGENTS.push(a);
      res.json({ success: true, agent: { ...a, pin: '••••', apiSecret: '••••' } });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/agents/:username/toggle', requireAdmin, async (req, res) => {
  try {
    if (dbConnected) {
      const agent = await Agent.findOne({ username: req.params.username.toLowerCase() });
      if (!agent) return res.status(404).json({ error: 'Not found' });
      agent.active = !agent.active;
      await agent.save();
      res.json({ success: true, active: agent.active });
    } else {
      const a = FALLBACK_AGENTS.find(a => a.username === req.params.username.toLowerCase());
      if (!a) return res.status(404).json({ error: 'Not found' });
      a.active = !a.active;
      res.json({ success: true, active: a.active });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/agents/:username', requireAdmin, async (req, res) => {
  try {
    if (dbConnected) {
      await Agent.findOneAndDelete({ username: req.params.username.toLowerCase() });
    } else {
      const idx = FALLBACK_AGENTS.findIndex(a => a.username === req.params.username.toLowerCase());
      if (idx !== -1) FALLBACK_AGENTS.splice(idx, 1);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ── Start server + keep-alive ping ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Evertrust Backend v3.1 running on port ${PORT}`);
  setInterval(() => {
    require('https').get('https://evertrust-backend-1or5.onrender.com/').on('error', () => {});
  }, 10 * 60 * 1000);
});
