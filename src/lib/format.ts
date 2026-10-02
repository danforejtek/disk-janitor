const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
};

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export const fmtNum = (n: number) => n.toLocaleString('en-US');
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time

/** Parse "1.23 GB", "512 MB", "1,5 GB" → bytes. */
export function parseSize(value: string, unit: string): number {
  const n = Number.parseFloat(value.replace(',', '.'));
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(n * (mult[unit.toUpperCase()] ?? 1));
}

export function table(rows: string[][], align: Array<'l' | 'r'> = []): string {
  if (!rows.length) return '';
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const pad = ' '.repeat((widths[i] ?? 0) - stripAnsi(cell).length);
          return align[i] === 'r' ? pad + cell : cell + pad;
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
