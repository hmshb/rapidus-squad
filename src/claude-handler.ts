import * as fs from 'fs';
import * as path from 'path';
import { ConversationSession, ClaudeStreamMessage } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { pool } from './db';
import { CASEY_SYSTEM_PROMPT } from './casey-prompt';
import { config } from './config';
import { ClaudeProcess } from './claude-process';
import { WarmPool } from './process-pool';

// Recursion-detection flags set by a parent Claude Code session, plus
// ANTHROPIC_API_KEY which (if set, often stale) preempts the OAuth credentials
// file used by `claude` subscriptions. Stripping these lets the child run as
// a fresh top-level CLI invocation authenticating via ~/.claude credentials.
const ENV_VARS_TO_STRIP = [
  'CLAUDECODE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'ANTHROPIC_API_KEY',
];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!ENV_VARS_TO_STRIP.includes(k)) out[k] = v;
  }
  return out;
}

const WARM_POOL_SIZE = parseInt(process.env.CASEY_WARM_POOL_SIZE || '2', 10);
const BOUND_IDLE_MAX_MS = 30 * 60 * 1000; // kill bound processes idle 30 min

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private bound: Map<string, ClaudeProcess> = new Map();
  private warmPool: WarmPool | null = null;
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private claudeBin: string;
  private reaper?: NodeJS.Timeout;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.claudeBin = process.env.CLAUDE_BIN || this.resolveClaudeBin();
    this.logger.info('Resolved claude binary', { path: this.claudeBin });
  }

  // Initialize: hydrate persisted sessions, then start the warm pool. Idempotent.
  async init(): Promise<void> {
    await this.hydrate();
    const defaultCwd = this.resolveDefaultCwd();
    if (defaultCwd) {
      this.warmPool = new WarmPool(WARM_POOL_SIZE, defaultCwd, (cwd) => this.spawnProcess(cwd));
      this.warmPool.warmUp();
    } else {
      this.logger.warn('No default cwd available; warm pool disabled');
    }
    this.reaper = setInterval(() => this.reapIdleBound(), 60 * 1000);
    this.reaper.unref?.();
  }

  private resolveDefaultCwd(): string | null {
    const v = config.defaultWorkingDirectory;
    if (!v) return null;
    if (path.isAbsolute(v) && fs.existsSync(v)) return path.resolve(v);
    if (config.baseDirectory) {
      const joined = path.join(config.baseDirectory, v);
      if (fs.existsSync(joined)) return path.resolve(joined);
    }
    const cwdRel = path.resolve(v);
    if (fs.existsSync(cwdRel)) return cwdRel;
    return null;
  }

  async hydrate(): Promise<void> {
    const { rows } = await pool.query(
      `SELECT session_key, user_id, channel_id, thread_ts, session_id, last_activity FROM sessions`
    );
    for (const r of rows) {
      this.sessions.set(r.session_key, {
        userId: r.user_id,
        channelId: r.channel_id,
        threadTs: r.thread_ts ?? undefined,
        sessionId: r.session_id ?? undefined,
        isActive: false,
        lastActivity: r.last_activity,
      });
    }
    this.logger.info('Hydrated sessions from DB', { count: rows.length });
  }

  private persistSession(key: string, s: ConversationSession): void {
    pool.query(
      `INSERT INTO sessions (session_key, user_id, channel_id, thread_ts, session_id, last_activity)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_key) DO UPDATE
       SET session_id    = EXCLUDED.session_id,
           last_activity = EXCLUDED.last_activity`,
      [key, s.userId, s.channelId, s.threadTs ?? null, s.sessionId ?? null, s.lastActivity]
    ).catch((err) => this.logger.error('persist sessions failed', err));
  }

  private deleteSessionRow(key: string): void {
    pool.query(`DELETE FROM sessions WHERE session_key = $1`, [key])
      .catch((err) => this.logger.error('delete sessions failed', err));
  }

  // Find claude on PATH and resolve to an absolute path so spawn doesn't depend
  // on shell PATHEXT quirks. Falls back to the bare name if not found.
  private resolveClaudeBin(): string {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const name of candidates) {
        const full = path.join(dir, name);
        try { if (fs.statSync(full).isFile()) return full; } catch { /* not here */ }
      }
    }
    return isWin ? 'claude.exe' : 'claude';
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    const key = this.getSessionKey(userId, channelId, threadTs);
    this.sessions.set(key, session);
    this.persistSession(key, session);
    return session;
  }

  private spawnProcess(cwd: string, resumeSessionId?: string): ClaudeProcess {
    return new ClaudeProcess({
      bin: this.claudeBin,
      cwd,
      model: process.env.CASEY_MODEL || 'claude-sonnet-4-5',
      appendSystemPrompt: CASEY_SYSTEM_PROMPT,
      resumeSessionId,
      env: scrubbedEnv(),
      disallowedTools: process.env.CASEY_DISALLOWED_TOOLS || 'NotebookEdit,NotebookRead,WebSearch',
      includePartialMessages: process.env.CASEY_DISABLE_STREAMING === 'true' ? false : true,
    });
  }

  // Get (or create) the long-lived claude process bound to this sessionKey.
  // Priority: existing bound → warm pool (matching cwd, no resume) → cold spawn.
  private acquireProcess(sessionKey: string, cwd: string, resumeSessionId?: string): ClaudeProcess {
    let proc = this.bound.get(sessionKey);
    if (proc && proc.isDead()) {
      this.bound.delete(sessionKey);
      proc = undefined;
    }
    if (proc) return proc;

    if (!resumeSessionId && this.warmPool) {
      const warm = this.warmPool.acquire(cwd);
      if (warm) {
        this.logger.info('Bound warm process to session', { sessionKey, cwd });
        this.bound.set(sessionKey, warm);
        this.attachExitHandler(sessionKey, warm);
        return warm;
      }
    }

    this.logger.info('Cold-spawning claude for session', { sessionKey, cwd, resume: !!resumeSessionId });
    const fresh = this.spawnProcess(cwd, resumeSessionId);
    this.bound.set(sessionKey, fresh);
    this.attachExitHandler(sessionKey, fresh);
    return fresh;
  }

  private attachExitHandler(sessionKey: string, proc: ClaudeProcess): void {
    proc.once('exit', () => {
      if (this.bound.get(sessionKey) === proc) {
        this.bound.delete(sessionKey);
        this.logger.info('Bound process exited; unbound from session', { sessionKey });
      }
    });
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    _slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<ClaudeStreamMessage, void, unknown> {
    const cwd = workingDirectory || process.cwd();

    // Without a session we can't bind to a thread; fall back to a one-shot
    // cold spawn that's killed when the turn ends.
    if (!session) {
      const proc = this.spawnProcess(cwd);
      const abortHook = () => proc.kill();
      abortController?.signal.addEventListener('abort', abortHook);
      try {
        for await (const msg of proc.streamTurn(prompt)) {
          yield msg;
        }
      } finally {
        proc.kill();
        abortController?.signal.removeEventListener('abort', abortHook);
      }
      return;
    }

    const sessionKey = this.getSessionKey(session.userId, session.channelId, session.threadTs);
    const proc = this.acquireProcess(sessionKey, cwd, session.sessionId);

    const abortHook = () => {
      proc.kill();
      this.bound.delete(sessionKey);
    };
    abortController?.signal.addEventListener('abort', abortHook);

    try {
      for await (const msg of proc.streamTurn(prompt)) {
        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          const sid = (msg as any).session_id;
          if (sid && session.sessionId !== sid) {
            session.sessionId = sid;
            session.lastActivity = new Date();
            this.persistSession(sessionKey, session);
            this.logger.info('Session initialized', {
              sessionId: sid,
              model: (msg as any).model,
              tools: (msg as any).tools?.length || 0,
            });
          }
        }
        yield msg;
      }
      session.lastActivity = new Date();
      this.persistSession(sessionKey, session);
    } finally {
      abortController?.signal.removeEventListener('abort', abortHook);
    }
  }

  private reapIdleBound(): void {
    let reaped = 0;
    for (const [key, proc] of this.bound.entries()) {
      if (!proc.busy && proc.idleMs() > BOUND_IDLE_MAX_MS) {
        proc.kill();
        this.bound.delete(key);
        reaped++;
      }
    }
    if (reaped > 0) {
      this.logger.info(`Reaped ${reaped} idle bound processes`);
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        this.deleteSessionRow(key);
        const bound = this.bound.get(key);
        if (bound) {
          bound.kill();
          this.bound.delete(key);
        }
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }

  shutdown(): void {
    if (this.reaper) clearInterval(this.reaper);
    for (const p of this.bound.values()) p.kill();
    this.bound.clear();
    this.warmPool?.shutdown();
  }
}
