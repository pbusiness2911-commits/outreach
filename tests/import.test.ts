import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { setup, seedCampaign } from './helpers.js';

const KEY = vi.hoisted(() => (process.env.OUTREACH_API_KEY = 'k'.repeat(40)));

describe('lead import', () => {
  it('imports in bulk and skips role, suppressed, duplicate and busy leads', async () => {
    const { apiRouter } = await import('../server/routes/api.js');
    const { ctx, db } = await setup();
    const { c } = await seedCampaign(db, { leads: 1 }); // person0@acme0.com already in campaign 1
    const other = (await db.query(`INSERT INTO campaigns(name) VALUES ('Other') RETURNING id`))[0];
    await db.query(`INSERT INTO suppressions(kind, value, reason) VALUES ('email','blocked@x.com','manual'), ('domain','banned.com','manual')`);
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api', apiRouter(ctx));
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const post = (id: number, rows: any[]) =>
      fetch(`http://127.0.0.1:${port}/api/campaigns/${id}/leads`, {
        method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rows }),
      }).then((r) => r.json());

    const rows = [
      { email: 'Ann@Shop.com', first_name: 'Ann', company: 'Shop', timezone: 'Europe/London', businessType: 'roofer' },
      { email: 'ann@shop.com' },
      { email: 'info@shop.com' },
      { email: 'blocked@x.com' },
      { email: 'joe@banned.com' },
      { email: 'not-an-email' },
      { email: 'person0@acme0.com' },
      ...Array.from({ length: 300 }, (_, i) => ({ email: `p${i}@bulk.com`, timezone: 'Not/AZone' })),
    ];
    const r = await post(other.id, rows);
    expect(r).toEqual({ added: 301, duplicates: 1, invalid: 1, suppressed: 2, role: 1, in_other_campaign: 1 });

    const again = await post(other.id, rows);
    expect(again.added).toBe(0);
    expect(again.duplicates).toBe(302);

    const ann = (await db.query(`SELECT * FROM leads WHERE email = 'ann@shop.com'`))[0];
    expect([ann.first_name, ann.company, ann.timezone, ann.custom.businessType]).toEqual(['Ann', 'Shop', 'Europe/London', 'roofer']);
    expect((await db.query(`SELECT timezone FROM leads WHERE email = 'p0@bulk.com'`))[0].timezone).toBeNull();
    expect(c.id).not.toBe(other.id);
    server.close();
  });
});
