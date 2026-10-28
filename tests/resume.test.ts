import { describe, it, expect } from 'vitest';
import { setup, seedCampaign } from './helpers.js';
import { sendTick } from '../server/engine/sender.js';
import { resumeFromGmail } from '../server/engine/resume.js';

const DAY = 86_400_000;

function decode(raw: string) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  return { head, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

const sent = (id: string, thread: string, to: string, subject: string, daysAgo: number, now: Date) => ({
  id, threadId: thread, internalDate: now.getTime() - daysAgo * DAY, labelIds: ['SENT'], snippet: '',
  headers: { from: 'Tyler <tyler@conversionlabshq.agency>', to, subject, 'message-id': `<${id}@lemlist>` }, text: 'earlier email',
});

describe('continuing a campaign from Gmail history', () => {
  it('never resends step 1, continues in the same thread, and stops repliers', async () => {
    const { ctx, db, mail } = await setup();
    const { mb, c } = await seedCampaign(db, {
      leads: 4,
      steps: [
        { delay: 0, subject: 'Quick question, {{firstName}}', body: 'Hi {{firstName}}, first.' },
        { delay: 3, subject: '', body: 'Second, {{firstName}}.' },
        { delay: 4, subject: '', body: 'Third, {{firstName}}.' },
      ],
    });
    await db.query(`UPDATE campaigns SET status = 'paused'`);
    const now = ctx.now();
    mail.sentBox.set(mb.email, [
      sent('a1', 'tA', 'Person0 <person0@acme0.com>', 'Quick question, Person0', 5, now), // step 1 only, 5 days ago -> step 2 due
      sent('b1', 'tB', 'person1@acme1.com', 'Quick question, Person1', 8, now), // steps 1+2 -> step 3 in 2 days
      sent('b2', 'tB', 'person1@acme1.com', 'Re: Quick question, Person1', 2, now),
      sent('c1', 'tC', 'person2@acme2.com', 'Quick question, Person2', 4, now), // replied -> stopped
      sent('w1', 'tW', 'warmup-pool@example.org', 'warm-up chatter', 1, now), // not a lead: ignored
    ]);
    mail.inbox.set(mb.email, [
      { id: 'r1', threadId: 'tC', internalDate: now.getTime() - DAY, labelIds: ['INBOX'], snippet: 'Interested',
        headers: { from: 'person2@acme2.com', subject: 'Re: Quick question, Person2' }, text: 'Yes, interested. Call me.' },
    ]);
    const since = new Date(now.getTime() - 30 * DAY);

    const preview = await resumeFromGmail(ctx, c.id, { since, apply: false });
    expect(preview.not_contacted).toBe(1);
    expect(preview.continuing).toEqual({ 'next step 2': 2, 'next step 3': 1 });
    expect(await db.query(`SELECT 1 FROM messages`)).toHaveLength(0); // dry run changes nothing

    const r = await resumeFromGmail(ctx, c.id, { since, apply: true });
    expect(r.replied).toBe(1);
    const rows = await db.query(`SELECT l.email, cl.status, cl.next_step, cl.thread_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY l.email`);
    expect(rows.map((x: any) => [x.email, x.status, x.next_step])).toEqual([
      ['person0@acme0.com', 'active', 1],
      ['person1@acme1.com', 'active', 2],
      ['person2@acme2.com', 'replied', 1],
      ['person3@acme3.com', 'queued', 0],
    ]);

    // Running it again changes nothing
    const again = await resumeFromGmail(ctx, c.id, { since, apply: true });
    expect(again.already_resumed).toBe(3);

    await db.query(`UPDATE campaigns SET status = 'running'`);
    await db.query(`UPDATE mailboxes SET last_synced_at = $1`, [ctx.now()]);
    for (let i = 0; i < 6; i++) await sendTick(ctx);
    const out = mail.sent.map((s) => ({ thread: s.threadId, ...decode(s.raw) }));
    const to = (e: string) => out.filter((o) => o.head.includes(`To: ${e}`) || o.head.includes(`<${e}>`));
    // person0: step 2 now, in the lemlist thread, replying to its Message-ID
    expect(to('person0@acme0.com')).toHaveLength(1);
    expect(to('person0@acme0.com')[0].thread).toBe('tA');
    expect(to('person0@acme0.com')[0].head).toContain('In-Reply-To: <a1@lemlist>');
    expect(to('person0@acme0.com')[0].body).toContain('Second, Person0.');
    // person1: step 3 not due yet; person2 replied; person3 gets step 1
    expect(to('person1@acme1.com')).toHaveLength(0);
    expect(to('person2@acme2.com')).toHaveLength(0);
    expect(to('person3@acme3.com')).toHaveLength(1);
    expect(to('person3@acme3.com')[0].body).toContain('first.');
  });
});
