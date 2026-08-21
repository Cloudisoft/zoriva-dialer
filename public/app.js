/* Zorvia Dialer — collections console. Vanilla SPA, hash routed, no build step. */

const $ = (s) => document.querySelector(s);
const view = () => $('#view');
let ME = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (pence) => '£' + ((pence || 0) / 100).toFixed(2);
const when = (t) => (t ? new Date(t.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function notice(msg, kind = '') { return `<p class="note ${kind}">${esc(msg)}</p>`; }
function tag(text, kind = '') { return `<span class="tag ${kind}">${esc(text)}</span>`; }

const human = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');

function statusTag(s) {
  const map = { running: 'live', 'in-progress': 'live', ended: '', paused: 'hold', queued: 'hold', ringing: 'hold', failed: 'stop', do_not_call: 'stop', disputed: 'stop', ptp: 'live' };
  return tag(human(s), map[s] || '');
}

function modal(title, html) {
  $('#modal-head').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
}

/* ------------------------------ sign in ------------------------------ */

async function boot() {
  try {
    const { user } = await api('/auth/me');
    ME = user;
    $('#login').classList.remove('on');
    $('#app').classList.add('on');
    $('#whoami').textContent = `${user.name || user.email} · ${user.role}`;
    $('#avatar').textContent = (user.name || user.email).trim().slice(0, 1).toUpperCase();
    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/dashboard';
    route();
    setInterval(refreshStrip, 10000);
  } catch {
    $('#login').classList.add('on');
    $('#app').classList.remove('on');
  }
}

$('#li-go').onclick = async () => {
  $('#li-msg').innerHTML = '';
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#li-email').value, password: $('#li-pass').value }) });
    location.reload();
  } catch (e) { $('#li-msg').innerHTML = notice(e.message, 'bad'); }
};
$('#li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#li-go').click(); });
$('#signout').onclick = async (e) => { e.preventDefault(); await api('/auth/logout', { method: 'POST' }); location.reload(); };

/* --------------------------- compliance strip ------------------------- */

async function refreshStrip() {
  if (!ME) return;
  try {
    const [d, campaigns] = await Promise.all([api('/dashboard'), api('/campaigns')]);
    const running = campaigns.filter((c) => c.status === 'running');
    const worst = running.reduce((m, c) => Math.max(m, c.abandonment || 0), 0);
    const openNow = running.filter((c) => c.window.open).length;
    const windowLine = running.length === 0
      ? 'No campaign running'
      : (openNow > 0 ? running.find((c) => c.window.open).window.reason : running[0].window.reason);
    const pct = Math.min(100, (worst / 3) * 100);
    const gaugeClass = worst > 3 ? 'over' : worst > 2 ? 'warn' : '';

    $('#strip').innerHTML = `
      <div class="cell">
        <div class="label">Calling window</div>
        <div class="val"><span class="dot ${openNow > 0 ? 'live' : 'hold'}"></span>${openNow > 0 ? 'Open' : 'Closed'}</div>
        <div class="sub">${esc(windowLine)}</div>
      </div>
      <div class="cell">
        <div class="label">Abandonment</div>
        <div class="val">${worst.toFixed(2)}%</div>
        <div class="gauge ${gaugeClass}"><span style="width:${pct}%"></span></div>
        <div class="sub">Ofcom ceiling 3%</div>
      </div>
      <div class="cell"><div class="label">Live calls</div><div class="val">${d.liveCalls}</div><div class="sub">${d.runningCampaigns} campaign${d.runningCampaigns === 1 ? '' : 's'} running</div></div>
      <div class="cell"><div class="label">Identity verified</div><div class="val">${d.verifiedToday} / ${d.callsToday}</div><div class="sub">today</div></div>
      <div class="cell"><div class="label">Vulnerability flags</div><div class="val">${d.vulnerableFlags > 0 ? '<span class="dot stop"></span>' : ''}${d.vulnerableFlags}</div><div class="sub">activity halted</div></div>
      <div class="cell"><div class="label">Suppressed</div><div class="val">${d.suppressed}</div><div class="sub">numbers blocked</div></div>`;
  } catch { /* strip is informational; stay quiet on failure */ }
}

/* ------------------------------ routing ------------------------------ */

