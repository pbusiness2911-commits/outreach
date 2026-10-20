import { Router } from 'express';
import type { Ctx } from '../engine/context.js';
import { suppress, logEvent } from '../engine/context.js';
import { readToken } from '../lib/tokens.js';
import { escapeHtml } from '../lib/render.js';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;color:#1e293b}button{background:#0f172a;color:#fff;border:0;padding:12px 20px;border-radius:8px;font-size:16px;cursor:pointer}</style></head>
<body>${body}</body></html>`;
}

export function publicRouter(ctx: Ctx) {
  const r = Router();

  async function leadFor(token: string) {
    const id = readToken(token, 'u');
    if (!id) return null;
    return (await ctx.db.query(`SELECT cl.id, cl.campaign_id, l.id AS lead_id, l.email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.id = $1`, [id]))[0] ?? null;
  }

  // Page from the link in the email: a button, so link scanners can't unsubscribe people by accident
  r.get('/u/:token', async (req, res) => {
    const lead = await leadFor(req.params.token);
    if (!lead) return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
    res.send(page('Unsubscribe', `<h2>Unsubscribe</h2><p>Stop all emails to <b>${escapeHtml(lead.email)}</b>?</p><form method="post"><button type="submit">Unsubscribe</button></form>`));
  });

  // One-click unsubscribe (RFC 8058, used by Gmail's "Unsubscribe" button) and the form above
  r.post('/u/:token', async (req, res) => {
    const lead = await leadFor(req.params.token);
    if (!lead) return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
    await suppress(ctx.db, lead.email, 'email', 'unsubscribed');
    await logEvent(ctx.db, 'info', 'unsubscribe', `${lead.email} unsubscribed`, { campaign_id: lead.campaign_id, lead_id: lead.lead_id });
    res.send(page('Unsubscribed', `<h2>You're unsubscribed</h2><p>${escapeHtml(lead.email)} won't receive any more emails from us.</p>`));
  });

  r.get('/t/o/:token.gif', async (req, res) => {
    const id = readToken(req.params.token, 'o');
    if (id) {
      await ctx.db
        .query(
          `UPDATE messages SET opened_at = now() WHERE id = (SELECT id FROM messages WHERE campaign_lead_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1) AND opened_at IS NULL`,
          [id],
        )
        .catch(() => {});
    }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }).send(PIXEL);
  });

  r.get('/t/c/:token', async (req, res) => {
    const id = readToken(req.params.token, 'c');
    const url = String(req.query.u || '');
    if (!id || !/^https?:\/\//i.test(url)) return res.status(400).send('Bad link');
    // only redirect to links that were actually in an email we sent to this lead (no open redirect)
    const msg = (await ctx.db.query(`SELECT id, body FROM messages WHERE campaign_lead_id = $1 AND direction = 'out' ORDER BY id DESC`, [id])).find(
      (m: any) => (m.body || '').includes(url),
    );
    if (!msg) return res.status(400).send('Bad link');
    await ctx.db.query(`UPDATE messages SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [msg.id]).catch(() => {});
    res.redirect(302, url);
  });

  return r;
}
