// Claude connector (MCP over streamable HTTP at /mcp).
// Every tool calls this app's own /api with the API key, so all validation, safety checks and limits stay in one place.
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import { validApiKey } from './lib/tokens.js';
import { logEvent } from './engine/context.js';
import type { Db } from './db/db.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function call(method: Method, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${config.port}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${config.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`);
  return data;
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }] });
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

function buildServer(db: Db) {
  const server = new McpServer({ name: 'conversion-labs-outreach', version: '1.0.0' });

  // Wraps a handler: errors become tool errors; writes are logged so the team sees what Claude did.
  const tool = (name: string, description: string, shape: z.ZodRawShape, fn: (a: any) => Promise<unknown>, logWrite = false) =>
    server.tool(name, description, shape, async (args: any) => {
      try {
        const out = await fn(args);
        if (logWrite) await logEvent(db, 'info', 'claude', `Claude: ${name}`, {}).catch(() => {});
        return ok(out);
      } catch (err) {
        return fail(err);
      }
    });

  const id = z.number().int().describe('Numeric id');

  // ---------- overview ----------
  tool('get_app_status', 'Whether the app really sends (dryRun=false means the Google key is loaded and emails go out) and whether full email verification is on.', {}, () => call('GET', '/me'));
  tool('get_overview', 'Sending stats (today / 7 days), unread replies, running campaigns, mailbox health and the 30 latest events.', {}, () => call('GET', '/dashboard'));
  tool('list_events', 'Activity log: launches, auto-pauses, bounces, errors. Optional level filter.', { level: z.enum(['info', 'warn', 'error']).optional() }, (a) => call('GET', `/events${qs(a)}`));

  // ---------- mailboxes ----------
  tool('list_mailboxes', 'All sending mailboxes with status, daily cap today, sends in the last 24h, 7-day sent/bounces/replies and DNS status.', {}, () => call('GET', '/mailboxes'));
  const mailboxFields = {
    from_name: z.string().max(100).optional().describe('Display name, e.g. "Tyler Brooks"'),
    signature: z.string().max(5000).optional().describe('Plain-text signature appended to every email'),
    daily_limit: z.number().int().min(1).max(100).optional().describe('Max cold emails per day (recommended 25-30)'),
    ramp_enabled: z.boolean().optional(),
    ramp_start: z.number().int().min(1).max(100).optional(),
    ramp_increment: z.number().int().min(1).max(20).optional(),
    min_gap_seconds: z.number().int().min(60).max(3600).optional(),
    max_gap_seconds: z.number().int().min(60).max(7200).optional(),
  };
  tool('add_mailbox', 'Connect a Google Workspace mailbox. Tests the Gmail connection first; fails with the reason if domain-wide delegation is missing.', { email: z.string().email(), ...mailboxFields }, (a) => call('POST', '/mailboxes', a), true);
  tool('update_mailbox', 'Change a mailbox\'s name, signature, daily limit, ramp-up or gaps.', { mailbox_id: id, ...mailboxFields }, ({ mailbox_id, ...rest }) => call('PATCH', `/mailboxes/${mailbox_id}`, rest), true);
  tool('test_mailbox', 'Re-test the Gmail connection for a mailbox.', { mailbox_id: id }, (a) => call('POST', `/mailboxes/${a.mailbox_id}/test`, {}));
  tool('pause_mailbox', 'Stop a mailbox from sending.', { mailbox_id: id }, (a) => call('POST', `/mailboxes/${a.mailbox_id}/pause`, {}), true);
  tool('resume_mailbox', 'Resume a paused mailbox. Refuses if the pause reason (e.g. DNS) is unresolved.', { mailbox_id: id }, (a) => call('POST', `/mailboxes/${a.mailbox_id}/resume`, {}), true);
  tool('check_dns', 'Re-check SPF, DKIM, DMARC and MX for every sending domain now.', {}, () => call('POST', '/dns/check', {}));

  // ---------- campaigns ----------
  tool('list_campaigns', 'All campaigns with status and stats (leads, contacted, replied, bounced, interested).', {}, () => call('GET', '/campaigns'));
  tool('get_campaign', 'Full campaign: settings, sequence steps with A/B variants and per-variant stats, chosen mailbox ids, stats.', { campaign_id: id }, (a) => call('GET', `/campaigns/${a.campaign_id}`));
  tool('create_campaign', 'Create a draft campaign (one empty step). Returns its id. Nothing sends until launch_campaign.', { name: z.string().min(1).max(200) }, (a) => call('POST', '/campaigns', a), true);
  tool(
    'update_campaign_settings',
    'Change campaign settings: name, schedule (timezone, use_lead_timezone, send_days 0=Sun..6=Sat, window_start/window_end "HH:MM"), daily_new_leads, stop rules, tracking, unsubscribe line, catch-all / unverified handling.',
    {
      campaign_id: id,
      name: z.string().min(1).max(200).optional(),
      timezone: z.string().optional().describe('IANA zone, e.g. "Europe/London"'),
      use_lead_timezone: z.boolean().optional(),
      send_days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
      window_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      window_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      daily_new_leads: z.number().int().min(1).max(1000).optional(),
      stop_on_reply: z.boolean().optional(),
      stop_on_company_reply: z.boolean().optional(),
      stop_on_auto_reply: z.boolean().optional(),
      track_opens: z.boolean().optional().describe('Off by default; lowers inbox placement'),
      track_clicks: z.boolean().optional().describe('Off by default; lowers inbox placement'),
      unsubscribe_link: z.boolean().optional(),
      allow_catch_all: z.boolean().optional(),
      allow_unverified: z.boolean().optional(),
    },
    ({ campaign_id, ...rest }) => call('PUT', `/campaigns/${campaign_id}`, rest),
    true,
  );
  tool(
    'set_sequence',
    'Replace the whole email sequence. Step 1 delay is ignored (sends first). Follow-ups reply in the same thread unless new_thread=true (then they need a subject). ' +
      'Variables: {{firstName}}, {{lastName}}, {{company}}, {{title}}, {{city}}, {{website}}, any imported column like {{icebreaker}}; fallback with {{firstName|there}}. Spintax: {Hi|Hey}. ' +
      'To keep stats on existing steps/variants, pass their ids from get_campaign.',
    {
      campaign_id: id,
      steps: z
        .array(
          z.object({
            id: z.number().optional(),
            delay_days: z.number().int().min(0).max(60).describe('Days after the previous step'),
            new_thread: z.boolean().default(false),
            variants: z
              .array(
                z.object({
                  id: z.number().optional(),
                  label: z.string().max(5).default('A'),
                  subject: z.string().max(300).default(''),
                  body: z.string().max(20000),
                  weight: z.number().int().min(1).max(100).default(1),
                  active: z.boolean().default(true),
                }),
              )
              .min(1),
          }),
        )
        .min(1)
        .max(15),
    },
    ({ campaign_id, steps }) => call('PUT', `/campaigns/${campaign_id}/sequence`, steps),
    true,
  );
  tool('set_campaign_mailboxes', 'Choose which mailboxes send this campaign (leads are spread across them).', { campaign_id: id, mailbox_ids: z.array(z.number().int()) }, ({ campaign_id, mailbox_ids }) =>
    call('PUT', `/campaigns/${campaign_id}/mailboxes`, { mailbox_ids }), true);
  tool(
    'import_leads',
    'Add leads to a campaign. Each row needs "email"; known fields: first_name, last_name, company, title, phone, website, linkedin, city, timezone. Any other key (e.g. icebreaker) becomes a {{variable}}. ' +
      'Skips invalid, duplicate, role (info@…) and Do-not-contact addresses, and by default anyone already active in another campaign. Returns counts.',
    {
      campaign_id: id,
      rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
      skip_in_other_campaigns: z.boolean().default(true),
    },
    ({ campaign_id, ...rest }) => call('POST', `/campaigns/${campaign_id}/leads`, rest),
    true,
  );
  tool('list_campaign_leads', 'Leads in a campaign with their status and next send time (100 per page).', {
    campaign_id: id,
    status: z.enum(['queued', 'active', 'sending', 'replied', 'completed', 'bounced', 'unsubscribed', 'stopped', 'skipped', 'error']).optional(),
    q: z.string().optional(),
    page: z.number().int().min(0).optional(),
  }, ({ campaign_id, ...rest }) => call('GET', `/campaigns/${campaign_id}/leads${qs(rest)}`));
  tool(
    'resume_from_gmail',
    'For leads imported from another tool (e.g. lemlist) that already emailed them from these same mailboxes: reads each campaign mailbox Gmail Sent folder since `since`, ' +
      'marks the steps already sent, keeps the same sender and Gmail thread, and schedules only the next step. With apply=true it also processes replies/bounces found in Gmail. ' +
      'Run with apply=false first and show the report; campaign must be paused/draft. Leads with nothing sent stay queued for step 1.',
    { campaign_id: id, since: z.string().describe('Date the earlier campaign started, e.g. 2026-10-17'), apply: z.boolean().default(false) },
    ({ campaign_id, ...rest }) => call('POST', `/campaigns/${campaign_id}/resume-from-gmail`, rest),
    true,
  );
  tool('stop_lead', 'Stop the sequence for one lead in a campaign (cl_id from list_campaign_leads or the inbox).', { cl_id: id }, (a) => call('POST', `/campaign-leads/${a.cl_id}/stop`, {}), true);
  tool('preview_campaign', 'Render every step exactly as a lead will receive it (first lead, or a given lead_id). Shows missing-variable errors.', { campaign_id: id, lead_id: z.number().int().optional() }, ({ campaign_id, ...rest }) =>
    call('POST', `/campaigns/${campaign_id}/preview`, rest));
  tool('launch_checks', 'Pre-launch checks. "errors" block launch; "warnings" should be shown to the user.', { campaign_id: id }, (a) => call('GET', `/campaigns/${a.campaign_id}/checks`));
  tool('send_test_email', 'Send one step of the campaign (variant A) to an address, subject prefixed [TEST]. Use the user\'s own address only.', {
    campaign_id: id,
    to: z.string().email(),
    step: z.number().int().min(0).default(0).describe('0 = first email'),
    mailbox_id: z.number().int().optional(),
  }, ({ campaign_id, ...rest }) => call('POST', `/campaigns/${campaign_id}/test-email`, rest), true);
  tool('launch_campaign', 'Start sending. ONLY call after the user explicitly approved launching this campaign in chat. Refuses if launch checks have errors.', { campaign_id: id }, (a) =>
    call('POST', `/campaigns/${a.campaign_id}/launch`, {}), true);
  tool('pause_campaign', 'Pause a running campaign.', { campaign_id: id }, (a) => call('POST', `/campaigns/${a.campaign_id}/pause`, {}), true);
  tool('duplicate_campaign', 'Copy a campaign (sequence + settings, no leads) as a new draft.', { campaign_id: id }, (a) => call('POST', `/campaigns/${a.campaign_id}/duplicate`, {}), true);

  // ---------- inbox ----------
  tool('list_inbox', 'Unified inbox: latest reply per conversation, newest first. Filter: all, unread, replies (no auto-replies), interested.', {
    filter: z.enum(['all', 'unread', 'replies', 'interested']).default('all'),
    limit: z.number().int().min(1).max(200).default(50),
  }, async (a) => ((await call('GET', `/inbox${qs({ filter: a.filter })}`)) as any[]).slice(0, a.limit));
  tool('get_conversation', 'Full thread with a lead (cl_id from list_inbox). Marks it read. "fresh" holds the reply without quoted history.', { cl_id: id }, (a) => call('GET', `/inbox/${a.cl_id}`));
  tool('reply_to_lead', 'Send a reply in the existing Gmail thread from the mailbox that emailed the lead (signature added automatically). ' +
    'ONLY call after the user approved this exact text in chat.', { cl_id: id, body: z.string().min(1).max(20000) }, (a) => call('POST', `/inbox/${a.cl_id}/reply`, { body: a.body }), true);
  tool('set_lead_interest', 'Label a lead: interested, not_interested, meeting_booked, or null to clear.', {
    lead_id: id,
    interest: z.enum(['interested', 'not_interested', 'meeting_booked']).nullable(),
  }, (a) => call('PATCH', `/leads/${a.lead_id}`, { interest: a.interest }), true);

  // ---------- leads & do-not-contact ----------
  tool('search_leads', 'Search all leads across campaigns (100 per page) with verification status and campaigns.', {
    q: z.string().optional(),
    verification: z.enum(['valid', 'catch_all', 'risky', 'invalid', 'unverified']).optional(),
    page: z.number().int().min(0).optional(),
  }, (a) => call('GET', `/leads${qs(a)}`));
  tool('list_do_not_contact', 'Do-not-contact list (emails and whole domains), newest first.', { q: z.string().optional() }, (a) => call('GET', `/suppressions${qs(a)}`));
  tool('add_do_not_contact', 'Block emails or whole domains from ever being emailed.', { values: z.array(z.string()).min(1).max(5000) }, (a) => call('POST', '/suppressions', { values: a.values.join('\n') }), true);
  tool('get_settings', 'Global safety settings (role-address blocking, DNS requirement, bounce auto-pause threshold).', {}, () => call('GET', '/settings'));
  tool('update_settings', 'Change global safety settings. Only call after the user approved the change in chat.', {
    block_role_addresses: z.boolean().optional().describe('Never email info@, support@, sales@…'),
    require_dns: z.boolean().optional().describe('Pause mailboxes with broken SPF/DKIM/DMARC'),
    bounce_pause_percent: z.number().min(1).max(10).optional().describe('Auto-pause above this 7-day bounce rate'),
    bounce_min_sends: z.number().int().min(10).optional().describe('…once at least this many emails were sent'),
  }, (a) => call('PUT', '/settings', a), true);

  // ---------- deletions (permanent: only after the user confirmed in chat) ----------
  tool('delete_campaign', 'Permanently delete a campaign and its stats (leads stay in the lead list). Running campaigns must be paused first. Only call after the user confirmed in chat.', { campaign_id: id }, (a) =>
    call('DELETE', `/campaigns/${a.campaign_id}`), true);
  tool('remove_lead_from_campaign', 'Remove a lead from a campaign (cl_id from list_campaign_leads). Sent messages are kept; the lead stays in the lead list. Refused while an email is mid-send. Only call after the user confirmed in chat.', { cl_id: id }, (a) =>
    call('DELETE', `/campaign-leads/${a.cl_id}`), true);

  return server;
}

export function mountMcp(app: Express, db: Db) {
  const handler = async (req: Request, res: Response) => {
    if (!validApiKey(req.headers.authorization)) return res.status(401).json({ error: 'Invalid or missing API key' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    // Stateless: a fresh server + transport per request.
    const server = buildServer(db);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.all('/mcp', handler);
}