const routes = {
  dashboard: ['Dashboard', renderDashboard],
  campaigns: ['Campaigns', renderCampaigns],
  live: ['Live monitor', renderLive],
  calls: ['Call history', renderCalls],
  lists: ['Lead lists', renderLists],
  leads: ['Leads', renderLeads],
  agents: ['AI agents', renderAgents],
  inbound: ['Inbound routes', renderInbound],
  users: ['Users', renderUsers],
  audit: ['Audit log', renderAudit],
  settings: ['Settings', renderSettings],
};

async function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
  const [title, fn] = routes[name] || routes.dashboard;
  $('#page-title').textContent = title;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('sel', a.getAttribute('href') === `#/${name}`));
  view().innerHTML = '<div class="empty">Loading…</div>';
  refreshStrip();
  try { await fn(); } catch (e) { view().innerHTML = notice(e.message, 'bad'); }
}

/* ----------------------------- dashboard ----------------------------- */

async function renderDashboard() {
  const d = await api('/dashboard');
  const metric = (label, n, cls = '') => `<div class="card metric"><div class="label">${label}</div><div class="n ${cls}">${n}</div></div>`;
  view().innerHTML = `
    <div class="grid" style="margin-bottom:22px">
      ${metric('Calls today', d.callsToday)}
      ${metric('Reached a person', d.connectedToday)}
      ${metric('Identity verified', d.verifiedToday)}
      ${metric('Promised today', money(d.promisedPence))}
      ${metric('Campaigns running', d.runningCampaigns)}
      ${metric('Vulnerability flags', d.vulnerableFlags, d.vulnerableFlags ? 'stop' : '')}
    </div>
    <section class="panel">
      <h2>Latest calls</h2>
      ${d.recent.length === 0 ? '<div class="empty"><strong>No calls yet</strong>Create an AI agent, upload a lead list, then start a campaign.</div>' : `
      <div class="tablecard"><table><thead><tr><th>Person</th><th>Status</th><th>Verified</th><th>Disposition</th><th class="num">Length</th><th>Started</th><th></th></tr></thead>
      <tbody>${d.recent.map((c) => `
        <tr>
          <td>${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown')}</td>
          <td>${statusTag(c.status)}</td>
          <td>${c.identity_verified ? tag('yes', 'live') : tag('no', 'hold')}${c.vulnerability_flag ? ' ' + tag('vulnerable', 'stop') : ''}</td>
          <td>${esc(human(c.disposition))}</td>
          <td class="num">${dur(c.duration_sec)}</td>
          <td>${when(c.started_at)}</td>
          <td><button class="ghost sm" onclick="openCall(${c.id})">Open</button></td>
        </tr>`).join('')}</tbody></table></div>`}
    </section>`;
}

/* ----------------------------- campaigns ----------------------------- */

