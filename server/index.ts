import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, assertConfig } from './config.js';
import { createDb, migrate } from './db/db.js';
import { GmailClient, FakeMailClient, type MailClient } from './lib/gmail.js';
import type { Ctx } from './engine/context.js';
import { startWorker } from './engine/worker.js';
import { apiRouter } from './routes/api.js';
import { publicRouter } from './routes/public.js';

const problems = assertConfig();
for (const p of problems) console.warn(`Config warning: ${p}`);

const db = await createDb({ url: config.databaseUrl });
const applied = await migrate(db);
if (applied.length) console.log(`Database migrations applied: ${applied.join(', ')}`);

let mail: MailClient;
if (config.dryRun || !config.serviceAccountJson) {
  mail = new FakeMailClient();
  console.warn(config.dryRun ? 'DRY_RUN is on: no real emails will be sent.' : 'No Google service account configured: running in dry-run mode (nothing is sent).');
} else {
  mail = new GmailClient();
}

const ctx: Ctx = {
  db,
  mail,
  now: () => new Date(),
  publicUrl: config.publicUrl,
  fullVerification: !!config.millionVerifierKey,
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(publicRouter(ctx));
app.use('/api', apiRouter(ctx));

const clientDir = path.resolve('dist/client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|u\/|t\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

app.listen(config.port, () => console.log(`Outreach app listening on port ${config.port}`));
startWorker(ctx, { usePgLock: !!config.databaseUrl });

