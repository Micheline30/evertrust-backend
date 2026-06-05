const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

const accountSid = 'AC4bc7bbfc4087507920384253bfe53511';
const apiKey     = 'SK3825bb743a494db3656d961319566baa';
const apiSecret  = '5cvQOaRp4oVYG5VJ4uZbdB6QXIhvh7oe';

// ── Agent registry — add every agent here ──
const AGENTS = {
  marcus_agent: {
    twimlAppSid: 'AP3a9c6ad4134e905e88daaa9369a2a705',
    callerId:    '+18437735293',
  },
  sherry_agent: {
    twimlAppSid: 'APc2597f343780d26e24de777734153c1e',
    callerId:    '+18033038650',
  },
};

// ── Token endpoint ──
app.get('/token', (req, res) => {
  const identity = req.query.identity || 'marcus_agent';
  const agent    = AGENTS[identity];

  if (!agent) {
    return res.status(403).json({ error: 'Unknown agent: ' + identity });
  }

  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity, ttl: 3600
  });
  const grant = new VoiceGrant({
    outgoingApplicationSid: agent.twimlAppSid,
    incomingAllow: true,
  });
  token.addGrant(grant);
  res.json({ token: token.toJwt(), identity });
});

// ── Voice endpoint — outbound calls ──
app.post('/voice', (req, res) => {
  const twiml    = new twilio.twiml.VoiceResponse();
  const to       = req.body.To || req.query.To;
  const identity = req.body.identity || req.query.identity || 'marcus_agent';
  const agent    = AGENTS[identity] || AGENTS['marcus_agent'];

  if (to) {
    const dial = twiml.dial({ callerId: agent.callerId, answerOnBridge: true });
    if (to.startsWith('client:')) {
      dial.client(to.replace('client:', ''));
    } else {
      dial.number(to);
    }
  } else {
    twiml.say('No destination number provided.');
  }
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Incoming call endpoint — routes to correct agent ──
app.post('/incoming-call', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to    = req.body.To || req.query.To || '';

  // Match incoming number to agent
  const agent = Object.entries(AGENTS).find(
    ([, a]) => a.callerId === to || a.callerId === '+1' + to.replace(/\D/g,'')
  );
  const identity = agent ? agent[0] : 'marcus_agent';
  const agentCfg = AGENTS[identity];

  const dial = twiml.dial({ answerOnBridge: true, callerId: agentCfg.callerId });
  dial.client(identity);

  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/', (req, res) => res.send('Evertrust Dialer Backend OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
