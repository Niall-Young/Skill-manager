import type { AgentsRegistry, SkillsRegistry } from "./model.ts";
import { buildInventory } from "./inventory.ts";
import { createMigrationPlan } from "./migration.ts";

export async function buildAudit(
  home: string,
  library: string,
  registry: SkillsRegistry,
  agents: AgentsRegistry,
): Promise<Record<string, unknown>> {
  const inventory = await buildInventory(home, library, registry);
  const migration = await createMigrationPlan(home, library, agents);
  const byName = new Map<string, typeof migration.candidates>();
  for (const candidate of migration.candidates) {
    byName.set(candidate.name, [...(byName.get(candidate.name) ?? []), candidate]);
  }
  const duplicates = [...byName.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([name, candidates]) => ({
      name,
      status: new Set(candidates.map((candidate) => candidate.digest)).size === 1 ? "same-content" : "content-conflict",
      paths: candidates.map((candidate) => candidate.sourcePath),
    }));
  return {
    library,
    summary: {
      managed: inventory.managed.length,
      external: inventory.external.length,
      migrationCandidates: migration.candidates.length,
      rootAliases: migration.rootAliases.length,
      duplicates: duplicates.length,
    },
    inventory,
    migration,
    duplicates,
  };
}
