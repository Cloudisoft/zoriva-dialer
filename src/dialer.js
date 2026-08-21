const { db, audit } = require('./db');
const { vapi, getCredentials } = require('./providers');
const C = require('./compliance');

const TICK_MS = 8000;
let timer = null;

function activeCallCount(campaignId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM calls WHERE campaign_id = ? AND status IN ('queued','ringing','in-progress')"
  ).get(campaignId);
  return row.n;
}

async function placeCall(campaign, lead, agent) {
  const creds = getCredentials('vapi') || {};
  const phoneNumberId = campaign.from_number || creds.phoneNumberId;
  if (!phoneNumberId) throw new Error('No outbound number selected for this campaign.');

  const payload = {
    phoneNumberId,
    customer: { number: C.normalise(lead.phone), name: `${lead.first_name} ${lead.last_name}`.trim() },
    assistantId: agent.vapi_assistant_id || undefined,
    assistantOverrides: {
      variableValues: {
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: campaign.name,
        reference: lead.reference,
      },
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: C.buildSystemPrompt(agent, lead, campaign.name) }],
        tools: C.toolDefinitions(),
      },
      firstMessage: agent.first_message || `Hello, may I speak with ${lead.first_name} please?`,
      metadata: { leadId: lead.id, campaignId: campaign.id, agentId: agent.id },
    },
  };

  const call = await vapi('/call', { method: 'POST', body: JSON.stringify(payload) });

  db.prepare(
    `INSERT INTO calls (vapi_call_id, campaign_id, lead_id, agent_id, direction, to_number, status)
     VALUES (?,?,?,?,'outbound',?, 'queued')`
  ).run(call.id || null, campaign.id, lead.id, agent.id, C.normalise(lead.phone));

  db.prepare(
    "UPDATE leads SET attempts = attempts + 1, last_attempt = datetime('now'), status = 'queued' WHERE id = ?"
  ).run(lead.id);

  audit(null, 'dialer', 'call.placed', 'lead', lead.id, `campaign ${campaign.id}`);
  return call;
}

async function tick() {
  const running = db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all();
  for (const campaign of running) {
    try {
      const win = C.windowState(campaign);
      if (!win.open) continue;

      const rate = C.abandonmentRate(campaign.id);
      if (rate > 3) {
        db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
        audit(null, 'dialer', 'campaign.autopaused', 'campaign', campaign.id,
          `Abandonment rate ${rate.toFixed(1)}% exceeded the 3% limit`);
        continue;
      }

      const slots = campaign.concurrency - activeCallCount(campaign.id);
      if (slots <= 0) continue;

      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(campaign.agent_id);
      if (!agent) continue;

      const leads = C.eligibleLeads(campaign, slots);
      if (leads.length === 0) {
        const remaining = db.prepare(
          "SELECT COUNT(*) AS n FROM leads WHERE list_id = ? AND status IN ('new','queued') AND attempts < ?"
        ).get(campaign.list_id, campaign.max_attempts).n;
        if (remaining === 0) {
          db.prepare("UPDATE campaigns SET status = 'finished' WHERE id = ?").run(campaign.id);
          audit(null, 'dialer', 'campaign.finished', 'campaign', campaign.id, 'No leads left to dial');
        }
        continue;
      }

      for (const lead of leads) {
        try {
          await placeCall(campaign, lead, agent);
        } catch (e) {
          audit(null, 'dialer', 'call.failed', 'lead', lead.id, e.message);
          db.prepare("UPDATE leads SET no_call_until = datetime('now','+30 minutes') WHERE id = ?").run(lead.id);
        }
      }
    } catch (e) {
      audit(null, 'dialer', 'campaign.error', 'campaign', campaign.id, e.message);
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log(`Dialer running, checking every ${TICK_MS / 1000}s`);
}

module.exports = { start, tick, placeCall };
