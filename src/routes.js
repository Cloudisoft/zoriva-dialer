const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { db, audit } = require('./db');
const auth = require('./auth');
const P = require('./providers');
const C = require('./compliance');
const dialer = require('./dialer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = express.Router();
const admin = auth.requireRole('admin');
const supervisor = auth.requireRole('admin', 'supervisor');

const ok = (res, data) => res.json(data ?? { ok: true });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

/* ---------------------------- auth ---------------------------- */

router.post('/auth/login', wrap((req, res) => {
  const ip = req.ip || 'unknown';
  const email = req.body.email;

  const waitMin = auth.checkThrottle(email, ip);
  if (waitMin) {
    audit(null, 'system', 'auth.throttled', 'user', email || '', `from ${ip}`);
    return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.` });
  }

  const result = auth.login(email, req.body.password);
  if (!result) {
    auth.recordFailure(email, ip);
    audit(null, 'system', 'auth.failed', 'user', email || '', `from ${ip}`);
    return res.status(401).json({ error: 'That email and password do not match.' });
  }

  auth.clearFailures(email, ip);
  res.cookie(auth.COOKIE, result.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 * 1000 });
  ok(res, { user: result.user });
}));

router.post('/auth/logout', (req, res) => { res.clearCookie(auth.COOKIE); ok(res); });
router.get('/auth/me', auth.requireAuth, (req, res) => ok(res, { user: req.user }));

router.use(auth.requireAuth);

/* ------------------------- credentials ------------------------ */

router.get('/settings/credentials', admin, wrap((req, res) => ok(res, P.credentialSummary())));

router.post('/settings/credentials/vapi', admin, wrap((req, res) => {
  P.saveCredentials('vapi', {
    privateKey: req.body.privateKey,
    publicKey: req.body.publicKey,
    phoneNumberId: req.body.phoneNumberId,
  }, req.user.id);
  ok(res, P.credentialSummary());
}));

router.post('/settings/credentials/twilio', admin, wrap((req, res) => {
  P.saveCredentials('twilio', {
    accountSid: req.body.accountSid,
    authToken: req.body.authToken,
    defaultNumber: req.body.defaultNumber,
  }, req.user.id);
  ok(res, P.credentialSummary());
}));

router.post('/settings/credentials/:provider/test', admin, wrap(async (req, res) => {
  const result = req.params.provider === 'vapi' ? await P.testVapi() : await P.testTwilio();
  audit(req.user.id, 'user', 'credentials.test', 'credentials', req.params.provider, result.message);
  ok(res, result);
}));

router.get('/settings/numbers', admin, wrap(async (req, res) => {
  const [twilioNumbers, vapiNumbers] = await Promise.all([
    P.listTwilioNumbers().catch(() => []),
    P.listVapiNumbers().catch(() => []),
  ]);
  ok(res, { twilioNumbers, vapiNumbers });
}));

router.post('/settings/numbers/import', admin, wrap(async (req, res) => {
  const result = await P.importNumberToVapi(req.body.number);
  audit(req.user.id, 'user', 'number.imported', 'number', req.body.number, '');
  ok(res, result);
}));

/* ---------------------------- agents -------------------------- */

router.get('/agents', wrap((req, res) => ok(res, db.prepare('SELECT * FROM agents ORDER BY id DESC').all())));

router.post('/agents', supervisor, wrap(async (req, res) => {
  const b = req.body;
  const info = db.prepare(
    `INSERT INTO agents (name, voice_id, voice_provider, first_message, script, sop, require_dpa, disclose_ai, handoff_number)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(b.name, b.voice_id || 'burt', b.voice_provider || 'vapi', b.first_message || '',
        b.script || '', b.sop || '', b.require_dpa === false ? 0 : 1, b.disclose_ai === false ? 0 : 1, b.handoff_number || null);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(info.lastInsertRowid);

  // Create the matching assistant in Vapi so the agent is dialable.
  try {
    const created = await P.vapi('/assistant', {
      method: 'POST',
      body: JSON.stringify({
        name: agent.name,
        firstMessage: agent.first_message || 'Hello, may I speak with {{first_name}} please?',
        model: {
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'system', content: C.buildSystemPrompt(agent, { first_name: '{{first_name}}', last_name: '{{last_name}}', reference: '{{reference}}', creditor: '', balance_pence: 0, dob: '', postcode: '' }) }],
          tools: C.toolDefinitions(),
        },
        voice: { provider: agent.voice_provider, voiceId: agent.voice_id },
        serverUrl: `${process.env.PUBLIC_URL}/api/webhooks/vapi`,
        serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
        recordingEnabled: true,
        endCallFunctionEnabled: true,
      }),
    });
    db.prepare('UPDATE agents SET vapi_assistant_id = ? WHERE id = ?').run(created.id, agent.id);
    agent.vapi_assistant_id = created.id;
  } catch (e) {
    audit(req.user.id, 'user', 'agent.vapi_sync_failed', 'agent', agent.id, e.message);
    return res.status(200).json({ ...agent, warning: `Saved locally, but Vapi rejected it: ${e.message}` });
  }
  audit(req.user.id, 'user', 'agent.created', 'agent', agent.id, agent.name);
  ok(res, agent);
}));

