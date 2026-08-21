const express = require('express');
const { db, audit } = require('./db');
const C = require('./compliance');

const router = express.Router();

function verify(req, res, next) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const supplied = req.get('x-vapi-secret') || req.get('x-vapi-signature');
  if (secret && supplied !== secret) return res.status(401).json({ error: 'Bad webhook secret' });
  next();
}

function callRow(vapiCallId) {
  return db.prepare('SELECT * FROM calls WHERE vapi_call_id = ?').get(vapiCallId);
}

function handleTool(call, name, args) {
  const leadId = call?.lead_id;
  switch (name) {
    case 'identity_verified':
      db.prepare('UPDATE calls SET identity_verified = 1 WHERE id = ?').run(call.id);
      audit(null, 'agent', 'call.identity_verified', 'call', call.id, `via ${args.detail_used}`);
      return { result: 'Identity confirmed. You may now discuss the account.' };

    case 'flag_vulnerability':
      db.prepare('UPDATE calls SET vulnerability_flag = 1 WHERE id = ?').run(call.id);
      if (leadId) db.prepare("UPDATE leads SET vulnerable = 1, status = 'closed' WHERE id = ?").run(leadId);
      audit(null, 'agent', 'call.vulnerability', 'call', call.id, args.reason || '');
      return { result: 'Flagged. Stop collections activity and offer a human colleague.' };

    case 'transfer_to_human':
      db.prepare('UPDATE calls SET transferred = 1 WHERE id = ?').run(call.id);
      audit(null, 'agent', 'call.transferred', 'call', call.id, args.reason || '');
      return { result: 'Transferring now. Tell the person a colleague is joining.' };

    case 'record_promise_to_pay': {
      const pence = Math.round((parseFloat(args.amount_pounds) || 0) * 100);
      db.prepare('INSERT INTO promises (lead_id, call_id, amount_pence, due_date, frequency) VALUES (?,?,?,?,?)')
        .run(leadId, call.id, pence, args.due_date || null, args.frequency || 'one_off');
      if (leadId) db.prepare("UPDATE leads SET status = 'ptp' WHERE id = ?").run(leadId);
      db.prepare("UPDATE calls SET disposition = 'promise_to_pay' WHERE id = ?").run(call.id);
      return { result: 'Recorded. Confirm the amount and date back to the person.' };
    }

    case 'send_payment_link':
      audit(null, 'agent', 'call.payment_link', 'call', call.id, String(args.amount_pounds || ''));
      return { result: 'A secure payment link has been sent by text message.' };

    case 'log_dispute':
      if (leadId) db.prepare("UPDATE leads SET status = 'disputed' WHERE id = ?").run(leadId);
      db.prepare("UPDATE calls SET disposition = 'disputed' WHERE id = ?").run(call.id);
      audit(null, 'agent', 'call.dispute', 'call', call.id, args.reason || '');
      return { result: 'Logged. Confirm that activity will pause while it is reviewed.' };

    case 'mark_do_not_call': {
      const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null;
      if (lead) {
        db.prepare('INSERT OR IGNORE INTO suppression (phone, reason) VALUES (?, ?)').run(lead.phone, 'requested on call');
        db.prepare("UPDATE leads SET status = 'do_not_call' WHERE id = ?").run(lead.id);
      }
      db.prepare("UPDATE calls SET disposition = 'do_not_call' WHERE id = ?").run(call.id);
      audit(null, 'agent', 'call.do_not_call', 'call', call.id, '');
      return { result: 'Confirmed. Thank them and end the call.' };
    }

    default:
      return { result: 'Unknown request.' };
  }
}

router.post('/vapi', express.json({ limit: '5mb' }), verify, (req, res) => {
  const msg = req.body?.message || {};
  const vapiCallId = msg.call?.id || req.body?.call?.id;
  const call = vapiCallId ? callRow(vapiCallId) : null;

  try {
    switch (msg.type) {
      case 'status-update': {
        if (call) db.prepare('UPDATE calls SET status = ? WHERE id = ?').run(msg.status || call.status, call.id);
        break;
      }

      case 'tool-calls':
      case 'function-call': {
        const toolCalls = msg.toolCalls || msg.toolCallList || (msg.functionCall ? [{ id: 'fc', function: msg.functionCall }] : []);
        if (!call) return res.json({ results: [] });
        const results = toolCalls.map((tc) => {
          const name = tc.function?.name || tc.name;
          let args = tc.function?.arguments ?? tc.parameters ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          const out = handleTool(call, name, args);
          return { toolCallId: tc.id, name, result: out.result };
        });
        return res.json({ results });
      }

      case 'end-of-call-report': {
        if (!call) break;
        const artifact = msg.artifact || {};
        const transcript = msg.transcript || artifact.transcript || '';
        const recording = msg.recordingUrl || artifact.recordingUrl || artifact.stereoRecordingUrl || null;
        const reason = msg.endedReason || '';

        db.prepare(
          `UPDATE calls SET status='ended', ended_reason=?, duration_sec=?, cost_usd=?,
             recording_url=?, transcript=?, summary=?, ended_at=datetime('now')
           WHERE id = ?`
        ).run(reason, Math.round(msg.durationSeconds || 0), msg.cost || 0, recording, transcript, msg.summary || '', call.id);

        if (call.lead_id) {
          if (/voicemail|machine/i.test(reason)) {
            C.applyAmdCooldown(call.lead_id);          // Ofcom 72-hour rule
            db.prepare("UPDATE leads SET status = 'new' WHERE id = ? AND status = 'queued'").run(call.lead_id);
          } else if ((msg.durationSeconds || 0) > 15) {
            db.prepare("UPDATE leads SET status = 'contacted' WHERE id = ? AND status = 'queued'").run(call.lead_id);
          } else {
            db.prepare("UPDATE leads SET status = 'new' WHERE id = ? AND status = 'queued'").run(call.lead_id);
          }
        }
        audit(null, 'system', 'call.ended', 'call', call.id, reason);
        break;
      }

      default:
        break;
    }
  } catch (e) {
    audit(null, 'system', 'webhook.error', 'call', call?.id || '', e.message);
  }

  res.json({ received: true });
});

module.exports = { router };
