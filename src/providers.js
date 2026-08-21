const { db, audit } = require('./db');
const { encrypt, decrypt, mask } = require('./crypto');

const VAPI_BASE = 'https://api.vapi.ai';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

/* ------------------------------------------------------------------ */
/* Credential storage                                                  */
/* ------------------------------------------------------------------ */

function saveCredentials(provider, fields, userId) {
  const existing = getCredentials(provider) || {};
  // Blank fields keep the stored value, so an operator can update one key
  // without re-typing the others.
  const merged = { ...existing };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') merged[k] = String(v).trim();
  }
  db.prepare(
    `INSERT INTO credentials (provider, payload, status, status_msg, updated_by, updated_at)
     VALUES (?,?,'untested',NULL,?,datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET
       payload=excluded.payload, status='untested', status_msg=NULL,
       updated_by=excluded.updated_by, updated_at=datetime('now')`
  ).run(provider, encrypt(JSON.stringify(merged)), userId || null);
  audit(userId, 'user', 'credentials.save', 'credentials', provider, Object.keys(fields).join(','));
  return merged;
}

function getCredentials(provider) {
  const row = db.prepare('SELECT payload FROM credentials WHERE provider = ?').get(provider);
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.payload));
  } catch {
    return null;
  }
}

function credentialSummary() {
  const rows = db.prepare('SELECT provider, status, status_msg, updated_at FROM credentials').all();
  const out = {};
  for (const r of rows) {
    const c = getCredentials(r.provider) || {};
    out[r.provider] = {
      status: r.status,
      statusMsg: r.status_msg,
      updatedAt: r.updated_at,
      fields: Object.fromEntries(
        Object.entries(c).map(([k, v]) => [k, /key|token|secret/i.test(k) ? mask(v) : v])
      ),
    };
  }
  return out;
}

function setStatus(provider, status, msg) {
  db.prepare('UPDATE credentials SET status = ?, status_msg = ? WHERE provider = ?').run(status, msg || null, provider);
}

/* ------------------------------------------------------------------ */
/* Vapi                                                                */
/* ------------------------------------------------------------------ */

async function vapi(path, options = {}) {
  const creds = getCredentials('vapi');
  if (!creds || !creds.privateKey) throw new Error('Vapi credentials are not set. Add them in Settings.');
  const res = await fetch(VAPI_BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${creds.privateKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.message || body?.error || res.statusText;
    throw new Error(`Vapi ${res.status}: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
  }
  return body;
}

async function testVapi() {
  try {
    await vapi('/assistant?limit=1');
    setStatus('vapi', 'ok', null);
    return { ok: true, message: 'Connected to Vapi.' };
  } catch (e) {
    setStatus('vapi', 'failed', e.message);
    return { ok: false, message: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Twilio                                                              */
/* ------------------------------------------------------------------ */

async function twilio(path, options = {}) {
  const creds = getCredentials('twilio');
  if (!creds || !creds.accountSid || !creds.authToken) {
    throw new Error('Twilio credentials are not set. Add them in Settings.');
  }
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
  const res = await fetch(TWILIO_BASE + path, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body?.message || res.statusText}`);
  return body;
}

async function testTwilio() {
  try {
    const creds = getCredentials('twilio');
    const acct = await twilio(`/Accounts/${creds.accountSid}.json`);
    setStatus('twilio', 'ok', null);
    return { ok: true, message: `Connected to Twilio account "${acct.friendly_name}" (${acct.status}).` };
  } catch (e) {
    setStatus('twilio', 'failed', e.message);
    return { ok: false, message: e.message };
  }
}

async function listTwilioNumbers() {
  const creds = getCredentials('twilio');
  const body = await twilio(`/Accounts/${creds.accountSid}/IncomingPhoneNumbers.json?PageSize=50`);
  return (body.incoming_phone_numbers || []).map((n) => ({
    sid: n.sid,
    number: n.phone_number,
    friendlyName: n.friendly_name,
  }));
}

/* Register a Twilio number with Vapi so it can place and receive AI calls. */
async function importNumberToVapi(e164) {
  const creds = getCredentials('twilio');
  return vapi('/phone-number', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'twilio',
      number: e164,
      twilioAccountSid: creds.accountSid,
      twilioAuthToken: creds.authToken,
      name: `Collections ${e164}`,
    }),
  });
}

async function listVapiNumbers() {
  const list = await vapi('/phone-number');
  return (Array.isArray(list) ? list : []).map((n) => ({ id: n.id, number: n.number, name: n.name }));
}

module.exports = {
  saveCredentials, getCredentials, credentialSummary,
  vapi, testVapi,
  twilio, testTwilio, listTwilioNumbers, importNumberToVapi, listVapiNumbers,
};
