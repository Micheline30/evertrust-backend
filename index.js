const express  = require('express');
const cors     = require('cors');
const twilio   = require('twilio');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY     = process.env.TWILIO_API_KEY;
const API_SECRET  = process.env.TWILIO_API_SECRET;

if (!ACCOUNT_SID || !API_KEY || !API_SECRET) {
  console.warn('⚠️  TWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET not set — token endpoint will fail.');
}

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

const MONGO_URI = process.env.MONGO_URI || '';
let dbConnected = false;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => { dbConnected = true; console.log('✅ MongoDB connected'); })
    .catch(e  => console.error('❌ MongoDB error:', e.message));
}

const agentSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  username:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  pin:          { type: String, required: true },
  number:       { type: String, default: '' },
  identity:     { type: String, default: '' },
  token_server: { type: String, default: '' },
  twiml_app:    { type: String, default: '' },
  active:       { type: Boolean, default: true },
  created:      { type: Date, default: Date.now },
});
const Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);

const FALLBACK_AGENTS = [
  {
    _id: 'marcus_fb',
    name: 'Marcus Hayes',
    username: 'marcus',
    pin: '1234',
    number: '+18437735293',
    identity: 'marcus_agent',
    token_server: 'https://evertrust-backend-1or5.onrender.com/token',
    twiml_app: 'AP3a9c6ad4134e905e88daaa9369a2a705',
    active: true,
  },
  {
    _id: 'sherry_fb',
    name: 'Sherrie Hayes',
    username: 'sherrie',
    pin: '5124',
    number: '+18033038650',
    identity: 'sherry_agent',
    token_server: 'https://evertrust-backend-1or5.onrender.com/token',
    twiml_app: 'APc2597f343780d26e24de777734153c1e',
    active: true,
  },
];

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
    return all.find(a => a.number.replace(/\D/g,'') === clean) || null;
  }
  return FALLBACK_AGENTS.find(a => a.number.replace(/\D/g,'') === clean && a.active) || null;
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
    return agents.map(a => ({ ...a, pin: '••••' }));
  }
  return FALLBACK_AGENTS.map(a => ({ ...a, pin: '••••' }));
}

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'agentsedge2025';
function requireAdmin(req, res, next) {
  const s = req.headers['x-admin-secret'] || req.query.secret;
  if (s !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', timestamp: new Date() }));

app.get('/', (req, res) => res.json({
  status:  'ok',
  service: 'Evertrust Dialer Backend',
  db:      dbConnected ? 'connected' : 'fallback',
  version: '3.0.0',
}));

app.get('/token', async (req, res) => {
  const identity = (req.query.identity || '').trim();
  if (!identity) {
    return res.status(400).json({ error: 'identity parameter required' });
  }
  const agent = await agentByIdentity(identity);
  if (!agent) {
    return res.status(403).json({ error: 'Unknown agent: ' + identity });
  }
  try {
    const token = new AccessToken(ACCOUNT_SID, API_KEY, API_SECRET, {
      identity,
      ttl: 3600,
    });
    const grant = new VoiceGrant({
      outgoingApplicationSid: agent.twiml_app,
      incomingAllow: true,
    });
    token.addGrant(grant);
    res.json({ token: token.toJwt(), identity });
  } catch(e) {
    console.error('/token error:', e.message);
    res.status(500).json({ error: 'Token generation failed — check Twilio env vars' });
  }
});

app.post('/auth', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });
  try {
    const agent = await findAgent(username, pin);
    if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({
      success: true,
      agent: {
        name:         agent.name,
        username:     agent.username,
        number:       agent.number,
        identity:     agent.identity,
        token_server: agent.token_server,
        twiml_app:    agent.twiml_app,
        active:       agent.active,
      },
    });
  } catch(e) {
    console.error('/auth error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/agents', requireAdmin, async (req, res) => {
  try {
    res.json({ agents: await getAllAgents() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/agents', requireAdmin, async (req, res) => {
  const { name, username, pin, number, identity, token_server, twiml_app } = req.body;
  if (!name || !username || !pin) return res.status(400).json({ error: 'name, username, pin required' });
  try {
    if (dbConnected) {
      const exists = await Agent.findOne({ username: username.toLowerCase().trim() });
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const agent = new Agent({
        name, username, pin,
        number:       number       || '',
        identity:     identity     || username.toLowerCase().trim() + '_agent',
        token_server: token_server || 'https://evertrust-backend-1or5.onrender.com/token',
        twiml_app:    twiml_app    || '',
        active: true,
      });
      await agent.save();
      res.json({ success: true, agent: { ...agent.toObject(), pin: '••••' } });
    } else {
      const exists = FALLBACK_AGENTS.find(a => a.username === username.toLowerCase().trim());
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const a = { _id: Date.now().toString(), name, username, pin, number, identity, token_server, twiml_app, active: true, created: new Date() };
      FALLBACK_AGENTS.push(a);
      res.json({ success: true, agent: { ...a, pin: '••••' } });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/agents/:username', requireAdmin, async (req, res) => {
  const updates = { ...req.body };
  delete updates.pin;
  try {
    if (dbConnected) {
      const agent = await Agent.findOneAndUpdate(
        { username: req.params.username.toLowerCase() },
        { $set: updates },
        { new: true }
      ).lean();
      if (!agent) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true, agent: { ...agent, pin: '••••' } });
    } else {
      const idx = FALLBACK_AGENTS.findIndex(a => a.username === req.params.username.toLowerCase());
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      FALLBACK_AGENTS[idx] = { ...FALLBACK_AGENTS[idx], ...updates };
      res.json({ success: true, agent: { ...FALLBACK_AGENTS[idx], pin: '••••' } });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Voice endpoint — outbound calls (no webhook validation) ──
app.post('/voice', async (req, res) => {
  const twiml    = new twilio.twiml.VoiceResponse();
  const to       = req.body.To || req.query.To;
  const identity = (req.body.identity || req.query.identity || 'marcus_agent').trim();

  const agent    = await agentByIdentity(identity);
  const callerId = agent ? agent.number : '+18437735293';

  if (to) {
    const dial = twiml.dial({ callerId, answerOnBridge: true });
    if (to.startsWith('client:')) {
      dial.client({
        statusCallbackEvent: ['initiated','ringing','answered','completed'],
      }, to.replace('client:', ''));
    } else {
      dial.number(to);
    }
  } else {
    twiml.say('No destination number provided.');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Incoming call — routes to correct agent (no webhook validation) ──
app.post('/incoming-call', async (req, res) => {
  const twiml    = new twilio.twiml.VoiceResponse();
  const to       = req.body.To || req.query.To || '';
  const agent    = await agentByNumber(to);
  const identity = agent ? agent.identity : 'marcus_agent';
  const callerId = agent ? agent.number   : '+18437735293';

  const dial = twiml.dial({ answerOnBridge: true, callerId });
  dial.client({
    statusCallbackEvent: ['initiated','ringing','answered','completed'],
  }, identity);

  res.type('text/xml');
  res.send(twiml.toString());
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Evertrust Backend v3.0 running on port ${PORT}`);
  setInterval(() => {
    require('https').get('https://evertrust-backend-1or5.onrender.com/').on('error', ()=>{});
  }, 10 * 60 * 1000);
});
