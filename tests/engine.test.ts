import { describe, it, expect } from 'vitest';
import { setup, seedCampaign } from './helpers.js';
import { sendTick } from '../server/engine/sender.js';
import { syncMailbox } from '../server/engine/sync.js';
import { healthTick } from '../server/engine/health.js';
import { GmailError } from '../server/lib/gmail.js';

const MIN = 60_000;
const DAY = 86_400_000;

function decode(raw: string) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  return { head, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

describe('sending engine', () => {
  it('sends the first step once, personalized, with unsubscribe headers', async () => {
    const { ctx, db, mail, advance } = await setup();
    await seedCampaign(db);
    expect(await sendTick(ctx)).toBe(1);
    advance(5 * MIN);
    expect(await sendTick(ctx)).toBe(0); // follow-up not due for 3 days
    expect(mail.sent).toHaveLength(1);
    const { head, body } = decode(mail.sent[0].raw);
    expect(head).toContain('Subject: Quick question, Person0');
    expect(head).toContain('List-Unsubscribe:');
    expect(head).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(body).toMatch(/^Hi Person0,\n\n(Saw|Noticed) Acme\./);
    const cl = (await db.query(`SELECT * FROM campaign_leads`))[0];
    expect(cl.status).toBe('active');
    expect(cl.next_step).toBe(1);
  });

  it('sends the follow-up in the same thread after the delay', async () => {
    const { ctx, db, mail, advance } = await setup();
    await seedCampaign(db);
    await sendTick(ctx);
    advance(3 * DAY + 2 * 3600_000);
    await db.query(`UPDATE mailboxes SET last_synced_at = $1`, [ctx.now()]);
    expect(await sendTick(ctx)).toBe(1);
    const second = mail.sent[1];
    expect(second.threadId).toBe(mail.sent.length && 'thread1');
    const { head } = decode(second.raw);
    expect(head).toContain('Subject: Re: Quick question, Person0');
    expect(head).toMatch(/In-Reply-To: <.+@conversionlabshq\.agency>/);
    expect((await db.query(`SELECT status FROM campaign_leads`))[0].status).toBe('completed');
  });

  it('stops the sequence when the lead replies, and stops colleagues', async () => {
    const { ctx, db, mail, advance } = await setup();
    const { mb, c } = await seedCampaign(db);
    // a colleague at the same company in the same campaign
    const l2 = (await db.query(`INSERT INTO leads(email, domain, first_name, verification_status) VALUES ('boss@acme0.com','acme0.com','Boss','valid') RETURNING id`))[0];
    await db.query(`INSERT INTO campaign_leads(campaign_id, lead_id, next_send_at) VALUES ($1,$2,'2030-01-01')`, [c.id, l2.id]);
    await sendTick(ctx);
    mail.inbox.set(mb.email, [
      { id: 'in1', threadId: 'thread1', internalDate: Date.now(), labelIds: ['INBOX'], snippet: 'Sounds good',
        headers: { from: 'Person0 <person0@acme0.com>', subject: 'Re: Quick question, Person0' }, text: 'Sounds good, call me.' },
    ]);
    await syncMailbox(ctx, (await db.query(`SELECT * FROM mailboxes`))[0]);
    const rows = await db.query(`SELECT l.email, cl.status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY l.email`);
    expect(rows).toEqual([{ email: 'boss@acme0.com', status: 'stopped' }, { email: 'person0@acme0.com', status: 'replied' }]);
    advance(4 * DAY);
    expect(await sendTick(ctx)).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it('suppresses hard bounces and never emails them again', async () => {
    const { ctx, db, mail } = await setup();
    const { mb } = await seedCampaign(db);
    await sendTick(ctx);
    mail.inbox.set(mb.email, [
      { id: 'b1', threadId: 'thread1', internalDate: Date.now(), labelIds: ['INBOX'], snippet: '',
        headers: { from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)' },
        text: "Address not found. Your message wasn't delivered to person0@acme0.com. 550 5.1.1 The email account does not exist." },
    ]);
    await syncMailbox(ctx, (await db.query(`SELECT * FROM mailboxes`))[0]);
    expect((await db.query(`SELECT status FROM campaign_leads`))[0].status).toBe('bounced');
    expect((await db.query(`SELECT value, reason FROM suppressions`))[0]).toEqual({ value: 'person0@acme0.com', reason: 'bounced' });
  });

  it('respects the mailbox daily cap and ramp-up', async () => {
    const { ctx, db, mail, advance } = await setup();
    await seedCampaign(db, { leads: 10 });
    await db.query(`UPDATE mailboxes SET ramp_enabled = true, ramp_start = 3, ramp_increment = 2, ramp_started_at = $1`, [ctx.now()]);
    for (let i = 0; i < 20; i++) {
      await sendTick(ctx);
      advance(2 * MIN);
    }
    expect(mail.sent).toHaveLength(3); // day 0 cap = 3
    advance(DAY);
    for (let i = 0; i < 20; i++) {
      await sendTick(ctx);
      advance(2 * MIN);
    }
    expect(mail.sent).toHaveLength(8); // day 1 cap = 5 more
  });

  it('refuses to send when a variable has no value and no fallback', async () => {
    const { ctx, db, mail } = await setup();
    await seedCampaign(db, { steps: [{ delay: 0, subject: 'Hi {{firstName}}', body: 'About {{custom_thing}}' }] });
    expect(await sendTick(ctx)).toBe(0);
    expect(mail.sent).toHaveLength(0);
    const cl = (await db.query(`SELECT status, status_detail FROM campaign_leads`))[0];
    expect(cl.status).toBe('error');
    expect(cl.status_detail).toContain('custom_thing');
  });

  it('skips suppressed, role, invalid and unverified addresses', async () => {
    const { ctx, db, mail } = await setup();
    const { c } = await seedCampaign(db, { leads: 0 });
    const add = async (email: string, v: string) => {
      const l = (await db.query(`INSERT INTO leads(email, domain, first_name, verification_status) VALUES ($1,$2,'X',$3) RETURNING id`, [email, email.split('@')[1], v]))[0];
      await db.query(`INSERT INTO campaign_leads(campaign_id, lead_id, next_send_at) VALUES ($1,$2,'2020-01-01')`, [c.id, l.id]);
    };
    await add('info@shop.com', 'valid');
    await add('bad@nowhere.com', 'invalid');
    await add('dnc@ok.com', 'valid');
    await add('new@ok2.com', 'unverified');
    await db.query(`INSERT INTO suppressions(value, kind, reason) VALUES ('dnc@ok.com','email','unsubscribed')`);
    for (let i = 0; i < 5; i++) await sendTick(ctx);
    expect(mail.sent).toHaveLength(0);
    const rows = await db.query(`SELECT l.email, cl.status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY l.email`);
    expect(rows).toEqual([
      { email: 'bad@nowhere.com', status: 'skipped' },
      { email: 'dnc@ok.com', status: 'unsubscribed' },
      { email: 'info@shop.com', status: 'skipped' },
      { email: 'new@ok2.com', status: 'queued' },
    ]);
  });

  it('never resends after a timeout: checks Gmail first', async () => {
    const { ctx, db, mail, advance } = await setup();
    await seedCampaign(db);
    // Simulate: Gmail accepted the email but the response was lost
    const realSend = mail.send.bind(mail);
    mail.send = async (...args) => {
      await realSend(...args);
      throw new Error('socket hang up');
    };
    expect(await sendTick(ctx)).toBe(0);
    mail.send = realSend;
    expect(mail.sent).toHaveLength(1);
    expect((await db.query(`SELECT status FROM campaign_leads`))[0].status).toBe('sending');
    for (let i = 0; i < 5; i++) {
      advance(3 * MIN);
      await sendTick(ctx);
    }
    expect(mail.sent).toHaveLength(1); // not resent
    const cl = (await db.query(`SELECT status, next_step FROM campaign_leads`))[0];
    expect(cl).toEqual({ status: 'active', next_step: 1 });
    expect((await db.query(`SELECT status FROM messages`))[0].status).toBe('sent');
  });

  it('retries later on a Gmail rate limit and pauses the mailbox on an access problem', async () => {
    const { ctx, db, mail, advance } = await setup();
    await seedCampaign(db, { leads: 2 });
    mail.failNext = new GmailError('Rate limit', 429, 'rateLimitExceeded');
    expect(await sendTick(ctx)).toBe(0);
    expect(await db.query(`SELECT count(*)::int AS n FROM messages`)).toEqual([{ n: 0 }]);
    advance(31 * MIN);
    mail.failNext = new GmailError('unauthorized_client', 401);
    await sendTick(ctx);
    const mb = (await db.query(`SELECT status FROM mailboxes`))[0];
    expect(mb.status).toBe('error');
    advance(31 * MIN);
    await sendTick(ctx);
    expect(mail.sent).toHaveLength(0);
    expect((await db.query(`SELECT status FROM campaign_leads ORDER BY id`)).map((r: any) => r.status)).toEqual(['queued', 'queued']);
  });

  it('treats an unsubscribe reply as a do-not-contact request', async () => {
    const { ctx, db, mail } = await setup();
    const { mb } = await seedCampaign(db);
    await sendTick(ctx);
    mail.inbox.set(mb.email, [
      { id: 'u1', threadId: 'thread1', internalDate: Date.now(), labelIds: ['INBOX'], snippet: '',
        headers: { from: 'person0@acme0.com', subject: 'Re: Quick question' }, text: 'Please remove me from your list.\n\nOn Mon, Tyler wrote:\n> Hi' },
    ]);
    await syncMailbox(ctx, (await db.query(`SELECT * FROM mailboxes`))[0]);
    expect((await db.query(`SELECT reason FROM suppressions`))[0].reason).toBe('unsubscribed');
  });

  it('auto-pauses a mailbox when bounces pass the limit', async () => {
    const { ctx, db } = await setup();
    const { mb, c } = await seedCampaign(db, { leads: 0 });
    for (let i = 0; i < 40; i++) {
      await db.query(`INSERT INTO messages(mailbox_id, campaign_id, direction, kind, status, created_at) VALUES ($1,$2,'out','manual','sent',$3)`, [mb.id, c.id, ctx.now()]);
    }
    for (let i = 0; i < 2; i++) {
      await db.query(`INSERT INTO messages(mailbox_id, campaign_id, direction, kind, status, created_at) VALUES ($1,$2,'in','bounce','sent',$3)`, [mb.id, c.id, ctx.now()]);
    }
    await healthTick(ctx);
    const after = (await db.query(`SELECT status, paused_reason FROM mailboxes`))[0];
    expect(after.status).toBe('paused');
    expect(after.paused_reason).toContain('5.0%');
  });

  it('only sends inside the send window in the lead time zone', async () => {
    const { ctx, db, mail, setNow } = await setup('2026-10-21T03:00:00Z'); // 11pm New York
    await seedCampaign(db);
    await db.query(`UPDATE campaigns SET window_start = '09:00', window_end = '17:00', send_days = '{1,2,3,4,5}'`);
    expect(await sendTick(ctx)).toBe(0);
    const cl = (await db.query(`SELECT next_send_at FROM campaign_leads`))[0];
    expect(new Date(cl.next_send_at).toISOString()).toBe('2026-10-21T13:00:00.000Z'); // 9am New York
    setNow('2026-10-21T13:05:00Z');
    expect(await sendTick(ctx)).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });
});
