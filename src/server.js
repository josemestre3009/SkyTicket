import { buildApp } from './app.js';
import { config } from './config.js';

const app = buildApp();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err, 'failed to start web server');
  process.exit(1);
}
