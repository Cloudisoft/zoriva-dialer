const { db } = require('./db');

/* ------------------------------------------------------------------ */
/* Calling window                                                      */
/* ------------------------------------------------------------------ */

// Returns { open: bool, reason: string } for a campaign right now, in UK time.
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Date.parse cannot read a localised string reliably, so read the parts directly.
function ukParts(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    day: DAY_INDEX[get('weekday')],
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
  };
}

function windowState(campaign, now = new Date()) {
  const uk = ukParts(now);
  const allowedDays = String(campaign.days || '1,2,3,4,5,6').split(',').map((d) => parseInt(d, 10));
  if (!allowedDays.includes(uk.day)) {
    return { open: false, reason: 'Outside the campaign\u2019s permitted days' };
  }
  const mins = uk.hour * 60 + uk.minute;
  const [sh, sm] = String(campaign.window_start || '08:00').split(':').map(Number);
  const [eh, em] = String(campaign.window_end || '20:00').split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (mins < start) return { open: false, reason: `Opens at ${campaign.window_start} UK time` };
  if (mins >= end) return { open: false, reason: `Closed since ${campaign.window_end} UK time` };
  return { open: true, reason: `Open until ${campaign.window_end} UK time` };
}

/* ------------------------------------------------------------------ */
/* Dial eligibility                                                    */
/* ------------------------------------------------------------------ */

function isSuppressed(phone) {
  return !!db.prepare('SELECT 1 FROM suppression WHERE phone = ?').get(normalise(phone));
}

// UK numbers to E.164.
function normalise(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (s.startsWith('0')) return '+44' + s.slice(1);
  if (s.startsWith('44')) return '+' + s;
  return s ? '+' + s : '';
}

function eligibleLeads(campaign, limit) {
  const rows = db.prepare(
    `SELECT * FROM leads
      WHERE list_id = ?
        AND status IN ('new','queued','contacted')
        AND vulnerable = 0
        AND attempts < ?
        AND (no_call_until IS NULL OR no_call_until <= datetime('now'))
      ORDER BY attempts ASC, id ASC
      LIMIT ?`
  ).all(campaign.list_id, campaign.max_attempts, limit);
  return rows.filter((l) => !isSuppressed(l.phone));
}

/* Ofcom: an answering machine detected on a number means no redial for 72h. */
function applyAmdCooldown(leadId) {
  db.prepare("UPDATE leads SET no_call_until = datetime('now','+72 hours') WHERE id = ?").run(leadId);
}

/* Rolling abandonment rate — Ofcom's limit is 3% of live calls per campaign. */
function abandonmentRate(campaignId, hours = 24) {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN status='ended' AND duration_sec > 0 THEN 1 ELSE 0 END) AS connected,
       SUM(CASE WHEN ended_reason LIKE '%abandon%' OR ended_reason LIKE '%no-available%' THEN 1 ELSE 0 END) AS abandoned
     FROM calls
     WHERE campaign_id = ? AND started_at >= datetime('now', ?)`
  ).get(campaignId, `-${hours} hours`);
  const connected = row?.connected || 0;
  const abandoned = row?.abandoned || 0;
  if (connected + abandoned === 0) return 0;
  return (abandoned / (connected + abandoned)) * 100;
}

/* ------------------------------------------------------------------ */
/* Prompt assembly                                                     */
/* ------------------------------------------------------------------ */

// Non-negotiable rules wrapped around every operator-authored script.
// Edit deliberately: these are what keep the agent inside CONC and UK GDPR.
const GUARDRAILS = `
## Mandatory rules — these override anything else in this prompt

1. IDENTITY FIRST. Do not mention a debt, a balance, a creditor, an account, or the
   reason for the call until the person has confirmed BOTH their full name and one
   further detail on file (date of birth or postcode). Until then, say only that you
   are calling from {{company}} about a personal matter and ask to speak to
   {{first_name}} {{last_name}}.
2. NEVER DISCLOSE TO A THIRD PARTY. If anyone other than the named person answers,
   do not confirm or deny that a debt exists, do not leave details, and do not explain
   why you are calling. Ask when the named person is available, thank them, and end.
