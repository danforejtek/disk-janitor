import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Category, Options } from './categories';

export const VERSION = '2.0.0';

export function loadConfig(file: string | undefined): Partial<Options> {
  const candidates = file
    ? [file]
    : [path.join(path.dirname(process.execPath), 'disk-janitor.json'), path.join(process.cwd(), 'disk-janitor.json')];
  for (const f of candidates) {
    if (!existsSync(f)) {
      if (file) throw new Error(`config not found: ${f}`);
      continue;
    }
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Partial<Options>;
    } catch (e) {
      throw new Error(`invalid JSON in ${f}: ${(e as Error).message}`);
    }
  }
  return {};
}

export const num = (v: string | undefined, fallback: number, name: string) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};
export const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** Category selection shared by scan / clean / the UI. */
export function selectCategories(cats: Category[], sel: { only?: string[]; groups?: string[]; deep?: boolean }): Category[] {
  const byId = new Map(cats.map((x) => [x.id, x]));
  const only = (sel.only ?? []).map((s) => s.toLowerCase());
  const unknown = only.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`unknown category: ${unknown.join(', ')} — see \`disk-janitor list\``);
  let out = only.length ? cats.filter((x) => only.includes(x.id)) : cats.filter((x) => sel.deep || !x.deepOnly);
  const groups = (sel.groups ?? []).map((s) => s.toLowerCase()).flatMap((g) => (g === 'dev' ? ['node', 'dotnet', 'dev'] : [g]));
  if (groups.length) out = out.filter((x) => groups.includes(x.group));
  return out;
}

export function buildOptions(cfg: Partial<Options>, values: Record<string, string | boolean | undefined>): Options {
  const s = (k: string) => values[k] as string | undefined;
  return {
    tempAgeDays: num(s('temp-age'), cfg.tempAgeDays ?? 3, 'temp-age'),
    logAgeDays: num(s('log-age'), cfg.logAgeDays ?? 14, 'log-age'),
    nodeModulesAgeDays: num(s('nm-age'), cfg.nodeModulesAgeDays ?? 60, 'nm-age'),
    workAgeDays: num(s('work-age'), cfg.workAgeDays ?? 30, 'work-age'),
    logMaxMb: num(s('log-max-mb'), cfg.logMaxMb ?? 100, 'log-max-mb'),
    logKeepMb: num(s('log-keep-mb'), cfg.logKeepMb ?? 20, 'log-keep-mb'),
    searchRoots: s('roots') ? list(s('roots')) : (cfg.searchRoots ?? []),
    pnpmStores: cfg.pnpmStores ?? [],
    nginxRoots: cfg.nginxRoots ?? [],
    pm2Homes: cfg.pm2Homes ?? [],
    agentRoots: cfg.agentRoots ?? [],
    quarantine: s('quarantine') ?? cfg.quarantine,
    custom: cfg.custom ?? [],
    resetBase: !!values['reset-base'],
  };
}
