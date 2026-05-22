import { ClaudeProcess } from './claude-process';
import { Logger } from './logger';

export type SpawnFn = (cwd: string) => ClaudeProcess;

// Keeps a small set of pre-warmed `claude` processes alive and idle, bound
// to one cwd. New threads can grab one of these and skip the Node + tool
// discovery cold start (~5-8s on Windows).
export class WarmPool {
  private logger = new Logger('WarmPool');
  private idle: ClaudeProcess[] = [];
  private targetSize: number;
  private spawnFn: SpawnFn;
  private defaultCwd: string;
  private shuttingDown = false;

  constructor(targetSize: number, defaultCwd: string, spawnFn: SpawnFn) {
    this.targetSize = targetSize;
    this.defaultCwd = defaultCwd;
    this.spawnFn = spawnFn;
  }

  warmUp(): void {
    for (let i = 0; i < this.targetSize; i++) {
      this.spawnOne();
    }
    this.logger.info('Warm pool started', { targetSize: this.targetSize, cwd: this.defaultCwd });
  }

  private spawnOne(): void {
    if (this.shuttingDown) return;
    try {
      const p = this.spawnFn(this.defaultCwd);
      p.once('exit', () => {
        const idx = this.idle.indexOf(p);
        if (idx !== -1) {
          this.idle.splice(idx, 1);
          this.logger.warn('Idle warm process died, replacing');
          this.spawnOne();
        }
      });
      this.idle.push(p);
    } catch (err) {
      this.logger.error('Failed to spawn warm process', err);
    }
  }

  // Returns a warm process bound to defaultCwd, or null if cwd doesn't match
  // or pool is empty. Pool refills in the background regardless.
  acquire(cwd: string): ClaudeProcess | null {
    if (cwd !== this.defaultCwd) {
      return null;
    }
    const p = this.idle.shift();
    setImmediate(() => this.spawnOne());
    if (p && !p.isDead()) {
      this.logger.debug('Warm process acquired', { remaining: this.idle.length });
      return p;
    }
    return null;
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const p of this.idle) p.kill();
    this.idle = [];
  }

  size(): number {
    return this.idle.length;
  }
}