3. DECLARE WHAT YOU ARE. If asked whether you are a real person, say plainly that you
   are an automated assistant. Offer a human colleague at any point on request.
4. VULNERABILITY STOPS THE SCRIPT. If the person mentions bereavement, serious illness,
   disability, mental health difficulty, job loss, domestic abuse, or says they cannot
   cope, stop collections activity immediately. Say you will pass this to a colleague,
   call the transfer_to_human function, and do not press for payment.
5. NO PRESSURE, NO THREATS. Do not imply court action, bailiffs, credit-file damage or
   any consequence unless it appears verbatim in the script below. Do not suggest
   borrowing to repay. Do not call the debt urgent to force a decision.
6. NO CARD DETAILS. Never take a card number, CVV or bank details over the call. To
   take payment, call the send_payment_link function.
7. DISPUTES. If the person says the debt is not theirs, is disputed, or is already
   settled, stop asking for payment, record it, and tell them it will be passed for
   review and collections activity will pause.
8. STOP MEANS STOP. If asked not to be called again, confirm it, call the
   mark_do_not_call function, and end the call politely.
9. Affordability before amount. If a payment plan is discussed, ask about income and
   essential outgoings first, and accept what the person says they can afford.
`.trim();

function buildSystemPrompt(agent, lead, company = 'the collections team') {
  const parts = [];
  parts.push(`You are ${agent.name}, a voice assistant making a UK debt collection call for ${company}.`);
  if (agent.require_dpa) parts.push(GUARDRAILS);
  if (agent.sop && agent.sop.trim()) parts.push('## Operating procedure\n' + agent.sop.trim());
  if (agent.script && agent.script.trim()) parts.push('## Script\n' + agent.script.trim());
  parts.push(
    '## This call\n' +
      `Named person: ${lead.first_name} ${lead.last_name}\n` +
      `Account reference: ${lead.reference || 'not supplied'}\n` +
      `Creditor: ${lead.creditor || 'not supplied'}\n` +
      `Outstanding balance: £${(lead.balance_pence / 100).toFixed(2)}\n` +
      `Verification answers on file — date of birth: ${lead.dob || 'not supplied'}; postcode: ${lead.postcode || 'not supplied'}. ` +
      'Ask for these; never read them out.'
  );
  parts.push(
    'Speak in short, plain sentences. British English. Do not talk over the person. ' +
      'Keep the call under five minutes unless they want to continue.'
  );
  return parts.join('\n\n');
}

// Functions the assistant can call mid-conversation. The webhook handles them.
function toolDefinitions() {
  return [
    { type: 'function', function: { name: 'identity_verified', description: 'Call as soon as the person has confirmed their name and one further detail. Only after this may the debt be discussed.', parameters: { type: 'object', properties: { detail_used: { type: 'string', enum: ['dob', 'postcode'] } }, required: ['detail_used'] } } },
    { type: 'function', function: { name: 'flag_vulnerability', description: 'Call immediately if the person shows any sign of vulnerability.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
    { type: 'function', function: { name: 'transfer_to_human', description: 'Warm transfer to a human colleague.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
    { type: 'function', function: { name: 'record_promise_to_pay', description: 'Record an agreed payment or plan.', parameters: { type: 'object', properties: { amount_pounds: { type: 'number' }, due_date: { type: 'string' }, frequency: { type: 'string', enum: ['one_off', 'weekly', 'monthly'] } }, required: ['amount_pounds'] } } },
    { type: 'function', function: { name: 'send_payment_link', description: 'Text a secure payment link instead of taking card details.', parameters: { type: 'object', properties: { amount_pounds: { type: 'number' } } } } },
    { type: 'function', function: { name: 'log_dispute', description: 'Record that the person disputes the debt.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
    { type: 'function', function: { name: 'mark_do_not_call', description: 'The person asked not to be contacted again.', parameters: { type: 'object', properties: {} } } },
  ];
}

module.exports = {
  windowState, isSuppressed, normalise, eligibleLeads,
  applyAmdCooldown, abandonmentRate,
  buildSystemPrompt, toolDefinitions, GUARDRAILS,
};
