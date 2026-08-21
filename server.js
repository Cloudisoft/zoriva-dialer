require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { bootstrapAdmin } = require('./src/auth');
const { router: api } = require('./src/routes');
const { router: webhooks } = require('./src/webhook');
const dialer = require('./src/dialer');

const app = express();
app.set('trust proxy', 1);

// Webhooks mount before the JSON body parser so they own their own parsing.
app.use('/api/webhooks', webhooks);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));
app.use('/api', api);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const port = process.env.PORT || 3000;

// Preflight. These are the two misconfigurations that look fine on boot and
// then lose your data or silently drop every webhook.
function preflight() {
  const warn = (m) => console.warn('\n  ⚠  ' + m + '\n');
  const dbPath = process.env.DB_PATH || './data/collectai.db';
  const onVolume = dbPath.startsWith('/data') || dbPath.startsWith('/mnt');
  const managed = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME;

  if (managed && !onVolume) {
    warn(`DB_PATH is "${dbPath}", which is ephemeral on this host.\n     ` +
         'Attach a persistent volume and set DB_PATH to a path inside it\n     ' +
         '(e.g. /data/zorvia.db), or every redeploy wipes your database\n     ' +
         'including the stored Vapi and Twilio credentials.');
  }
  const url = process.env.PUBLIC_URL || '';
  if (!url) {
    warn('PUBLIC_URL is not set. Vapi cannot deliver call events, so you will\n     ' +
         'get calls with no transcripts, recordings or dispositions.');
  } else if (!url.startsWith('https://') && !url.includes('localhost')) {
    warn(`PUBLIC_URL is "${url}". Vapi requires HTTPS for webhooks.`);
  } else if (url.endsWith('/')) {
    warn('PUBLIC_URL ends with a slash. Remove it, or webhook URLs will be malformed.');
  }
}

preflight();
bootstrapAdmin();
app.listen(port, '0.0.0.0', () => {
  console.log(`Zorvia Dialer running at http://localhost:${port}`);
  dialer.start();
});
