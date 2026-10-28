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

## 3. Deploy to Render (free)

1. **Database: https://neon.tech** → sign up → create a project named `outreach` (region: closest to you).
   Copy the **connection string** (starts with `postgresql://`, ends with `sslmode=require`).
2. **https://render.com** → sign up with GitHub → **New → Blueprint** → pick the `outreach` repo → fill in:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `ADMIN_PASSWORD` | a strong password for the dashboard |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | the **entire contents** of the JSON key file from step 1.5 |
   | `PUBLIC_URL` | `https://outreach.onrender.com` for now; fix it in step 3 |
   | `MILLIONVERIFIER_API_KEY` | optional; leave empty for now |

   → **Apply**. `APP_SECRET` is generated automatically.
3. When it's live, copy the app's real URL from the top of the service page. **Environment** → set `PUBLIC_URL` to it → **Save**.
4. **Keep it awake: https://uptimerobot.com** → sign up → **New monitor** → type **HTTP(s)**, URL `<your app URL>/healthz`, interval **5 minutes** → **Create**.
   Free Render apps sleep after 15 minutes without visits; sleeping would pause sending.
5. Open the URL and log in with `ADMIN_PASSWORD`.

Upgrading later: in `render.yaml` change `plan: free` to `plan: starter`. Nothing else changes.

## 3b. Let Claude operate the app (optional)

The app has a connector at `/mcp`, so Claude (in the Claude desktop app, opened on this folder) can create campaigns, write sequences, import leads, read the inbox and send approved replies.

1. Make a key: in PowerShell run
   `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})` and copy the result.
2. **Render** → outreach → **Environment** → add `OUTREACH_API_KEY` = the key → **Save**.
3. **Your PC**: Start menu → "Edit environment variables for your account" → **New** twice:
   - `OUTREACH_API_KEY` = the same key
   - `OUTREACH_URL` = your app URL, e.g. `https://outreach-ab12.onrender.com` (no trailing slash)
4. Fully quit and reopen the Claude desktop app, open this project, and approve the **outreach** connector when asked.

Claude never sees the key. Every action Claude takes shows up in the Dashboard activity log as "Claude: …". Replies and launches only happen after you approve them in chat.

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
