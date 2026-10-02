export interface ProgressEvent {
  type: 'start' | 'tick' | 'done';
  label: string;
  count: number;
  /** Bytes seen so far, when the operation measures sizes. */
  bytes: number;
  /** Expected bytes (e.g. used space of the drive being indexed); 0 when unknown. */
  total: number;
}
type Listener = (e: ProgressEvent) => void;

const listeners = new Set<Listener>();
let label = '';
let count = 0;
let bytes = 0;
let total = 0;
let last = 0;

/** Subscribe to progress events (CLI renderer, web UI). Returns an unsubscribe function. */
export function onProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (type: ProgressEvent['type']) => {
  for (const fn of listeners) fn({ type, label, count, bytes, total });
};

let aborted = false;
export const isAborted = () => aborted;
/** Request a stop: walkers and cleaners finish the current file, then return. */
export const requestAbort = () => (aborted = true);
/** Clear a previous stop request (the web UI runs many jobs in one process). */
export const resetAbort = () => (aborted = false);

export function installAbortHandler() {
  process.on('SIGINT', () => {
    if (aborted) process.exit(130);
    aborted = true;
    process.stderr.write('\n⚠ Stopping after current operations (services will be restarted)… press Ctrl+C again to force.\n');
  });
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Single-line progress indicator on stderr (no-op when not a TTY). */
export function installCliProgress() {
  if (!process.stderr.isTTY) return;
  onProgress((e) => {
    if (e.type === 'done') return void process.stderr.write('\r\x1b[2K');
    let line = `${e.label} … ${e.count.toLocaleString('en-US')} files`;
    if (e.bytes) line += `, ${gb(e.bytes)}`;
    if (e.total) line += ` (~${Math.min(99, Math.floor((e.bytes / e.total) * 100))}%)`;
    process.stderr.write(`\r\x1b[2K${line}`);
  });
}

/** Throttled progress: listeners get at most ~7 updates per second. */
export const progress = {
  /** `expectedBytes` lets listeners show a percentage (pair it with `addBytes`). */
  start(l: string, expectedBytes = 0) {
    label = l.length > 90 ? `${l.slice(0, 40)}…${l.slice(-45)}` : l;
    count = 0;
    bytes = 0;
    total = expectedBytes;
    last = 0;
    emit('start');
  },
  tick(n = 1) {
    count += n;
    if (!listeners.size) return;
    const now = Date.now();
    if (now - last < 150) return;
    last = now;
    emit('tick');
  },
  /** Add measured bytes; reported with the next tick. */
  addBytes(n: number) {
    bytes += n;
  },
  done() {
    emit('done');
  },
};
