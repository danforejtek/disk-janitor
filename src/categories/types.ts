import type { Logger } from '../lib/logger';

export type Risk = 'safe' | 'moderate' | 'caution';
export type Group = 'system' | 'node' | 'web' | 'dotnet' | 'dev' | 'custom';

export interface Item {
  path: string;
  bytes: number;
  /** Bytes in hard-linked files (e.g. node_modules linked to the pnpm store) — not freed by deleting this item alone. */
  linkedBytes?: number;
  files?: number;
  detail?: string;
  /** How clean handles this item when the category supports several: delete a file, trim an active log, or remove a folder. */
  action?: 'delete' | 'trim' | 'tree';
  /** Root the item must stay inside (re-checked right before deleting). */
  root?: string;
}

export interface ScanResult {
  /** Estimated reclaimable bytes. */
  bytes: number;
  files: number;
  items: Item[];
  notes: string[];
  errors: number;
}

export interface CleanResult {
  freedBytes: number;
  deleted: number;
  failed: number;
  notes: string[];
}

export interface CustomPath {
  id?: string;
  path: string;
  olderThanDays?: number;
  /** Optional regex tested against the file name. */
  pattern?: string;
  /** Also trim files bigger than this (MB) to their last `logKeepMb` instead of skipping them as too new — for logs nobody rotates. */
  truncateOverMb?: number;
}

export interface Options {
  tempAgeDays: number;
  logAgeDays: number;
  nodeModulesAgeDays: number;
  /** Where to search for stale node_modules (default: all fixed drives). */
  searchRoots: string[];
  /** Extra pnpm store folders to consider. */
  pnpmStores: string[];
  custom: CustomPath[];
  resetBase: boolean;
  /** Active logs (pm2, nginx) bigger than this are trimmed. */
  logMaxMb: number;
  /** How much of the end of a trimmed log is kept. */
  logKeepMb: number;
  /** Build agent work folders untouched for this long are removed (agent-work). */
  workAgeDays: number;
  /** msi-orphans: move packages here (another drive) instead of deleting them. */
  quarantine?: string;
  /** Extra nginx install folders (the folder with nginx.exe). */
  nginxRoots: string[];
  /** Extra PM2_HOME folders. */
  pm2Homes: string[];
  /** Extra build agent / runner folders. */
  agentRoots: string[];
}

export interface Ctx {
  options: Options;
  dryRun: boolean;
  admin: boolean;
  log: Logger;
}

export interface Category {
  id: string;
  group: Group;
  title: string;
  description: string;
  risk: Risk;
  /** Needs an elevated prompt to clean. */
  needsAdmin?: boolean;
  /** Slow to scan — only included by default with --deep. */
  deepOnly?: boolean;
  /** Informational only; nothing to clean automatically. */
  reportOnly?: boolean;
  /** Only cleaned when picked by ID (never by "safe" / "all"). */
  explicitOnly?: boolean;
  scan(ctx: Ctx): Promise<ScanResult>;
  clean?(ctx: Ctx, scan: ScanResult): Promise<CleanResult>;
}

export const emptyScan = (notes: string[] = []): ScanResult => ({ bytes: 0, files: 0, items: [], notes, errors: 0 });
export const emptyClean = (): CleanResult => ({ freedBytes: 0, deleted: 0, failed: 0, notes: [] });
