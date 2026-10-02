import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi } from './format';
import { isWindows, winPaths } from './sys';

export type LogLevel = 'info' | 'warn' | 'debug';

export class Logger {
  private stream?: WriteStream;
  file?: string;
  /** Extra output (the web UI). When set, nothing is printed to the console. */
  sink?: (line: string, level: LogLevel) => void;

  constructor(readonly verbose: boolean) {}

  /** Start writing a log file under %ProgramData%\disk-janitor\logs (falls back to the temp dir). */
  open(name: string, dir?: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const candidates = [dir, isWindows ? path.join(winPaths().programData, 'disk-janitor', 'logs') : undefined, path.join(os.tmpdir(), 'disk-janitor')];
    for (const d of candidates) {
      if (!d) continue;
      try {
        mkdirSync(d, { recursive: true });
        this.file = path.join(d, `${name}-${stamp}.log`);
        this.stream = createWriteStream(this.file, { flags: 'a' });
        this.write(`disk-janitor ${name} started ${new Date().toISOString()} on ${os.hostname()} as ${os.userInfo().username}`);
        return;
      } catch {
        /* try next */
      }
    }
  }

  private write(line: string) {
    this.stream?.write(`${new Date().toISOString()}  ${stripAnsi(line)}\n`);
  }

  info(msg = '') {
    if (this.sink) this.sink(stripAnsi(msg), 'info');
    else console.log(msg);
    this.write(msg);
  }
  warn(msg: string) {
    if (this.sink) this.sink(stripAnsi(msg), 'warn');
    else console.warn(msg);
    this.write(`WARN ${msg}`);
  }
  /** Per-file detail: always in the log file, on screen only with --verbose (always sent to the sink). */
  debug(msg: string) {
    if (this.sink) this.sink(stripAnsi(msg), 'debug');
    else if (this.verbose) console.log(msg);
    this.write(msg);
  }

  close(): Promise<void> {
    const s = this.stream;
    this.stream = undefined;
    return new Promise((resolve) => (s ? s.end(resolve) : resolve()));
  }
}