async function renderCampaigns() {
  const [campaigns, lists, agents] = await Promise.all([api('/campaigns'), api('/lists'), api('/agents')]);
  view().innerHTML = `
    <section class="panel">
      <h2>Campaigns</h2>
      ${campaigns.length === 0 ? '<div class="empty"><strong>Nothing scheduled</strong>Create a campaign below to start dialling a list.</div>' : `
      <div class="tablecard"><table><thead><tr><th>Name</th><th>List</th><th>Agent</th><th>Status</th><th>Window</th><th class="num">Abandon</th><th class="num">Calls</th><th></th></tr></thead>
      <tbody>${campaigns.map((c) => `
        <tr>
          <td><strong>${esc(c.name)}</strong></td>
          <td>${esc(c.list_name || '—')}<div class="sub">${c.total_leads} leads</div></td>
          <td>${esc(c.agent_name || '—')}</td>
          <td>${statusTag(c.status)}</td>
          <td>${esc(c.window_start)}–${esc(c.window_end)}<div class="sub">${esc(c.window.reason)}</div></td>
          <td class="num">${c.abandonment.toFixed(2)}%</td>
          <td class="num">${c.calls_made}</td>
          <td>${c.status === 'running'
            ? `<button class="ghost sm" onclick="campaignAction(${c.id},'pause')">Pause</button>`
            : `<button class="sm" onclick="campaignAction(${c.id},'start')">Start</button>`}</td>
        </tr>`).join('')}</tbody></table></div>`}
    </section>

    <section class="panel">
      <h2>New campaign</h2>
      <div class="card">
        <div class="row">
          <label class="f"><span>Name</span><input id="c-name" placeholder="Northbank arrears — August"></label>
          <label class="f"><span>Lead list</span><select id="c-list">${lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.lead_count})</option>`).join('')}</select></label>
          <label class="f"><span>AI agent</span><select id="c-agent">${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
        </div>
        <div class="row">
          <label class="f"><span>Outbound number ID</span><input id="c-from" placeholder="Vapi phone number ID"><em>Leave blank to use the default set in Settings.</em></label>
          <label class="f"><span>Concurrent calls</span><input id="c-conc" type="number" value="2" min="1" max="30"><em>Keep this low until your abandonment rate is proven.</em></label>
          <label class="f"><span>Attempts per person</span><input id="c-att" type="number" value="3" min="1" max="12"></label>
        </div>
        <div class="row">
          <label class="f"><span>Calls from</span><input id="c-ws" type="time" value="08:00"></label>
          <label class="f"><span>Calls until</span><input id="c-we" type="time" value="20:00"><em>UK time. Outside this the dialler stops on its own.</em></label>
          <label class="f"><span>Days</span><input id="c-days" value="1,2,3,4,5,6"><em>0 is Sunday.</em></label>
        </div>
        <button onclick="createCampaign()">Create campaign</button>
        <div id="c-msg"></div>
      </div>
    </section>`;
}

window.createCampaign = async () => {
  try {
    await api('/campaigns', { method: 'POST', body: JSON.stringify({
      name: $('#c-name').value, list_id: $('#c-list').value, agent_id: $('#c-agent').value,
      from_number: $('#c-from').value, concurrency: +$('#c-conc').value, max_attempts: +$('#c-att').value,
      window_start: $('#c-ws').value, window_end: $('#c-we').value, days: $('#c-days').value }) });
    route();
  } catch (e) { $('#c-msg').innerHTML = notice(e.message, 'bad'); }
};

window.campaignAction = async (id, action) => { await api(`/campaigns/${id}/${action}`, { method: 'POST' }); route(); };

/* ---------------------------- live monitor ---------------------------- */

let liveTimer = null;
async function renderLive() {
  clearInterval(liveTimer);
  const draw = async () => {
    if (!location.hash.startsWith('#/live')) return clearInterval(liveTimer);
    const calls = await api('/calls/live');
    view().innerHTML = calls.length === 0
      ? '<div class="empty"><strong>Nothing in progress</strong>This view refreshes every five seconds.</div>'
      : `<div class="tablecard"><table><thead><tr><th>Person</th><th>Number</th><th>Agent</th><th>Campaign</th><th>Status</th><th>Verified</th><th>Started</th></tr></thead>
         <tbody>${calls.map((c) => `<tr>
           <td>${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || '—')}</td>
           <td class="num">${esc(c.to_number)}</td>
           <td>${esc(c.agent_name || '—')}</td>
           <td>${esc(c.campaign_name || '—')}</td>
           <td>${statusTag(c.status)}</td>
           <td>${c.identity_verified ? tag('verified', 'live') : tag('not yet', 'hold')}</td>
           <td>${when(c.started_at)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  await draw();
  liveTimer = setInterval(draw, 5000);
}

/* ---------------------------- call history ---------------------------- */

async function renderCalls() {
  const calls = await api('/calls?limit=200');
  view().innerHTML = calls.length === 0 ? '<div class="empty"><strong>No calls recorded yet</strong>Transcripts and recordings appear here once a campaign runs.</div>' : `
    <div class="tablecard"><table><thead><tr><th>Person</th><th>Reference</th><th>Agent</th><th>Status</th><th>Ended because</th><th class="num">Length</th><th>Started</th><th></th></tr></thead>
    <tbody>${calls.map((c) => `<tr>
      <td>${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || '—')}${c.vulnerability_flag ? ' ' + tag('vulnerable', 'stop') : ''}</td>
      <td class="num">${esc(c.reference || '—')}</td>
      <td>${esc(c.agent_name || '—')}</td>
      <td>${statusTag(c.status)}</td>
      <td>${esc(human(c.ended_reason))}</td>
      <td class="num">${dur(c.duration_sec)}</td>
      <td>${when(c.started_at)}</td>
      <td><button class="ghost sm" onclick="openCall(${c.id})">Transcript</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

window.openCall = async (id) => {
  const c = await api(`/calls/${id}`);
  modal(`Call ${c.id} — ${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.to_number}`, `
    <div class="kv">
      <div><div class="label">Status</div>${statusTag(c.status)}</div>
      <div><div class="label">Identity</div>${c.identity_verified ? tag('verified', 'live') : tag('not verified', 'hold')}</div>
      <div><div class="label">Length</div><span class="num">${dur(c.duration_sec)}</span></div>
      <div><div class="label">Disposition</div>${esc(human(c.disposition))}</div>
    </div>
    ${c.vulnerability_flag ? notice('A vulnerability was flagged on this call. Collections activity is paused for this account.', 'bad') : ''}
    ${c.recording_url ? `<div class="label">Recording</div><audio controls src="${esc(c.recording_url)}"></audio>` : notice('No recording is attached to this call.')}
    ${c.summary ? `<div class="label" style="margin-top:14px">Summary</div><p style="margin:4px 0 0">${esc(c.summary)}</p>` : ''}
    <div class="label" style="margin-top:14px">Transcript</div>
    <pre class="transcript">${esc(c.transcript || 'No transcript available.')}</pre>`);
};

/* ------------------------------- lists -------------------------------- */

async function renderLists() {
  const lists = await api('/lists');
  view().innerHTML = `
    <section class="panel">
      <h2>Lead lists</h2>
      ${lists.length === 0 ? '<div class="empty"><strong>No lists yet</strong>Create one, then upload a CSV of accounts into it.</div>' : `
      <div class="tablecard"><table><thead><tr><th>Name</th><th>Client</th><th class="num">Leads</th><th>Created</th><th></th></tr></thead>
      <tbody>${lists.map((l) => `<tr><td><strong>${esc(l.name)}</strong></td><td>${esc(l.client || '—')}</td>
        <td class="num">${l.lead_count}</td><td>${when(l.created_at)}</td>
        <td><a href="#/leads">View leads</a></td></tr>`).join('')}</tbody></table></div>`}
    </section>
    <section class="panel">
      <h2>New list</h2>
      <div class="card">
        <div class="row">
          <label class="f"><span>List name</span><input id="l-name" placeholder="Northbank Cards — 60 day arrears"></label>
          <label class="f"><span>Client</span><input id="l-client" placeholder="Northbank Cards Ltd"></label>
        </div>
        <button onclick="createList()">Create list</button>
        <div id="l-msg"></div>
      </div>
    </section>`;
}

window.createList = async () => {
  try { await api('/lists', { method: 'POST', body: JSON.stringify({ name: $('#l-name').value, client: $('#l-client').value }) }); route(); }
  catch (e) { $('#l-msg').innerHTML = notice(e.message, 'bad'); }
};

/* ------------------------------- leads -------------------------------- */

async function renderLeads() {
  const [leads, lists] = await Promise.all([api('/leads'), api('/lists')]);
  const listOptions = lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  view().innerHTML = `
    <section class="panel">
      <h2>Upload a list</h2>
      <div class="card">
        <p style="margin-top:0;font-size:13px;color:var(--muted)">
          CSV headers: <span class="num">reference, first_name, last_name, phone, postcode, dob, balance, creditor</span>.
          Phone numbers are converted to +44 format. Anyone on the suppression list is skipped automatically.
        </p>
        <div class="row">
          <label class="f"><span>Into list</span><select id="u-list">${listOptions}</select></label>
          <label class="f"><span>CSV file</span><input id="u-file" type="file" accept=".csv,text/csv"></label>
        </div>
        <button onclick="uploadCsv()">Upload leads</button>
        <div id="u-msg"></div>
      </div>
    </section>

    <section class="panel">
      <h2>Add one lead</h2>
      <div class="card">
        <div class="row">
          <label class="f"><span>List</span><select id="s-list">${listOptions}</select></label>
          <label class="f"><span>Reference</span><input id="s-ref"></label>
          <label class="f"><span>First name</span><input id="s-first"></label>
          <label class="f"><span>Last name</span><input id="s-last"></label>
        </div>
        <div class="row">
          <label class="f"><span>Phone</span><input id="s-phone" placeholder="07700 900123"></label>
          <label class="f"><span>Postcode</span><input id="s-post"><em>Used for the identity check.</em></label>
          <label class="f"><span>Date of birth</span><input id="s-dob" placeholder="1984-06-02"></label>
          <label class="f"><span>Balance (£)</span><input id="s-bal" type="number" step="0.01"></label>
        </div>
        <button onclick="addLead()">Add lead</button>
        <div id="s-msg"></div>
      </div>
    </section>

    <section class="panel">
      <h2>Leads</h2>
      ${leads.length === 0 ? '<div class="empty"><strong>No leads yet</strong>Upload a CSV or add a single account above.</div>' : `
      <div class="tablecard"><table><thead><tr><th>Name</th><th>Reference</th><th>Phone</th><th class="num">Balance</th><th>Status</th><th class="num">Attempts</th><th>Next allowed</th><th></th></tr></thead>
      <tbody>${leads.map((l) => `<tr>
        <td>${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '—')}${l.vulnerable ? ' ' + tag('vulnerable', 'stop') : ''}</td>
        <td class="num">${esc(l.reference || '—')}</td>
        <td class="num">${esc(l.phone)}</td>
        <td class="num">${money(l.balance_pence)}</td>
        <td>${statusTag(l.status)}</td>
        <td class="num">${l.attempts}</td>
        <td>${l.no_call_until ? when(l.no_call_until) : 'now'}</td>
        <td><button class="ghost sm" onclick="dnc(${l.id})">Do not call</button></td>
      </tr>`).join('')}</tbody></table></div>`}
    </section>`;
}

window.uploadCsv = async () => {
  const file = $('#u-file').files[0];
  if (!file) return ($('#u-msg').innerHTML = notice('Choose a CSV file first.', 'bad'));
  const fd = new FormData();
  fd.append('file', file);
  fd.append('list_id', $('#u-list').value);
  try {
    const r = await api('/leads/import', { method: 'POST', body: fd });
    $('#u-msg').innerHTML = notice(
      `${r.imported} leads added. ${r.suppressed} skipped as suppressed, ${r.invalid} rejected.` +
      (r.errors.length ? ' ' + r.errors.join(' · ') : ''), r.imported ? 'good' : 'bad');
    setTimeout(route, 1200);
  } catch (e) { $('#u-msg').innerHTML = notice(e.message, 'bad'); }
};

window.addLead = async () => {
  try {
    await api('/leads', { method: 'POST', body: JSON.stringify({
      list_id: $('#s-list').value, reference: $('#s-ref').value, first_name: $('#s-first').value,
      last_name: $('#s-last').value, phone: $('#s-phone').value, postcode: $('#s-post').value,
      dob: $('#s-dob').value, balance: $('#s-bal').value }) });
    route();
  } catch (e) { $('#s-msg').innerHTML = notice(e.message, 'bad'); }
};

window.dnc = async (id) => { await api(`/leads/${id}/do-not-call`, { method: 'POST' }); route(); };

/* ------------------------------- agents ------------------------------- */

async function renderAgents() {
  const agents = await api('/agents');
  view().innerHTML = `
    <section class="panel">
      <h2>AI agents</h2>
      ${agents.length === 0 ? '<div class="empty"><strong>No agents yet</strong>Create one below. It is registered with Vapi at the same time.</div>' : `
      <div class="tablecard"><table><thead><tr><th>Name</th><th>Voice</th><th>Vapi assistant</th><th>Identity gate</th><th></th></tr></thead>
      <tbody>${agents.map((a) => `<tr>
        <td><strong>${esc(a.name)}</strong></td>
        <td>${esc(a.voice_id)}</td>
        <td class="num">${a.vapi_assistant_id ? esc(a.vapi_assistant_id.slice(0, 8)) + '…' : tag('not synced', 'stop')}</td>
        <td>${a.require_dpa ? tag('enforced', 'live') : tag('off', 'stop')}</td>
        <td><button class="ghost sm" onclick="previewPrompt(${a.id})">See full prompt</button></td>
      </tr>`).join('')}</tbody></table></div>`}
    </section>

    <section class="panel">
      <h2>New agent</h2>
      <div class="card">
        <div class="row">
          <label class="f"><span>Agent name</span><input id="a-name" placeholder="Arrears — first contact"></label>
          <label class="f"><span>Voice</span><input id="a-voice" value="burt"><em>A Vapi voice ID.</em></label>
          <label class="f"><span>Transfer number</span><input id="a-handoff" placeholder="+44…"><em>Where vulnerable calls go.</em></label>
        </div>
        <label class="f"><span>Opening line</span>
          <input id="a-first" value="Hello, may I speak with {{first_name}} please?">
          <em>Keep it neutral. No mention of a debt before identity is confirmed.</em></label>
        <label class="f"><span>Operating procedure (SOP)</span>
          <textarea id="a-sop" placeholder="How the agent should behave: tone, escalation, when to stop, what to do with objections…"></textarea>
          <em>Behaviour and judgement, not words to say.</em></label>
        <label class="f"><span>Call script</span>
          <textarea id="a-script" placeholder="Stage 1 — identity&#10;Stage 2 — reason for the call&#10;Stage 3 — affordability&#10;Stage 4 — arrangement and close"></textarea>
          <em>The words. Use {{first_name}}, {{last_name}}, {{reference}} as placeholders.</em></label>
        <label class="f" style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" id="a-dpa" checked>
          <span style="margin:0">Enforce the identity check and collections guardrails</span></label>
        <button onclick="createAgent()">Create agent</button>
        <div id="a-msg"></div>
      </div>
    </section>`;
}

window.createAgent = async () => {
  try {
    const r = await api('/agents', { method: 'POST', body: JSON.stringify({
      name: $('#a-name').value, voice_id: $('#a-voice').value, first_message: $('#a-first').value,
      sop: $('#a-sop').value, script: $('#a-script').value, require_dpa: $('#a-dpa').checked,
      handoff_number: $('#a-handoff').value }) });
    if (r.warning) { $('#a-msg').innerHTML = notice(r.warning, 'bad'); setTimeout(route, 2500); }
    else route();
  } catch (e) { $('#a-msg').innerHTML = notice(e.message, 'bad'); }
};

window.previewPrompt = async (id) => {
  const r = await api(`/agents/${id}/preview`);
  modal('Prompt sent to the model', `<p style="margin-top:0;font-size:13px;color:var(--muted)">This is the exact system prompt, filled with a sample account.</p><pre class="transcript">${esc(r.prompt)}</pre>`);
};

/* --------------------------- inbound routes --------------------------- */

async function renderInbound() {
  const [routesList, agents] = await Promise.all([api('/inbound-routes'), api('/agents')]);
  view().innerHTML = `
    <section class="panel">
      <h2>Inbound routes</h2>
      ${routesList.length === 0 ? '<div class="empty"><strong>No routes yet</strong>Map a number to an agent so returned calls are answered.</div>' : `
      <div class="tablecard"><table><thead><tr><th>Number</th><th>Answered by</th><th>Description</th><th>Active</th></tr></thead>
      <tbody>${routesList.map((r) => `<tr><td class="num">${esc(r.did)}</td><td>${esc(r.agent_name || '—')}</td>
        <td>${esc(r.description || '—')}</td><td>${r.active ? tag('yes', 'live') : tag('no', 'stop')}</td></tr>`).join('')}</tbody></table></div>`}
    </section>
    <section class="panel">
      <h2>Add a route</h2>
      <div class="card">
        <div class="row">
          <label class="f"><span>Number</span><input id="r-did" placeholder="+44 20 7946 0000"></label>
          <label class="f"><span>Answered by</span><select id="r-agent">${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
          <label class="f"><span>Description</span><input id="r-desc" placeholder="Callbacks from the arrears campaign"></label>
        </div>
        <button onclick="addRoute()">Save route</button>
        <div id="r-msg"></div>
      </div>
    </section>`;
}

window.addRoute = async () => {
  try {
    const r = await api('/inbound-routes', { method: 'POST', body: JSON.stringify({
      did: $('#r-did').value, agent_id: $('#r-agent').value, description: $('#r-desc').value }) });
    if (r.warning) { $('#r-msg').innerHTML = notice(r.warning, 'bad'); setTimeout(route, 2200); } else route();
  } catch (e) { $('#r-msg').innerHTML = notice(e.message, 'bad'); }
};

/* -------------------------------- users -------------------------------- */

async function renderUsers() {
  if (ME.role !== 'admin') return (view().innerHTML = notice('Only administrators can manage users.'));
  const users = await api('/users');
  view().innerHTML = `
    <section class="panel">
      <h2>Dashboard users</h2>
      <div class="tablecard"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr><td>${esc(u.name || '—')}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
        <td>${u.active ? tag('active', 'live') : tag('disabled', 'stop')}</td><td>${when(u.created_at)}</td>
        <td>${u.id === ME.id ? '' : `<button class="ghost sm" onclick="toggleUser(${u.id})">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('')}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Add a user</h2>
      <div class="card">
        <div class="row">
          <label class="f"><span>Name</span><input id="us-name"></label>
          <label class="f"><span>Email</span><input id="us-email" type="email"></label>
          <label class="f"><span>Password</span><input id="us-pass" type="password"><em>At least 10 characters.</em></label>
          <label class="f"><span>Role</span><select id="us-role">
            <option value="agent">Agent — handles calls and leads</option>
            <option value="supervisor">Supervisor — also runs campaigns and agents</option>
            <option value="auditor">Auditor — read-only, plus the audit log</option>
            <option value="admin">Administrator — everything, including credentials</option>
          </select></label>
        </div>
        <button onclick="addUser()">Add user</button>
        <div id="us-msg"></div>
      </div>
    </section>`;
}

window.addUser = async () => {
  try {
    await api('/users', { method: 'POST', body: JSON.stringify({
      name: $('#us-name').value, email: $('#us-email').value, password: $('#us-pass').value, role: $('#us-role').value }) });
    route();
  } catch (e) { $('#us-msg').innerHTML = notice(e.message, 'bad'); }
};
window.toggleUser = async (id) => { await api(`/users/${id}/toggle`, { method: 'POST' }); route(); };

/* ------------------------------ audit log ------------------------------ */

async function renderAudit() {
  const rows = await api('/audit');
  view().innerHTML = rows.length === 0 ? '<div class="empty"><strong>Nothing logged yet</strong>Every credential change, prompt edit and agent decision lands here.</div>' : `
    <p class="note">Every credential change, prompt edit, transcript view and agent decision is recorded here and cannot be edited.</p>
    <div class="tablecard"><table><thead><tr><th>When</th><th>By</th><th>Action</th><th>On</th><th>Detail</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${when(r.at)}</td><td>${esc(r.actor)}</td>
      <td class="num">${esc(r.action)}</td><td>${esc(r.entity)} ${esc(r.entity_id)}</td>
      <td style="max-width:420px">${esc((r.detail || '').slice(0, 220))}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ------------------------------- settings ------------------------------ */

async function renderSettings() {
  if (ME.role !== 'admin') return (view().innerHTML = notice('Only administrators can view credentials.'));
  const creds = await api('/settings/credentials');
  const v = creds.vapi || { status: 'not set', fields: {} };
  const t = creds.twilio || { status: 'not set', fields: {} };
  const badge = (s) => (s === 'ok' ? tag('connected', 'live') : s === 'failed' ? tag('failed', 'stop') : tag(s || 'not set', 'hold'));

  view().innerHTML = `
    <p class="note">Keys are encrypted before they are written to disk and are never shown again in full. Leave a field blank to keep the value already stored.</p>

    <section class="panel">
      <h2>Vapi ${badge(v.status)}</h2>
      <div class="card">
        ${v.statusMsg ? notice(v.statusMsg, v.status === 'ok' ? 'good' : 'bad') : ''}
        <div class="row">
          <label class="f"><span>Private key</span><input id="v-priv" type="password" placeholder="${esc(v.fields.privateKey || 'not set')}"><em>Dashboard → Organisation → API keys.</em></label>
          <label class="f"><span>Public key</span><input id="v-pub" placeholder="${esc(v.fields.publicKey || 'not set')}"><em>Optional, for browser-side calls.</em></label>
          <label class="f"><span>Default phone number ID</span><input id="v-num" placeholder="${esc(v.fields.phoneNumberId || 'not set')}"><em>Used when a campaign has no number of its own.</em></label>
        </div>
        <div class="actions"><button onclick="saveCreds('vapi')">Save Vapi keys</button>
        <button class="ghost" onclick="testCreds('vapi')">Test connection</button></div>
        <div id="v-msg"></div>
      </div>
    </section>

    <section class="panel">
      <h2>Twilio ${badge(t.status)}</h2>
      <div class="card">
        ${t.statusMsg ? notice(t.statusMsg, t.status === 'ok' ? 'good' : 'bad') : ''}
        <div class="row">
          <label class="f"><span>Account SID</span><input id="t-sid" placeholder="${esc(t.fields.accountSid || 'ACxxxxxxxx')}"></label>
          <label class="f"><span>Auth token</span><input id="t-tok" type="password" placeholder="${esc(t.fields.authToken || 'not set')}"></label>
          <label class="f"><span>Default caller ID</span><input id="t-num" placeholder="${esc(t.fields.defaultNumber || '+44…')}"><em>Use a UK geographic number. Answer rates are much higher.</em></label>
        </div>
        <div class="actions"><button onclick="saveCreds('twilio')">Save Twilio keys</button>
        <button class="ghost" onclick="testCreds('twilio')">Test connection</button>
        <button class="ghost" onclick="loadNumbers()">List numbers</button></div>
        <div id="t-msg"></div>
        <div id="t-nums"></div>
      </div>
    </section>

    <section class="panel">
      <h2>Webhook</h2>
      <div class="card">
        <p style="margin-top:0;font-size:13px">Vapi posts call events to this address. It must be reachable over HTTPS.</p>
        <pre class="transcript" style="max-height:none">${esc(location.origin)}/api/webhooks/vapi</pre>
      </div>
    </section>`;
}

window.saveCreds = async (which) => {
  const target = which === 'vapi' ? '#v-msg' : '#t-msg';
  try {
    const body = which === 'vapi'
      ? { privateKey: $('#v-priv').value, publicKey: $('#v-pub').value, phoneNumberId: $('#v-num').value }
      : { accountSid: $('#t-sid').value, authToken: $('#t-tok').value, defaultNumber: $('#t-num').value };
    await api(`/settings/credentials/${which}`, { method: 'POST', body: JSON.stringify(body) });
    $(target).innerHTML = notice('Saved. Test the connection to confirm the keys work.', 'good');
  } catch (e) { $(target).innerHTML = notice(e.message, 'bad'); }
};

window.testCreds = async (which) => {
  const target = which === 'vapi' ? '#v-msg' : '#t-msg';
  $(target).innerHTML = notice('Testing…');
  try {
    const r = await api(`/settings/credentials/${which}/test`, { method: 'POST' });
    $(target).innerHTML = notice(r.message, r.ok ? 'good' : 'bad');
  } catch (e) { $(target).innerHTML = notice(e.message, 'bad'); }
};

window.loadNumbers = async () => {
  $('#t-nums').innerHTML = '<p class="note">Loading numbers…</p>';
  try {
    const { twilioNumbers, vapiNumbers } = await api('/settings/numbers');
    const known = new Set(vapiNumbers.map((n) => n.number));
    $('#t-nums').innerHTML = twilioNumbers.length === 0
      ? notice('No numbers found on this Twilio account.')
      : `<div class="tablecard" style="margin-top:12px"><table><thead><tr><th>Number</th><th>Label</th><th>In Vapi</th><th></th></tr></thead>
         <tbody>${twilioNumbers.map((n) => `<tr><td class="num">${esc(n.number)}</td><td>${esc(n.friendlyName)}</td>
           <td>${known.has(n.number) ? tag('yes', 'live') : tag('no', 'hold')}</td>
           <td>${known.has(n.number) ? '' : `<button class="sm" onclick="importNumber('${esc(n.number)}')">Add to Vapi</button>`}</td></tr>`).join('')}</tbody></table></div>
         <p class="label" style="margin-top:10px">Vapi phone number IDs</p>
         <pre class="transcript" style="max-height:140px">${esc(vapiNumbers.map((n) => `${n.number}  ${n.id}`).join('\n') || 'none')}</pre>`;
  } catch (e) { $('#t-nums').innerHTML = notice(e.message, 'bad'); }
};

window.importNumber = async (number) => {
  try { await api('/settings/numbers/import', { method: 'POST', body: JSON.stringify({ number }) }); loadNumbers(); }
  catch (e) { $('#t-nums').innerHTML = notice(e.message, 'bad'); }
};

boot();
