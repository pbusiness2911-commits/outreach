import { createDb, migrate, type Db } from '../server/db/db.js';
import { FakeMailClient } from '../server/lib/gmail.js';
import type { Ctx } from '../server/engine/context.js';

export async function setup(nowIso = '2026-10-21T15:00:00Z') {
  const db: Db = await createDb({ memory: true });
  await migrate(db);
  const mail = new FakeMailClient();
  let now = new Date(nowIso);
  const ctx: Ctx = { db, mail, now: () => now, publicUrl: 'https://app.test', fullVerification: true };
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  return { db, mail, ctx, advance, setNow: (d: string) => (now = new Date(d)) };
}

export async function seedCampaign(db: Db, opts: { leads?: number; steps?: { delay: number; subject: string; body: string }[] } = {}) {
  const mb = (
    await db.query(
      `INSERT INTO mailboxes(email, from_name, daily_limit, ramp_enabled, min_gap_seconds, max_gap_seconds, next_send_at, last_synced_at)
       VALUES ('tyler@conversionlabshq.agency','Tyler', 30, false, 0, 1, '2020-01-01', now()) RETURNING *`,
    )
  )[0];
  const c = (
    await db.query(
      `INSERT INTO campaigns(name, status, timezone, use_lead_timezone, send_days, window_start, window_end)
       VALUES ('Test','running','America/New_York', true, '{0,1,2,3,4,5,6}', '00:00', '23:59') RETURNING *`,
    )
  )[0];
  await db.query(`INSERT INTO campaign_mailboxes VALUES ($1,$2)`, [c.id, mb.id]);
  const steps = opts.steps ?? [
    { delay: 0, subject: 'Quick question, {{firstName}}', body: 'Hi {{firstName}},\n\n{Saw|Noticed} {{company|your company}}.' },
    { delay: 3, subject: '', body: 'Following up, {{firstName}}.' },
  ];
  for (let i = 0; i < steps.length; i++) {
    const s = (await db.query(`INSERT INTO steps(campaign_id, position, delay_days) VALUES ($1,$2,$3) RETURNING id`, [c.id, i, steps[i].delay]))[0];
    await db.query(`INSERT INTO step_variants(step_id, subject, body) VALUES ($1,$2,$3)`, [s.id, steps[i].subject, steps[i].body]);
  }
  const leadIds: number[] = [];
  for (let i = 0; i < (opts.leads ?? 1); i++) {
    const l = (
      await db.query(
        `INSERT INTO leads(email, domain, first_name, company, verification_status) VALUES ($1,$2,$3,'Acme','valid') RETURNING id`,
        [`person${i}@acme${i}.com`, `acme${i}.com`, `Person${i}`],
      )
    )[0];
    await db.query(`INSERT INTO campaign_leads(campaign_id, lead_id, next_send_at) VALUES ($1,$2,'2020-01-01')`, [c.id, l.id]);
    leadIds.push(l.id);
  }
  return { mb, c, leadIds };
}