router.put('/agents/:id', supervisor, wrap(async (req, res) => {
  const b = req.body;
  db.prepare(
    `UPDATE agents SET name=?, voice_id=?, first_message=?, script=?, sop=?, require_dpa=?, handoff_number=? WHERE id=?`
  ).run(b.name, b.voice_id, b.first_message || '', b.script || '', b.sop || '',
        b.require_dpa === false ? 0 : 1, b.handoff_number || null, req.params.id);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (agent.vapi_assistant_id) {
    await P.vapi(`/assistant/${agent.vapi_assistant_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: agent.name,
        firstMessage: agent.first_message,
        model: {
          provider: 'openai', model: 'gpt-4o',
          messages: [{ role: 'system', content: C.buildSystemPrompt(agent, { first_name: '{{first_name}}', last_name: '{{last_name}}', reference: '{{reference}}', creditor: '', balance_pence: 0, dob: '', postcode: '' }) }],
          tools: C.toolDefinitions(),
        },
        voice: { provider: agent.voice_provider, voiceId: agent.voice_id },
      }),
    }).catch((e) => audit(req.user.id, 'user', 'agent.vapi_sync_failed', 'agent', agent.id, e.message));
  }
  // Prompt changes are auditable: keep the full text, not just "updated".
  audit(req.user.id, 'user', 'agent.prompt_updated', 'agent', agent.id, (agent.script || '').slice(0, 2000));
  ok(res, agent);
}));

router.get('/agents/:id/preview', wrap((req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  ok(res, { prompt: C.buildSystemPrompt(agent, { first_name: 'Sarah', last_name: 'Jones', reference: 'ACC-10293', creditor: 'Northbank Cards', balance_pence: 148250, dob: '1984-06-02', postcode: 'M14 5QL' }) });
}));

/* --------------------------- lead lists ------------------------ */

router.get('/lists', wrap((req, res) => ok(res, db.prepare(
  `SELECT l.*, (SELECT COUNT(*) FROM leads WHERE list_id = l.id) AS lead_count
   FROM lead_lists l ORDER BY l.id DESC`).all())));

router.post('/lists', wrap((req, res) => {
  const info = db.prepare('INSERT INTO lead_lists (name, client, notes) VALUES (?,?,?)')
    .run(req.body.name, req.body.client || '', req.body.notes || '');
  ok(res, db.prepare('SELECT * FROM lead_lists WHERE id = ?').get(info.lastInsertRowid));
}));

/* ----------------------------- leads --------------------------- */

router.get('/leads', wrap((req, res) => {
  const { list_id, status, q } = req.query;
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const args = [];
  if (list_id) { sql += ' AND list_id = ?'; args.push(list_id); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (q) { sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR reference LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY id DESC LIMIT 500';
  ok(res, db.prepare(sql).all(...args));
}));

router.post('/leads', wrap((req, res) => {
  const b = req.body;
  const phone = C.normalise(b.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a phone number.' });
  const info = db.prepare(
    `INSERT INTO leads (list_id, reference, first_name, last_name, phone, postcode, dob, balance_pence, creditor)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(b.list_id || null, b.reference || '', b.first_name || '', b.last_name || '', phone,
        b.postcode || '', b.dob || '', Math.round((parseFloat(b.balance) || 0) * 100), b.creditor || '');
  audit(req.user.id, 'user', 'lead.created', 'lead', info.lastInsertRowid, '');
  ok(res, db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid));
}));

// Bulk upload. Accepts a CSV with headers:
// reference, first_name, last_name, phone, postcode, dob, balance, creditor
router.post('/leads/import', upload.single('file'), wrap((req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a CSV file.' });
  const listId = req.body.list_id;
  if (!listId) return res.status(400).json({ error: 'Choose a lead list first.' });

  const rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  const insert = db.prepare(
    `INSERT INTO leads (list_id, reference, first_name, last_name, phone, postcode, dob, balance_pence, creditor)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  let imported = 0, suppressed = 0, invalid = 0;
  const errors = [];
  const run = db.transaction(() => {
    rows.forEach((r, i) => {
      const phone = C.normalise(r.phone || r.Phone || r.telephone || r.mobile);
      if (!phone || phone.length < 10) { invalid++; if (errors.length < 10) errors.push(`Row ${i + 2}: unusable phone number`); return; }
      if (C.isSuppressed(phone)) { suppressed++; return; }
      insert.run(listId, r.reference || '', r.first_name || '', r.last_name || '', phone,
        r.postcode || '', r.dob || '', Math.round((parseFloat(r.balance) || 0) * 100), r.creditor || '');
      imported++;
    });
  });
  run();

  audit(req.user.id, 'user', 'leads.imported', 'lead_list', listId, `${imported} imported, ${suppressed} suppressed, ${invalid} rejected`);
  ok(res, { imported, suppressed, invalid, errors });
}));

router.post('/leads/:id/do-not-call', wrap((req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'No such lead.' });
  db.prepare('INSERT OR IGNORE INTO suppression (phone, reason) VALUES (?, ?)').run(lead.phone, 'requested by customer');
  db.prepare("UPDATE leads SET status = 'do_not_call' WHERE id = ?").run(lead.id);
  audit(req.user.id, 'user', 'lead.do_not_call', 'lead', lead.id, '');
  ok(res);
}));

/* --------------------------- campaigns ------------------------- */

router.get('/campaigns', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT c.*, l.name AS list_name, a.name AS agent_name,
       (SELECT COUNT(*) FROM leads WHERE list_id = c.list_id) AS total_leads,
       (SELECT COUNT(*) FROM calls WHERE campaign_id = c.id) AS calls_made
     FROM campaigns c
     LEFT JOIN lead_lists l ON l.id = c.list_id
     LEFT JOIN agents a ON a.id = c.agent_id
     ORDER BY c.id DESC`
  ).all();
  ok(res, rows.map((c) => ({ ...c, window: C.windowState(c), abandonment: +C.abandonmentRate(c.id).toFixed(2) })));
}));

router.post('/campaigns', supervisor, wrap((req, res) => {
  const b = req.body;
  const info = db.prepare(
    `INSERT INTO campaigns (name, list_id, agent_id, from_number, concurrency, max_attempts, window_start, window_end, days)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(b.name, b.list_id, b.agent_id, b.from_number || '', b.concurrency || 2, b.max_attempts || 3,
        b.window_start || '08:00', b.window_end || '20:00', b.days || '1,2,3,4,5,6');
  audit(req.user.id, 'user', 'campaign.created', 'campaign', info.lastInsertRowid, b.name);
  ok(res, db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid));
}));

router.post('/campaigns/:id/:action(start|pause)', supervisor, wrap((req, res) => {
  const status = req.params.action === 'start' ? 'running' : 'paused';
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, req.params.id);
  audit(req.user.id, 'user', `campaign.${req.params.action}`, 'campaign', req.params.id, '');
  ok(res, { status });
}));

/* ----------------------------- calls --------------------------- */

router.get('/calls', wrap((req, res) => {
  const { status, campaign_id, disposition, limit } = req.query;
  let sql = `SELECT c.*, l.first_name, l.last_name, l.reference, a.name AS agent_name, cm.name AS campaign_name
             FROM calls c
             LEFT JOIN leads l ON l.id = c.lead_id
             LEFT JOIN agents a ON a.id = c.agent_id
             LEFT JOIN campaigns cm ON cm.id = c.campaign_id
             WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND c.status = ?'; args.push(status); }
  if (campaign_id) { sql += ' AND c.campaign_id = ?'; args.push(campaign_id); }
  if (disposition) { sql += ' AND c.disposition = ?'; args.push(disposition); }
  sql += ' ORDER BY c.started_at DESC LIMIT ?';
  args.push(parseInt(limit, 10) || 200);
  ok(res, db.prepare(sql).all(...args));
}));

router.get('/calls/live', wrap((req, res) => ok(res, db.prepare(
  `SELECT c.*, l.first_name, l.last_name, a.name AS agent_name, cm.name AS campaign_name
   FROM calls c
   LEFT JOIN leads l ON l.id = c.lead_id
   LEFT JOIN agents a ON a.id = c.agent_id
   LEFT JOIN campaigns cm ON cm.id = c.campaign_id
   WHERE c.status IN ('queued','ringing','in-progress')
   ORDER BY c.started_at DESC`).all())));

router.get('/calls/:id', wrap((req, res) => {
  const call = db.prepare(
    `SELECT c.*, l.first_name, l.last_name, l.reference, l.phone, a.name AS agent_name
     FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN agents a ON a.id = c.agent_id
     WHERE c.id = ?`).get(req.params.id);
  if (!call) return res.status(404).json({ error: 'No such call.' });
  audit(req.user.id, 'user', 'call.viewed', 'call', call.id, 'transcript and recording accessed');
  ok(res, call);
}));

router.post('/calls/:id/disposition', wrap((req, res) => {
  db.prepare('UPDATE calls SET disposition = ? WHERE id = ?').run(req.body.disposition, req.params.id);
  audit(req.user.id, 'user', 'call.disposition', 'call', req.params.id, req.body.disposition);
  ok(res);
}));

/* ------------------------ inbound routes ----------------------- */

router.get('/inbound-routes', wrap((req, res) => ok(res, db.prepare(
  'SELECT r.*, a.name AS agent_name FROM inbound_routes r LEFT JOIN agents a ON a.id = r.agent_id ORDER BY r.id DESC').all())));

router.post('/inbound-routes', supervisor, wrap(async (req, res) => {
  const did = C.normalise(req.body.did);
  db.prepare('INSERT OR REPLACE INTO inbound_routes (did, agent_id, description, active) VALUES (?,?,?,1)')
    .run(did, req.body.agent_id, req.body.description || '');
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.body.agent_id);
  // Point the Vapi number at this assistant so inbound calls land on it.
  try {
    const numbers = await P.listVapiNumbers();
    const match = numbers.find((n) => n.number === did);
    if (match && agent?.vapi_assistant_id) {
      await P.vapi(`/phone-number/${match.id}`, { method: 'PATCH', body: JSON.stringify({ assistantId: agent.vapi_assistant_id }) });
    }
  } catch (e) {
    return res.json({ ok: true, warning: `Saved, but Vapi was not updated: ${e.message}` });
  }
  ok(res);
}));

/* ----------------------------- users --------------------------- */

router.get('/users', admin, wrap((req, res) => ok(res, db.prepare(
  'SELECT id, email, name, role, active, created_at FROM users ORDER BY id').all())));

router.post('/users', admin, wrap((req, res) => {
  const { email, name, password, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Enter an email address and password.' });
  if (String(password).length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters.' });
  try {
    const info = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
      .run(String(email).toLowerCase(), name || '', auth.hash(password), role || 'agent');
    audit(req.user.id, 'user', 'user.created', 'user', info.lastInsertRowid, `${email} as ${role}`);
    ok(res, { id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'That email address is already in use.' });
  }
}));

router.post('/users/:id/toggle', admin, wrap((req, res) => {
  db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(req.params.id);
  audit(req.user.id, 'user', 'user.toggled', 'user', req.params.id, '');
  ok(res);
}));

/* --------------------------- dashboard ------------------------- */

router.get('/dashboard', wrap((req, res) => {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  ok(res, {
    callsToday: q("SELECT COUNT(*) AS n FROM calls WHERE date(started_at) = date('now')").n,
    connectedToday: q("SELECT COUNT(*) AS n FROM calls WHERE date(started_at) = date('now') AND duration_sec > 15").n,
    verifiedToday: q("SELECT COUNT(*) AS n FROM calls WHERE date(started_at) = date('now') AND identity_verified = 1").n,
    vulnerableFlags: q('SELECT COUNT(*) AS n FROM calls WHERE vulnerability_flag = 1').n,
    promisedPence: q("SELECT COALESCE(SUM(amount_pence),0) AS n FROM promises WHERE date(created_at) = date('now')").n,
    liveCalls: q("SELECT COUNT(*) AS n FROM calls WHERE status IN ('queued','ringing','in-progress')").n,
    runningCampaigns: q("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'running'").n,
    suppressed: q('SELECT COUNT(*) AS n FROM suppression').n,
    recent: db.prepare(
      `SELECT c.id, c.status, c.disposition, c.duration_sec, c.started_at, c.identity_verified,
              c.vulnerability_flag, l.first_name, l.last_name
       FROM calls c LEFT JOIN leads l ON l.id = c.lead_id
       ORDER BY c.started_at DESC LIMIT 12`).all(),
  });
}));

router.get('/audit', auth.requireRole('admin', 'auditor', 'supervisor'), wrap((req, res) =>
  ok(res, db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT 300').all())));

module.exports = { router };
