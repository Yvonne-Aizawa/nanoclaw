import path from 'path';

import pino from 'pino';

const LOG_FILE = path.resolve(process.cwd(), 'workspace', 'logs', 'nanoclaw.jsonl');
const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  transport: {
    targets: [
      { target: 'pino-pretty', options: { colorize: true }, level },
      { target: 'pino/file', options: { destination: LOG_FILE, mkdir: true }, level },
    ],
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
