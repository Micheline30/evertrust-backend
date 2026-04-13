const express = require('express');
const cors    = require('cors');
const twilio  = require('twilio');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

const accountSid  = 'AC4bc7bbfc4087507920384253bfe53511';
const apiKey      = 'SK3825bb743a494db3656d961319566baa';
const apiSecret   = '5cvQOaRp4oVYG5VJ4uZbdB6QXIhvh7oe';
const twimlAppSid = 'AP3a9c6ad4134e905e88daaa9369a2a705';
const callerId    = '+18437735293';

app.get('/token', (req, res) => {
  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity: 'marcus_agent', ttl: 3600
  });
  const grant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true
  });
  token.addGrant(grant);
  res.json({ token: token.toJwt() });
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const dial  = twiml.dial({ callerId });
  dial.number(req.body.To || req.query.To);
  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/', (req, res) => res.send('Evertrust Dialer Backend OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
