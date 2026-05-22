import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ClaudeStreamMessage } from './types';
import { Logger } from './logger';

export interface ClaudeProcessOptions {
  bin: string;
  cwd: string;
  model: string;
  appendSystemPrompt: string;
  resumeSessionId?: string;
  env: NodeJS.ProcessEnv;
  permissionMode?: string;
  disallowedTools?: string;     // comma-separated list, e.g. "NotebookEdit,WebSearch"
  includePartialMessages?: boolean;
}

// Wraps a single long-lived `claude` subprocess in stream-json input/output
// mode. The process stays alive across turns; each turn is one user message
// in, one assistant turn out (terminated by a `result` event).
export class ClaudeProcess extends EventEmitter {
  readonly proc: ChildProcess;
  readonly cwd: string;
  readonly model: string;
  sessionId?: string;
  busy = false;
  lastActivity = new Date();
  spawnedAt = new Date();

  private buf = '';
  private logger = new Logger('ClaudeProcess');
  private dead = false;
  private stderrTail: string[] = [];

  constructor(opts: ClaudeProcessOptions) {
    super();
    this.cwd = opts.cwd;
    this.model = opts.model;

    const args: string[] = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', opts.model,
      '--append-system-prompt', opts.appendSystemPrompt,
    ];
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }
    if (opts.includePartialMessages) {
      args.push('--include-partial-messages');
    }
    if (opts.disallowedTools && opts.disallowedTools.trim()) {
      args.push('--disallowedTools', opts.disallowedTools.trim());
    }
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    const useShell = /\.(cmd|bat)$/i.test(opts.bin);
    this.proc = spawn(opts.bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });

    this.logger.debug('Spawned claude (streaming)', {
      pid: this.proc.pid,
      cwd: opts.cwd,
      model: opts.model,
      resume: !!opts.resumeSessionId,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.logger.debug('claude stderr', { text: text.trim() });
    });
    this.proc.on('exit', (code, signal) => {
      this.dead = true;
      const stderr = this.stderrTail.join('').slice(-2000);
      this.logger.info('claude exited', { code, signal, stderr: stderr || '(empty)' });
      this.emit('exit', { code, signal, stderr });
    });
    this.proc.on('error', (err) => {
      this.dead = true;
      this.logger.error('claude process error', err);
      this.emit('error', err);
    });
  }

  private onStdout(chunk: Buffer) {
    this.buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;

      let parsed: ClaudeStreamMessage;
      try {
        parsed = JSON.parse(line) as ClaudeStreamMessage;
      } catch {
        this.logger.debug('Non-JSON line from claude (dropped)', { line: line.slice(0, 200) });
        continue;
      }

      if (parsed.type === 'system' && (parsed as any).subtype === 'init') {
        const sid = (parsed as any).session_id;
        if (sid && !this.sessionId) {
          this.sessionId = sid;
        }
      }
      this.lastActivity = new Date();
      this.emit('message', parsed);
    }
  }

  // Send one user message and yield ClaudeStreamMessages until the turn-terminating
  // `result` event arrives. Throws if another turn is already in flight or
  // the process has died.
  async *streamTurn(content: string): AsyncGenerator<ClaudeStreamMessage, void, unknown> {
    if (this.dead) throw new Error('claude process is dead');
    if (this.busy) throw new Error('claude process is busy with another turn');
    this.busy = true;

    const queue: ClaudeStreamMessage[] = [];
    let resolveNext: ((m: ClaudeStreamMessage | null) => void) | null = null;
    let terminated = false;
    let exitError: Error | null = null;

    const onMessage = (msg: ClaudeStreamMessage) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(msg);
      } else {
        queue.push(msg);
      }
    };
    const onExit = (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => {
      terminated = true;
      if (info.code !== 0 && info.code !== null) {
        exitError = new Error(`claude exited with code ${info.code}: ${info.stderr || '(no stderr)'}`);
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    };

    this.on('message', onMessage);
    this.once('exit', onExit);

    try {
      const userMsg = { type: 'user', message: { role: 'user', content } };
      this.proc.stdin!.write(JSON.stringify(userMsg) + '\n');
      this.lastActivity = new Date();

      while (true) {
        let msg: ClaudeStreamMessage | null;
        if (queue.length > 0) {
          msg = queue.shift()!;
        } else if (terminated) {
          break;
        } else {
          msg = await new Promise<ClaudeStreamMessage | null>((res) => { resolveNext = res; });
          if (msg === null) {
            // exit happened
            break;
          }
        }
        yield msg;
        if (msg.type === 'result') {
          // turn complete; process stays alive
          break;
        }
      }

      if (exitError) throw exitError;
    } finally {
      this.off('message', onMessage);
      this.off('exit', onExit);
      this.busy = false;
    }
  }

  isDead(): boolean {
    return this.dead;
  }

  kill() {
    if (!this.dead && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }

  idleMs(): number {
    return Date.now() - this.lastActivity.getTime();
  }
}
