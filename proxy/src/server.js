import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({ config, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.listen({ port: config.port, host: config.host });
