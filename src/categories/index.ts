import { customCategories, devCategories, resetNodeProjects } from './dev';
import { dotnetCategories, resetDotnetCaches } from './dotnet';
import { nodeCategories } from './node';
import { systemCategories } from './system';
import type { Category, Ctx } from './types';
import { webCategories } from './web';

/** All categories in clean-up order (node-modules before pnpm-store so its prune picks up what was orphaned). */
export function allCategories(ctx: Ctx): Category[] {
  return [...systemCategories(), ...devCategories(), ...nodeCategories(), ...webCategories(), ...dotnetCategories(), ...customCategories(ctx)];
}

/** Forget per-run discovery results (the web UI runs many scans in one process). */
export function resetCaches() {
  resetNodeProjects();
  resetDotnetCaches();
}

export * from './types';
