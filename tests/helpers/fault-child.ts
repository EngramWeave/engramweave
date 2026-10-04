import { fork } from 'node:child_process';
import { once } from 'node:events';

/** A bounded IPC gate for killing only the fault-test process created here. */
export function faultChild(filename: string, args: string[]) {
  const child = fork(filename, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let errors = '';
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  const messages = new Map<string, Record<string, string>>();
  const waiters = new Map<string, (message: Record<string, string>) => void>();
  child.on('message', (message: Record<string, string>) => {
    messages.set(message.phase!, message); waiters.get(message.phase!)?.(message);
  });
  return {
    async phase(name: string): Promise<Record<string, string>> {
      if (messages.has(name)) return messages.get(name)!;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(name); reject(new Error(`Fault gate ${name} timed out: ${errors}`)); }, 10_000);
        waiters.set(name, message => { clearTimeout(timer); waiters.delete(name); resolve(message); });
        void exited.then(() => { if (waiters.has(name)) { clearTimeout(timer); waiters.delete(name); reject(new Error(`Fault child exited before ${name}: ${errors}`)); } });
      });
    },
    release() { child.send({ type: 'continue' }); },
    async kill() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; },
  };
}
