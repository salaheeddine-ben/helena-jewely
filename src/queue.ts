// Durable job queue on SQLite. Webhook handlers only enqueue and answer right away (Shopify allows ~5 s),
// and the heavy work runs here with retries and exponential backoff.
import type { Db } from './db.ts';
import { log } from './lib/log.ts';
import { sleep } from './lib/util.ts';

export type JobType = 'product.sync' | 'order.import' | 'order.cancelled' | 'order.refund' | 'erp.poll' | 'erp.full_sync';

export interface Job {
  id: number;
  type: JobType;
  dedupe_key: string | null;
  payload: string;
  attempts: number;
}

export type Handler = (payload: any, job: Job) => Promise<void>;

const MAX_ATTEMPTS = 8;

export class Queue {
  private handlers = new Map<JobType, Handler>();
  private running = false;
  private db: Db;
  private onDead?: (job: Job, err: unknown) => Promise<void>;

  constructor(db: Db, onDead?: (job: Job, err: unknown) => Promise<void>) {
    this.db = db;
    this.onDead = onDead;
    // Jobs left "running" by a crash become pending again.
    db.prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
  }

  on(type: JobType, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  /** Enqueue a job. With a dedupe key, a job that is already pending with the same key absorbs it. */
  enqueue(type: JobType, payload: unknown, opts: { dedupeKey?: string; delayMs?: number } = {}): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO jobs(type, dedupe_key, payload, status, attempts, run_at, created_at, updated_at)
      VALUES(?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(dedupe_key) WHERE status = 'pending' DO NOTHING
    `).run(type, opts.dedupeKey ?? null, JSON.stringify(payload ?? {}), now + (opts.delayMs ?? 0), now, now);
  }

  stats(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  deadJobs(limit = 50): unknown[] {
    return this.db.prepare(`SELECT id, type, dedupe_key, attempts, last_error, updated_at FROM jobs WHERE status = 'dead' ORDER BY id DESC LIMIT ?`).all(limit);
  }

  retryDead(): number {
    const res = this.db.prepare(`UPDATE jobs SET status = 'pending', attempts = 0, run_at = ? WHERE status = 'dead'`).run(Date.now());
    return Number(res.changes);
  }

  /** Processes due jobs one at a time. The Jewely instance is small, so the queue runs sequentially on purpose. */
  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const job = this.claim();
      if (!job) {
        await sleep(1000);
        continue;
      }
      await this.runJob(job);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Runs every due job now (used by CLI commands and tests). */
  async drain(): Promise<void> {
    for (let job = this.claim(); job; job = this.claim()) await this.runJob(job);
  }

  private claim(): Job | undefined {
    const job = this.db.prepare(`
      SELECT id, type, dedupe_key, payload, attempts FROM jobs
      WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1
    `).get(Date.now()) as Job | undefined;
    if (!job) return undefined;
    // Moving to "running" frees the pending dedupe slot, so new events for this key queue a fresh job.
    this.db.prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    return job;
  }

  private async runJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(JSON.parse(job.payload), job);
      this.db.prepare(`UPDATE jobs SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(Date.now(), job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      const dead = attempts >= MAX_ATTEMPTS || (err as { permanent?: boolean })?.permanent === true;
      const backoff = Math.min(60 * 60_000, 30_000 * 2 ** (attempts - 1)); // 30 s, 1 min, 2 min, ... capped at 1 h
      log[dead ? 'error' : 'warn']('job failed', { jobId: job.id, type: job.type, key: job.dedupe_key, attempts, dead, error: message });
      // A job can't go back to "pending" while another pending job holds its dedupe key, so free the key when it does.
      this.db.prepare(`
        UPDATE jobs SET status = ?, attempts = ?, last_error = ?, run_at = ?, updated_at = ?,
          dedupe_key = CASE WHEN ? = 'pending' AND EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key = jobs.dedupe_key AND j.status = 'pending' AND j.id <> jobs.id)
                            THEN NULL ELSE dedupe_key END
        WHERE id = ?
      `).run(dead ? 'dead' : 'pending', attempts, message.slice(0, 2000), Date.now() + backoff, Date.now(), dead ? 'dead' : 'pending', job.id);
      if (dead && this.onDead) await this.onDead(job, err).catch((e) => log.error('onDead hook failed', { error: e }));
    }
    // Clean up finished jobs older than 14 days.
    this.db.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`).run(Date.now() - 14 * 86_400_000);
  }
}

/** Throw this for errors a retry can't fix (bad data, missing mapping): the job goes straight to "dead". */
export class PermanentError extends Error {
  permanent = true;
}
