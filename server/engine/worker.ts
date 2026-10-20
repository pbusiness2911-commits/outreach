import type { Ctx } from './context.js';
import { logEvent } from './context.js';
import { sendTick } from './sender.js';
import { syncTick } from './sync.js';
import { healthTick, dnsTick, verifyTick } from './health.js';

type Job = { name: string; everyMs: number; run: (ctx: Ctx) => Promise<unknown>; last: number; running: boolean };

/** Runs the background jobs. Only one worker may run at a time (Postgres advisory lock). */
export function startWorker(ctx: Ctx, opts: { usePgLock: boolean }) {
  const jobs: Job[] = [
    { name: 'send', everyMs: 20_000, run: sendTick, last: 0, running: false },
    { name: 'sync', everyMs: 60_000, run: syncTick, last: 0, running: false },
    { name: 'verify', everyMs: 30_000, run: (c) => verifyTick(c), last: 0, running: false },
    { name: 'health', everyMs: 10 * 60_000, run: healthTick, last: 0, running: false },
    { name: 'dns', everyMs: 60 * 60_000, run: (c) => dnsTick(c), last: 0, running: false },
  ];
  let stopped = false;
  let haveLock = !opts.usePgLock;

  async function loop() {
    if (stopped) return;
    try {
      if (!haveLock) {
        const r = await ctx.db.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(424242) AS ok`);
        haveLock = r[0].ok;
        if (!haveLock) return; // another copy of the app is the sender
        console.log('Worker: acquired sender lock');
      }
      const now = Date.now();
      for (const job of jobs) {
        if (job.running || now - job.last < job.everyMs) continue;
        job.running = true;
        job.last = now;
        job.run(ctx)
          .catch((err) => logEvent(ctx.db, 'error', `job:${job.name}`, err?.message || String(err)).catch(() => {}))
          .finally(() => (job.running = false));
      }
    } catch (err: any) {
      console.error('Worker loop error:', err.message);
    } finally {
      if (!stopped) setTimeout(loop, 5_000);
    }
  }
  setTimeout(loop, 3_000);
  return () => {
    stopped = true;
  };
}
