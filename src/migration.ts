import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentsRegistry } from "./model.ts";
import type { SkillsRegistry } from "./model.ts";
import { loadSkillsRegistry, saveSkillsRegistry } from "./registry.ts";
import { applySyncPlan, buildSyncPlan } from "./sync.ts";

export interface MigrationCandidate {
  id: string;
  name: string;
  agent: string;
  sourcePath: string;
  resolvedPath: string;
  proposedLibraryPath: string;
  digest: string;
  action: "review" | "adopt" | "ignore";
  agents: string[];
}

export interface MigrationPlan {
  version: 1;
  library: string;
  createdAt: string;
  rootAliases: Array<{ agent: string; path: string; target: string; action: "review" | "split" | "ignore" }>;
  candidates: MigrationCandidate[];
  diagnostics: string[];
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update(await readFile(full));
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function createMigrationPlan(
  home: string,
  library: string,
  agents: AgentsRegistry,
): Promise<MigrationPlan> {
  const rootAliases: MigrationPlan["rootAliases"] = [];
  const candidates: MigrationCandidate[] = [];
  const diagnostics: string[] = [];

  for (const [agentName, agent] of Object.entries(agents.agent)) {
    const rootStat = await lstat(agent.skills_dir).catch(() => undefined);
    if (!rootStat) continue;
    if (rootStat.isSymbolicLink()) {
      rootAliases.push({ agent: agentName, path: agent.skills_dir, target: await readlink(agent.skills_dir), action: "review" });
      diagnostics.push(`${agentName} 的整个 skills_dir 是软链接，迁移前必须拆分`);
      continue;
    }
    const entries = await readdir(agent.skills_dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const sourcePath = path.join(agent.skills_dir, entry.name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const resolvedPath = entry.isSymbolicLink()
        ? path.resolve(path.dirname(sourcePath), await readlink(sourcePath))
        : sourcePath;
      if (isInside(library, resolvedPath)) continue;
      const skillFile = path.join(resolvedPath, "SKILL.md");
      if (!(await readFile(skillFile, "utf8").then(() => true).catch(() => false))) continue;
      candidates.push({
        id: `legacy:${agentName}/${entry.name}`,
        name: entry.name,
        agent: agentName,
        sourcePath,
        resolvedPath,
        proposedLibraryPath: path.join(library, "owned", entry.name),
        digest: await hashDirectory(resolvedPath),
        action: "review",
        agents: [],
      });
    }
  }

  return {
    version: 1,
    library,
    createdAt: new Date().toISOString(),
    rootAliases,
    candidates: candidates.sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
  };
}

interface MigrationJournal {
  version: 1;
  transactionId: string;
  previousRegistry: string;
  adopted: Array<{ destination: string; backups: Array<{ original: string; backup: string }> }>;
  rootAliases: Array<{ original: string; backup: string }>;
}

interface ManagedLinksState {
  version: number;
  links: Array<{ linkPath: string; targetPath: string }>;
}

export async function applyMigrationPlan(
  library: string,
  plan: MigrationPlan,
  agentsRegistry: AgentsRegistry,
): Promise<{ transactionId: string; adopted: number }> {
  if (path.resolve(plan.library) !== path.resolve(library)) throw new Error("迁移计划不属于当前 SkillLibrary");
  const selected = plan.candidates.filter((candidate) => candidate.action === "adopt");
  if (!selected.length) throw new Error("迁移计划中没有 action=adopt 的候选项");
  if (new Set(selected.map((candidate) => candidate.id)).size !== selected.length) {
    throw new Error("迁移计划包含重复候选项");
  }

  const currentPlan = await createMigrationPlan("", library, agentsRegistry);
  const currentCandidates = new Map(currentPlan.candidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of selected) {
    if (!candidate.agents.length) throw new Error(`${candidate.id} 尚未填写 Agent 白名单`);
    const current = currentCandidates.get(candidate.id);
    if (
      !current
      || current.name !== candidate.name
      || current.agent !== candidate.agent
      || current.sourcePath !== candidate.sourcePath
      || current.resolvedPath !== candidate.resolvedPath
      || current.proposedLibraryPath !== candidate.proposedLibraryPath
      || current.digest !== candidate.digest
    ) {
      throw new Error(`${candidate.id} 的来源、路径或内容已经变化，请重新生成迁移计划`);
    }
  }
  const currentAliases = new Map(currentPlan.rootAliases.map((alias) => [alias.agent, alias]));
  for (const alias of plan.rootAliases.filter((item) => item.action === "split")) {
    const current = currentAliases.get(alias.agent);
    if (!current || current.path !== alias.path || current.target !== alias.target) {
      throw new Error(`${alias.agent} 的整目录别名已经变化，请重新生成迁移计划`);
    }
  }

  const grouped = new Map<string, MigrationCandidate[]>();
  for (const candidate of selected) grouped.set(candidate.name, [...(grouped.get(candidate.name) ?? []), candidate]);
  for (const [name, group] of grouped) {
    if (new Set(group.map((item) => item.digest)).size > 1) throw new Error(`${name} 存在同名不同内容，不能自动迁移`);
  }

  const transactionId = `migration-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
  const previousRegistry = await readFile(path.join(library, "skills.toml"), "utf8");
  const registry: SkillsRegistry = await loadSkillsRegistry(library);
  const journal: MigrationJournal = { version: 1, transactionId, previousRegistry, adopted: [], rootAliases: [] };
  const backupRoot = path.join(library, ".skillmanager", "migration-backups", transactionId);

  try {
    for (const alias of plan.rootAliases.filter((item) => item.action === "split")) {
      const stat = await lstat(alias.path).catch(() => undefined);
      if (!stat?.isSymbolicLink()) throw new Error(`整目录别名已经变化：${alias.path}`);
      if (await readlink(alias.path) !== alias.target) throw new Error(`整目录别名目标已经变化：${alias.path}`);
      const backup = path.join(backupRoot, "root-aliases", alias.agent);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(alias.path, backup);
      await mkdir(alias.path, { recursive: true });
      journal.rootAliases.push({ original: alias.path, backup });
    }

    for (const [name, group] of grouped) {
      const destination = path.join(library, "owned", name);
      if (await lstat(destination).then(() => true).catch(() => false)) throw new Error(`目标已存在：${destination}`);
      await cp(group[0].resolvedPath, destination, { recursive: true, dereference: true, errorOnExist: true });
      const backups: Array<{ original: string; backup: string }> = [];
      for (const candidate of group) {
        const backup = path.join(backupRoot, candidate.agent, candidate.name);
        await mkdir(path.dirname(backup), { recursive: true });
        await rename(candidate.sourcePath, backup);
        backups.push({ original: candidate.sourcePath, backup });
      }
      journal.adopted.push({ destination, backups });
      registry.skill[name] = {
        from: "own",
        path: name,
        agents: [...new Set(group.flatMap((item) => item.agents))],
      };
    }

    await saveSkillsRegistry(library, registry);
    const syncPlan = await buildSyncPlan(library, registry, agentsRegistry);
    await applySyncPlan(syncPlan);
    await writeFile(
      path.join(library, ".skillmanager", "transactions", `${transactionId}.json`),
      `${JSON.stringify(journal, null, 2)}\n`,
    );
    return { transactionId, adopted: grouped.size };
  } catch (error) {
    await writeFile(path.join(library, "skills.toml"), previousRegistry, "utf8");
    for (const item of journal.adopted.reverse()) {
      for (const backup of item.backups.reverse()) {
        await rm(backup.original, { recursive: true, force: true });
        await rename(backup.backup, backup.original).catch(() => undefined);
      }
      await rm(item.destination, { recursive: true, force: true });
    }
    for (const alias of journal.rootAliases.reverse()) {
      await rm(alias.original, { recursive: true, force: true });
      await rename(alias.backup, alias.original).catch(() => undefined);
    }
    throw error;
  }
}

export async function rollbackMigration(library: string, transactionId: string): Promise<void> {
  if (!transactionId.startsWith("migration-")) throw new Error("只允许回滚 migration 事务");
  const journalPath = path.join(library, ".skillmanager", "transactions", `${transactionId}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal & { rolledBackAt?: string };
  if (journal.transactionId !== transactionId) throw new Error("迁移事务 ID 不匹配");
  if (journal.rolledBackAt) throw new Error(`迁移事务已经回滚：${journal.rolledBackAt}`);

  const managedStatePath = path.join(library, ".skillmanager", "managed-links.json");
  const managedState = await readFile(managedStatePath, "utf8")
    .then((content) => JSON.parse(content) as ManagedLinksState)
    .catch(() => undefined);
  const managedLinks = new Map((managedState?.links ?? []).map((link) => [link.linkPath, link.targetPath]));

  // Preflight every mutable path before restoring anything. This keeps a failed
  // rollback from becoming a partial rollback and protects content created after
  // a whole-directory alias was split.
  for (const item of journal.adopted) {
    if (!isInside(library, item.destination) || path.resolve(item.destination) === path.resolve(library)) {
      throw new Error("迁移日志包含 SkillLibrary 以外的目标路径");
    }
    for (const backup of item.backups) {
      const current = await lstat(backup.original).catch(() => undefined);
      if (current && !current.isSymbolicLink()) {
        throw new Error(`无法恢复，原位置已被真实文件占用：${backup.original}`);
      }
      if (!(await lstat(backup.backup).catch(() => undefined))) {
        throw new Error(`无法恢复，备份不存在：${backup.backup}`);
      }
    }
  }
  for (const alias of journal.rootAliases ?? []) {
    const current = await lstat(alias.original).catch(() => undefined);
    if (!current?.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`无法恢复整目录别名，路径已变化：${alias.original}`);
    }
    if (!(await lstat(alias.backup).catch(() => undefined))) {
      throw new Error(`无法恢复整目录别名，备份不存在：${alias.backup}`);
    }
    for (const entry of await readdir(alias.original)) {
      const entryPath = path.join(alias.original, entry);
      const expectedTarget = managedLinks.get(entryPath);
      const entryStat = await lstat(entryPath).catch(() => undefined);
      if (!expectedTarget || !entryStat?.isSymbolicLink()) {
        throw new Error(`无法恢复整目录别名，发现未受管内容：${entryPath}`);
      }
      const currentTarget = path.resolve(path.dirname(entryPath), await readlink(entryPath));
      if (currentTarget !== expectedTarget || !isInside(library, currentTarget)) {
        throw new Error(`无法恢复整目录别名，发现未受管内容：${entryPath}`);
      }
    }
  }

  for (const item of [...journal.adopted].reverse()) {
    for (const backup of [...item.backups].reverse()) {
      const current = await lstat(backup.original).catch(() => undefined);
      if (current?.isSymbolicLink()) await rm(backup.original, { force: true });
      else if (current) throw new Error(`无法恢复，原位置已被真实文件占用：${backup.original}`);
      await mkdir(path.dirname(backup.original), { recursive: true });
      await rename(backup.backup, backup.original);
    }
    await rm(item.destination, { recursive: true, force: true });
  }
  for (const alias of [...(journal.rootAliases ?? [])].reverse()) {
    await rm(alias.original, { recursive: true, force: true });
    await rename(alias.backup, alias.original);
  }
  await writeFile(path.join(library, "skills.toml"), journal.previousRegistry, "utf8");

  if (managedState) {
    const removedTargets = new Set(journal.adopted.map((item) => item.destination));
    managedState.links = managedState.links.filter((link) => !removedTargets.has(link.targetPath));
    await writeFile(managedStatePath, `${JSON.stringify(managedState, null, 2)}\n`, "utf8");
  }

  journal.rolledBackAt = new Date().toISOString();
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}
