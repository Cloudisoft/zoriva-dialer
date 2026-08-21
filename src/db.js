const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/collectai.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent',   -- admin | supervisor | agent | auditor
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Provider credentials, encrypted at rest. One row per provider.
CREATE TABLE IF NOT EXISTS credentials (
  provider   TEXT PRIMARY KEY,                   -- vapi | twilio
  payload    TEXT NOT NULL,                      -- encrypted JSON
  status     TEXT NOT NULL DEFAULT 'untested',   -- untested | ok | failed
  status_msg TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  vapi_assistant_id TEXT,
  voice_id         TEXT NOT NULL DEFAULT 'burt',
  voice_provider   TEXT NOT NULL DEFAULT 'vapi',
  first_message    TEXT NOT NULL DEFAULT '',
  script           TEXT NOT NULL DEFAULT '',      -- the call script
  sop              TEXT NOT NULL DEFAULT '',      -- operating procedure / guardrails
  require_dpa      INTEGER NOT NULL DEFAULT 1,    -- enforce identity check before debt talk
  disclose_ai      INTEGER NOT NULL DEFAULT 1,
  handoff_number   TEXT,                          -- warm transfer target for vulnerability
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_lists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  client     TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER REFERENCES lead_lists(id) ON DELETE CASCADE,
  reference     TEXT NOT NULL DEFAULT '',        -- client's account reference
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL,
  postcode      TEXT NOT NULL DEFAULT '',
  dob           TEXT NOT NULL DEFAULT '',        -- used for the identity check only
  balance_pence INTEGER NOT NULL DEFAULT 0,
  creditor      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new',     -- new | queued | contacted | ptp | arranged | paid | disputed | do_not_call | closed
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_attempt  TEXT,
  no_call_until TEXT,                            -- Ofcom 72h AMD rule, callbacks, preferred windows
  vulnerable    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_list ON leads(list_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

CREATE TABLE IF NOT EXISTS suppression (
  phone      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'do_not_call',
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  list_id        INTEGER REFERENCES lead_lists(id),
  agent_id       INTEGER REFERENCES agents(id),
  from_number    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | running | paused | finished
  concurrency    INTEGER NOT NULL DEFAULT 2,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  window_start   TEXT NOT NULL DEFAULT '08:00',
  window_end     TEXT NOT NULL DEFAULT '20:00',
  days           TEXT NOT NULL DEFAULT '1,2,3,4,5,6',  -- 0=Sun
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vapi_call_id   TEXT UNIQUE,
  campaign_id    INTEGER REFERENCES campaigns(id),
  lead_id        INTEGER REFERENCES leads(id),
  agent_id       INTEGER REFERENCES agents(id),
  direction      TEXT NOT NULL DEFAULT 'outbound',
  from_number    TEXT NOT NULL DEFAULT '',
  to_number      TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued',  -- queued | ringing | in-progress | ended | failed
  ended_reason   TEXT,
  disposition    TEXT,
  identity_verified INTEGER NOT NULL DEFAULT 0,
  vulnerability_flag INTEGER NOT NULL DEFAULT 0,
  transferred    INTEGER NOT NULL DEFAULT 0,
  duration_sec   INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  recording_url  TEXT,
  transcript     TEXT,
  summary        TEXT,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);

CREATE TABLE IF NOT EXISTS inbound_routes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  did         TEXT UNIQUE NOT NULL,
  agent_id    INTEGER REFERENCES agents(id),
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS promises (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  call_id       INTEGER REFERENCES calls(id),
  amount_pence  INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT,
  frequency     TEXT NOT NULL DEFAULT 'one_off',  -- one_off | weekly | monthly
  kept          INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only. Regulators ask which prompt version ran on which call.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  actor      TEXT NOT NULL DEFAULT 'system',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`);

function audit(userId, actor, action, entity, entityId, detail) {
  db.prepare(
    'INSERT INTO audit_log (user_id, actor, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)'
  ).run(userId || null, actor || 'system', action, entity || '', String(entityId || ''), detail || '');
}

module.exports = { db, audit };
