import { createApp, startScheduler } from './app.ts';
import { log } from './lib/log.ts';
import { buildServer } from './server.ts';

const app = createApp();
const server = buildServer(app.cfg, app.db, app.queue);
const stopScheduler = startScheduler(app);
void app.queue.start();

server.listen(app.cfg.port, () => {
  log.info('connector started', { port: app.cfg.port, dryRun: app.cfg.dryRun, publicUrl: app.cfg.publicUrl });
  if (app.cfg.dryRun) log.warn('DRY_RUN=true: no write will be sent to Shopify or Jewely');
});

function shutdown(signal: string) {
  log.info('shutting down', { signal });
  stopScheduler();
  app.queue.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
