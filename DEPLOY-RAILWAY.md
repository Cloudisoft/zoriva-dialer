# Deploying Zorvia Dialer to Railway

## 1. Push to GitHub

Unzip, then from inside the folder:

```bash
git init
git add .
git commit -m "Zorvia Dialer"
git branch -M main
git remote add origin https://github.com/YOUR_USER/zorvia-dialer.git
git push -u origin main
```

Make the repository **private**. It contains your collections guardrails and
prompt logic, and once it is live your team will be tempted to paste real data
into issues.

`.gitignore` already excludes `.env` and the database. Never commit either.

## 2. Create the Railway project

New Project → Deploy from GitHub repo → pick the repo. Railway detects Node and
builds automatically. Let the first deploy fail or warn; it needs the variables
below.

**Set the region to EU West (Amsterdam)** under Settings → Region. UK debtor
data should not sit in a US region.

## 3. Attach a volume — do not skip this

Railway's filesystem is wiped on every redeploy. Without a volume you lose the
database, the users, the call history, and the encrypted Vapi and Twilio keys,
every time you push a commit.

Service → Settings → Volumes → **New Volume**, mount path `/data`.

Then set `DB_PATH=/data/zorvia.db` in the variables below. The app prints a
warning on boot if you get this wrong.

## 4. Variables

Service → Variables. Generate the two secrets locally first:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # APP_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
```

| Variable | Value |
|---|---|
| `APP_KEY` | the 64-hex string from above |
| `SESSION_SECRET` | the long random string from above |
| `DB_PATH` | `/data/zorvia.db` |
| `PUBLIC_URL` | your Railway domain, `https://`, **no trailing slash** |
| `VAPI_WEBHOOK_SECRET` | any long random string |
| `ADMIN_EMAIL` | your login |
| `ADMIN_PASSWORD` | a strong password, changed after first sign-in |

Leave `PORT` alone — Railway injects it.

`APP_KEY` encrypts your stored provider credentials. If you lose or change it,
the saved Vapi and Twilio keys become unreadable and must be re-entered. Keep a
copy in your password manager.

## 5. Get your domain

Settings → Networking → **Generate Domain**. Copy it into `PUBLIC_URL` and
redeploy. Or add a custom domain and use that instead — Railway issues the
certificate either way.

## 6. Keep it to one replica

`railway.json` pins `numReplicas: 1`. Leave it there. Two instances means two
dialler loops racing the same lead list, which double-dials people and breaks
your abandonment rate. Scaling out needs Postgres and a shared queue first.

## 7. Verify

Open the domain, sign in, then Settings → paste and test both providers. Both
badges must read *connected*.

Then run a campaign of one row containing your own mobile number. When the call
ends, open Call history. If the transcript and recording are there, the webhook
round trip works and you are live.

If they are missing, it is almost always `PUBLIC_URL`. Check Railway's Deploy
Logs and confirm it matches your domain exactly, with `https://` and no trailing
slash.

## Cost and limits

Expect a few dollars a month on Railway's usage-based pricing for a service this
size, plus the volume. Vapi and Twilio are billed per minute separately and will
dwarf the hosting cost once you are dialling properly.

## When to leave SQLite

SQLite on a volume is fine for one client and a few thousand calls a month. Move
to Railway's managed Postgres when you take on a second client, need more than
one replica, or want point-in-time restore. Only `src/db.js` talks to the
database; the schema is plain SQL.

## Before real debtor data

- Encrypt transcripts and recordings at rest, or store recordings in your own
  bucket with a retention rule.
- Turn on Railway's daily volume backups.
- Complete your DPIA. Hosting region, retention period and processor list all
  need to be written down before the first live campaign.
