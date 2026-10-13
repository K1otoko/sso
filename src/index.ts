import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const app = createApp(config);
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

    if (error !== undefined) {
      console.error('Failed to close HTTP server', error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
