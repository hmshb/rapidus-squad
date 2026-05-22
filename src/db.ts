import { Pool } from 'pg';
import { Logger } from './logger';

const logger = new Logger('DB');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/ai_employee)');
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  logger.error('Idle pg client error', err);
});

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS working_directories (
      config_key  TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      thread_ts   TEXT,
      user_id     TEXT,
      directory   TEXT NOT NULL,
      set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_key   TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT,
      session_id    TEXT,
      last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  logger.info('Schema ready');
}
