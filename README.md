# Zorvia Dialer — UK debt collection voice console

Zorvia Dialer is an AI voice agent platform for UK collections. You paste your Vapi and Twilio
credentials into Settings and it starts dialling. Node.js, SQLite, no build step.

Deploying to Railway? See **DEPLOY-RAILWAY.md** — the persistent-volume step
there is mandatory, not optional.

## Run it

```bash
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into APP_KEY
npm start
```

Open `http://localhost:3000` and sign in with the `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from your `.env`. Change that password straight away.

## Connect the providers

1. **Settings → Twilio.** Paste your Account SID and Auth Token. Press *Test
   connection*, then *List numbers*.
2. **Settings → Vapi.** Paste your private key from Vapi → Organisation → API
   keys. Press *Test connection*.
3. Back on the Twilio panel, press *Add to Vapi* next to the UK number you want
   to dial from. Copy the phone number ID it returns into the Vapi *Default
   phone number ID* field.
4. Make sure `PUBLIC_URL` in `.env` is a real HTTPS address. Vapi posts every
   call event to `PUBLIC_URL/api/webhooks/vapi`, and without it you get no
   transcripts, recordings or dispositions. In development, run
   `ngrok http 3000` and use the ngrok URL.

Keys are encrypted with AES-256-GCM before they touch the database and are only
ever shown masked afterwards.

## First campaign

1. **AI agents → New agent.** Write your SOP (how it should behave) and your
   script (what it should say). The agent is created in Vapi at the same time.
   Use *See full prompt* to read exactly what the model receives.
2. **Lead lists → New list.**
3. **Leads → Upload a list.** CSV headers:
   `reference, first_name, last_name, phone, postcode, dob, balance, creditor`.
   Numbers are converted to `+44` format; suppressed numbers are skipped.
4. **Campaigns → New campaign.** Pick the list, the agent, the calling window
   and concurrency. Press *Start*.

## What the platform enforces on its own

These are built into the dialler and the prompt, not left to the operator:

- **Identity gate.** The agent cannot discuss the debt until it has confirmed
  the person's name plus their date of birth or postcode. It reports this back
  through the `identity_verified` function, which is what the console shows.
- **No third-party disclosure.** If someone else answers, the agent says
  nothing about why it is calling.
- **Calling window.** Per campaign, in UK time, including British Summer Time.
  Outside it the dialler stops by itself.
- **Ofcom abandonment ceiling.** Rolling rate per campaign. Above 3% the
  campaign pauses automatically and the reason is written to the audit log.
- **Answering machine cooldown.** A number that hits voicemail is not redialled
  for 72 hours.
- **Vulnerability stop.** Any vulnerability signal flags the account, halts
  collections activity on it, and offers a transfer to a human.
- **Suppression list.** Checked at upload and again at dial time.
- **No card details.** The agent sends a payment link instead.
- **Audit log.** Credential changes, prompt edits, transcript views and every
  decision the agent made, append-only.
- **Sign-in throttling.** Six failed attempts per account and twenty per IP in a
  fifteen-minute window. Failures and lockouts are both audited.

## Roles

| Role | Can do |
|---|---|
| `admin` | Everything, including provider credentials and users |
| `supervisor` | Agents, campaigns, inbound routes, all call data |
| `agent` | Leads, calls, transcripts |
| `auditor` | Read-only, plus the audit log |

## Before you go live

The platform gives you the controls; it does not make you compliant on its own.

- The firm doing the collecting needs FCA permission for debt collection, and
  the way you use this has to sit inside CONC 7.
- Complete a DPIA before the first live campaign. Automated calling at scale
  with recordings is exactly the case UK GDPR expects one for.
- Set a retention schedule and delete on it. Collections records are commonly
  kept six years; raw call audio usually much less.
- Host in a UK or EU region.
- Decide whether the agent handles the whole conversation or verifies identity
  and hands to a human for the negotiation. The second is easier to defend and
  is how most compliant UK operations are running this today.
- Have your compliance lead read the guardrail block in
  `src/compliance.js` before you change a word of it.

## Branding

The Zorvia mark lives in `public/brand/`. Colours are sampled from it and set
once at the top of `public/styles.css` as `--z-blue`, `--z-indigo`, `--z-violet`,
`--z-rose` and `--z-orange`. Change those five values to reskin the whole console.

## Layout

```
server.js              Express entry point
src/db.js              Schema and audit helper
src/crypto.js          AES-256-GCM for stored credentials
src/auth.js            Login, sessions, roles
src/providers.js       Vapi and Twilio REST clients, credential storage
src/compliance.js      Calling windows, suppression, prompt assembly, guardrails
src/dialer.js          Campaign worker
src/routes.js          Dashboard API
src/webhook.js         Vapi events and agent function calls
public/                Console UI
public/brand/          Zorvia logo and icon mark
```

## Swapping SQLite for Postgres

`src/db.js` is the only file that talks to the database directly. The schema is
plain SQL; move it to Postgres and replace the `better-sqlite3` calls with `pg`.
Nothing else changes.
