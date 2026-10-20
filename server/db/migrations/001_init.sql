-- Sending mailboxes (Google Workspace accounts)
CREATE TABLE mailboxes (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  from_name       TEXT NOT NULL DEFAULT '',
  signature       TEXT NOT NULL DEFAULT '',
  daily_limit     INT  NOT NULL DEFAULT 30,
  -- gradual ramp-up: today's cap = min(daily_limit, ramp_start + ramp_increment * days since ramp_started_at)
  ramp_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  ramp_start      INT  NOT NULL DEFAULT 5,
  ramp_increment  INT  NOT NULL DEFAULT 2,
  ramp_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  min_gap_seconds INT  NOT NULL DEFAULT 240,
  max_gap_seconds INT  NOT NULL DEFAULT 600,
  status          TEXT NOT NULL DEFAULT 'active',      -- active | paused | error
  paused_reason   TEXT,
  next_send_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- earliest moment this mailbox may send again
  last_synced_at  TIMESTAMPTZ,
  dns_status      JSONB,
  dns_checked_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft',   -- draft | running | paused | completed
  paused_reason       TEXT,
  timezone            TEXT NOT NULL DEFAULT 'America/New_York', -- used when a lead has no timezone
  use_lead_timezone   BOOLEAN NOT NULL DEFAULT TRUE,
  send_days           INT[] NOT NULL DEFAULT '{1,2,3,4,5}',  -- 0=Sun .. 6=Sat
  window_start        TEXT NOT NULL DEFAULT '09:00',
  window_end          TEXT NOT NULL DEFAULT '17:00',
  daily_new_leads     INT  NOT NULL DEFAULT 50,              -- max first-step sends per day
  stop_on_reply       BOOLEAN NOT NULL DEFAULT TRUE,
  stop_on_company_reply BOOLEAN NOT NULL DEFAULT TRUE,       -- stop everyone at the same domain
  stop_on_auto_reply  BOOLEAN NOT NULL DEFAULT FALSE,
  track_opens         BOOLEAN NOT NULL DEFAULT FALSE,
  track_clicks        BOOLEAN NOT NULL DEFAULT FALSE,
  unsubscribe_link    BOOLEAN NOT NULL DEFAULT TRUE,
  send_plain_text     BOOLEAN NOT NULL DEFAULT TRUE,
  allow_catch_all     BOOLEAN NOT NULL DEFAULT FALSE,
  allow_unverified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaign_mailboxes (
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id  INT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, mailbox_id)
);

CREATE TABLE steps (
  id          SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position    INT NOT NULL,              -- 0-based order
  delay_days  INT NOT NULL DEFAULT 0,    -- days after the previous step
  new_thread  BOOLEAN NOT NULL DEFAULT FALSE, -- follow-ups reply in the same thread unless set
  UNIQUE (campaign_id, position)
);

CREATE TABLE step_variants (
  id       SERIAL PRIMARY KEY,
  step_id  INT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  label    TEXT NOT NULL DEFAULT 'A',
  subject  TEXT NOT NULL DEFAULT '',
  body     TEXT NOT NULL DEFAULT '',
  weight   INT  NOT NULL DEFAULT 1,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE leads (
  id                  SERIAL PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,      -- always lower-case
  domain              TEXT NOT NULL,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  company             TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  website             TEXT NOT NULL DEFAULT '',
  linkedin            TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL DEFAULT '',
  timezone            TEXT,
  custom              JSONB NOT NULL DEFAULT '{}',
  verification_status TEXT NOT NULL DEFAULT 'unverified', -- unverified | valid | catch_all | risky | invalid
  verification_detail TEXT,
  verified_at         TIMESTAMPTZ,
  interest            TEXT,                         -- interested | not_interested | meeting_booked
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_domain_idx ON leads(domain);

CREATE TABLE campaign_leads (
  id            SERIAL PRIMARY KEY,
  campaign_id   INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id       INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- queued: waiting for first email; active: in sequence; sending: claimed by the sender right now
  -- replied | bounced | unsubscribed | completed | stopped | skipped | error
  status        TEXT NOT NULL DEFAULT 'queued',
  status_detail TEXT,
  next_step     INT  NOT NULL DEFAULT 0,
  next_send_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  mailbox_id    INT REFERENCES mailboxes(id),     -- sticky sender once the first email goes out
  thread_id     TEXT,                             -- Gmail thread id
  last_rfc_id   TEXT,                             -- Message-ID of the last email we sent (for threading)
  first_subject TEXT,
  variant_map   JSONB NOT NULL DEFAULT '{}',      -- step position -> variant id
  claimed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX campaign_leads_due_idx ON campaign_leads(status, next_send_at);

-- Every email in or out. Outbound rows are written BEFORE sending ("pending") so a crash can never cause a double send.
CREATE TABLE messages (
  id               SERIAL PRIMARY KEY,
  campaign_lead_id INT REFERENCES campaign_leads(id) ON DELETE SET NULL,
  lead_id          INT REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id      INT REFERENCES campaigns(id) ON DELETE SET NULL,
  mailbox_id       INT REFERENCES mailboxes(id) ON DELETE SET NULL,
  step_position    INT,
  variant_id       INT REFERENCES step_variants(id) ON DELETE SET NULL,
  direction        TEXT NOT NULL,                  -- out | in
  kind             TEXT NOT NULL DEFAULT 'sequence', -- sequence | manual | reply | auto_reply | bounce
  status           TEXT NOT NULL DEFAULT 'sent',   -- pending | sent | failed | unknown
  error            TEXT,
  from_email       TEXT,
  to_email         TEXT,
  subject          TEXT,
  body             TEXT,
  rfc_message_id   TEXT,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  opened_at        TIMESTAMPTZ,
  clicked_at       TIMESTAMPTZ,
  read             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one sequence email per lead per step, enforced by the database
CREATE UNIQUE INDEX messages_one_per_step ON messages(campaign_lead_id, step_position) WHERE direction = 'out' AND kind = 'sequence';
CREATE UNIQUE INDEX messages_gmail_id ON messages(mailbox_id, gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX messages_mailbox_time ON messages(mailbox_id, direction, created_at);
CREATE INDEX messages_thread ON messages(gmail_thread_id);

-- Global do-not-contact list (emails or whole domains). Never deleted automatically.
CREATE TABLE suppressions (
  id         SERIAL PRIMARY KEY,
  value      TEXT NOT NULL UNIQUE,   -- email address or domain, lower-case
  kind       TEXT NOT NULL,          -- email | domain
  reason     TEXT NOT NULL,          -- unsubscribed | bounced | complaint | manual | replied_remove
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id          SERIAL PRIMARY KEY,
  level       TEXT NOT NULL DEFAULT 'info',  -- info | warn | error
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  mailbox_id  INT,
  campaign_id INT,
  lead_id     INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_time ON events(created_at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
