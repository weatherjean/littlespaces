import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly listeners = new Set<(message: RpcMessage) => void>();
  private closed = false;
  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    // Provider logs can contain credentials or prompts. Do not forward them to HTTP or app logs.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message.method && typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
    this.child.once('error', () => this.fail());
    this.child.once('exit', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
  }
  private fail() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('ChatGPT connection stopped. Please try again.');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'connection/closed' });
  }
  send(message: RpcMessage) {
    if (this.closed) throw new Error('ChatGPT connection stopped. Please try again.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ChatGPT took too long. Please try again.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    this.child.kill();
    this.fail();
  }
}
