import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabase } from './db/client.js';
import { UsersRepository } from './users/repository.js';

const config = loadConfig();

if (config.databaseUrl === undefined) {
  console.error('DATABASE_URL 未配置，无法启动。请参考 .env.example。');
  process.exit(1);
}

const database = createDatabase(config.databaseUrl);
const users = new UsersRepository(database.db);
const app = createApp({ config, database: database.db, users });
const server = createServer(app);

server.listen(config.port, config.host, () => {
  console.log(`SSO server listening at http://${config.host}:${String(config.port)}`);
  console.log(`OIDC issuer: ${config.oidcIssuer}`);
});

server.on('error', (error) => {
  console.error('HTTP server error', error);
  process.exitCode = 1;
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down`);

  const forceShutdownTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceShutdownTimer.unref();

  server.close((error) => {
    clearTimeout(forceShutdownTimer);

    void database.close().finally(() => {
      if (error !== undefined) {
        console.error('Failed to close HTTP server', error);
        process.exitCode = 1;
      }
    });
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
