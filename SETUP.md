# Conversion Labs Outreach: setup guide

This takes about 30–40 minutes the first time. You do steps 1–3 once; after that, adding a mailbox is one click.

---

## 1. Create the Google service account (lets the app send from your mailboxes without passwords)

1. Go to **https://console.cloud.google.com** and sign in with your Google Workspace **admin** account.
2. Top bar → project picker → **New project** → name it `outreach` → **Create**. Make sure it's selected.
3. Search for **Gmail API** → open it → **Enable**.
4. Menu → **IAM & Admin → Service accounts → + Create service account**.
   - Name: `outreach-sender` → **Create and continue** → skip the optional steps → **Done**.
5. Click the new service account → **Keys** tab → **Add key → Create new key → JSON → Create**.
   A `.json` file downloads. **Keep it private**: it's the key to your mailboxes. Never email it or commit it to GitHub.
   - If you see *"Service account key creation is disabled"*: go to **IAM & Admin → Organization policies**, search
     `iam.disableServiceAccountKeyCreation`, click it → **Manage policy → Override parent's policy → Rules: Off → Save**, then try again.
6. On the service account's **Details** tab, copy the **Unique ID** (a long number). You need it in step 2.

## 2. Allow the app in Google Workspace admin (once per Workspace)

Do this in **every** Google Workspace that owns one of your sending domains (getconversionlabs.agency, tryconversionlabs.agency, conversionlabshq.agency). If all three domains are in one Workspace, you do it once.

1. Go to **https://admin.google.com** → **Security → Access and data control → API controls**.
2. **Manage domain-wide delegation → Add new**.
3. **Client ID**: the Unique ID from step 1.6.
4. **OAuth scopes** (paste exactly, comma-separated):
   ```
   https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly
   ```
5. **Authorize**. It can take up to 10 minutes to start working.

The app can only **send** and **read** mail. It can't delete mail, change settings or see passwords.

## 3. Deploy to Railway

1. Sign up at **https://railway.com** and choose the **Hobby** plan ($5/month minimum, which includes $5 of usage).
   In **Account → Usage**, set a **hard limit** of $10 so the bill can never surprise you.
2. Put this folder on GitHub (private repo), or install the Railway CLI and run `railway up` from this folder.
3. In Railway: **New project → Deploy from GitHub repo** → pick the repo.
4. In the same project: **+ New → Database → PostgreSQL**.
5. Click your app service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills it in) |
   | `ADMIN_PASSWORD` | a strong password for the dashboard |
   | `APP_SECRET` | a long random string (40+ characters) |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | the **entire contents** of the JSON key file from step 1.5 |
   | `PUBLIC_URL` | your app's URL, e.g. `https://outreach-production.up.railway.app` (see **Settings → Networking → Generate domain**) |
   | `MILLIONVERIFIER_API_KEY` | from step 4 (optional, recommended) |

6. **Settings → Networking → Generate domain** to get the public URL (put it in `PUBLIC_URL` above).
7. Railway redeploys automatically. Open the URL and log in with `ADMIN_PASSWORD`.
8. Postgres → **Backups** → turn on daily backups.

Keep the app at **1 replica**. The app also locks itself so only one copy ever sends.

## 4. Email verification (recommended)

1. Sign up at **https://www.millionverifier.com**, buy credits (about $37 per 10,000 checks), and copy your **API key**.
2. Add it as `MILLIONVERIFIER_API_KEY` in Railway.

Without it, the app still blocks bad syntax, dead domains, disposable addresses and role addresses (info@, support@…), but it can't tell whether a real person's mailbox exists. That's what keeps bounces under 2%.

## 5. First run checklist

1. **Mailboxes → + Add mailbox**: add **only healthy mailboxes** first (tyler@ and justin@ on conversionlabshq.agency). The app tests the connection before saving.
   - Daily limit **25–30**, ramp-up on. Keep **lemwarm running** on every mailbox.
   - Don't add the getconversionlabs / tryconversionlabs mailboxes until lemwarm shows their spam rate under 3%.
2. **Mailboxes → Check DNS**: every domain should show SPF ✓ DKIM ✓ DMARC ✓ MX ✓. A domain that fails is paused automatically.
3. **Do not contact**: add current clients, competitors and anyone who asked not to be contacted.
4. **Campaigns → New campaign**:
   - **Sequence**: write step 1 plus 2–3 follow-ups. Use `{{firstName|there}}` (with a fallback) and spintax `{Hi|Hey}`.
   - **Leads**: import a CSV. Verification runs automatically before anyone is emailed.
   - **Settings**: pick the mailboxes, schedule (e.g. Mon–Fri 9:00–17:00, lead's time zone).
   - **Review & launch**: fix every red item, read the yellow ones, **send yourself a test email**, then launch.
5. Watch the **Dashboard** for the first few days. Reply to people from the **Unibox**.

## What the app does to protect deliverability

- Sends through Google's own Gmail API from your real mailboxes, as plain text with no tracking by default
- Per-mailbox daily caps, gradual ramp-up, and random gaps (4–10 minutes by default) between emails
- Sends only inside your schedule, in each lead's time zone
- **Never double-sends**: every email is recorded before it goes out and the database refuses a second one for the same step. If Google doesn't answer, the app checks Gmail for the email before doing anything else.
- Stops a sequence the moment someone replies, also in every other campaign, and for colleagues at the same company
- Detects bounces and auto-replies; hard bounces go on the do-not-contact list forever
- One-click unsubscribe header (required by Gmail) plus an optional unsubscribe line; "remove me" replies are honored automatically
- Blocks role addresses, invalid, disposable and (by default) catch-all addresses
- Refuses to send an email with a missing `{{variable}}` instead of sending "Hi {{firstName}}"
- **Auto-pauses** a mailbox or campaign when bounces pass 3% (configurable), when Gmail access breaks, or when SPF/DKIM/DMARC are wrong
- Pre-launch checks flag links in the first email, spam-trigger words, missing variables and unhealthy mailboxes

## Running it on your computer (for testing)

```bash
npm install
npm run build
npm start
```

Then open http://localhost:3100. Without `GOOGLE_SERVICE_ACCOUNT_JSON`, or with `DRY_RUN=true` in `.env`, nothing is really sent. The data is stored in the `.data` folder.

Run the safety tests with `npm test`.
