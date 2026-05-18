import { spawn } from 'child_process';
import { ConversationSession, SDKMessage } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';

// Env vars that confuse the CLI when it's spawned from inside another Claude
// Code session. Strip them so the child gets a clean slate.
const ENV_VARS_TO_STRIP = [
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!ENV_VARS_TO_STRIP.includes(k)) out[k] = v;
  }
  return out;
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private claudeBin: string;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.claudeBin = process.env.CLAUDE_BIN || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
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
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    if (!slackContext) {
      // Headless / no human in the loop — let it run unattended.
      args.push('--permission-mode', 'bypassPermissions');
    }

    const cwd = workingDirectory || process.cwd();

    this.logger.debug('Spawning claude', { bin: this.claudeBin, cwd, hasSession: !!session?.sessionId });

    const proc = spawn(this.claudeBin, args, {
      cwd,
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // .cmd shims need a shell on Windows
    });

    if (abortController) {
      abortController.signal.addEventListener('abort', () => {
        if (!proc.killed) proc.kill();
      });
    }

    const stderrChunks: string[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      this.logger.debug('claude stderr', { text: text.trim() });
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.on('error', (err) => reject(err));
      proc.on('exit', (code, signal) => resolve({ code, signal }));
    });

    // NDJSON line buffer
    let buf = '';
    const queue: string[] = [];
    let resolveLine: ((line: string | null) => void) | null = null;
    let streamEnded = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        if (resolveLine) {
          const r = resolveLine;
          resolveLine = null;
          r(line);
        } else {
          queue.push(line);
        }
      }
    });

    proc.stdout?.on('end', () => {
      streamEnded = true;
      if (buf.trim().length > 0) {
        queue.push(buf.trim());
        buf = '';
      }
      if (resolveLine) {
        const r = resolveLine;
        resolveLine = null;
        r(null);
      }
    });

    try {
      while (true) {
        let line: string | null;
        if (queue.length > 0) {
          line = queue.shift()!;
        } else if (streamEnded) {
          break;
        } else {
          line = await new Promise<string | null>((resolve) => {
            resolveLine = resolve;
          });
        }
        if (line === null) break;

        let parsed: SDKMessage;
        try {
          parsed = JSON.parse(line) as SDKMessage;
        } catch (e) {
          this.logger.debug('Non-JSON line from claude (dropped)', { line: line.slice(0, 200) });
          continue;
        }

        if (parsed.type === 'system' && (parsed as any).subtype === 'init') {
          const sid = (parsed as any).session_id;
          if (session && sid) {
            session.sessionId = sid;
            this.logger.info('Session initialized', {
              sessionId: sid,
              model: (parsed as any).model,
              tools: (parsed as any).tools?.length || 0,
            });
          }
        }

        yield parsed;
      }

      const { code, signal } = await exitPromise;
      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join('').slice(-2000);
        this.logger.error('claude exited non-zero', { code, signal, stderr });
        throw new Error(`claude exited with code ${code}: ${stderr || '(no stderr)'}`);
      }
    } finally {
      if (!proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}
