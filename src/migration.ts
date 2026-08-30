import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentsRegistry } from "./model.ts";
import type { SkillsRegistry } from "./model.ts";
import { buildCodexOwnedInventory, buildExternalLinkInventory, type InventoryItem } from "./inventory.ts";
import { loadSkillsRegistry, resolveSkillSource, saveSkillsRegistry } from "./registry.ts";
import { applySyncPlan, buildSyncPlan } from "./sync.ts";
import { assertInside, assertMigrationTransactionId, atomicWriteFile, childPath, isInside } from "./safety.ts";

export interface MigrationCandidate {
  id: string;
  name: string;
  agent: string;
  sourcePath: string;
  resolvedPath: string;
  proposedLibraryPath: string;
  digest: string;
  brokenLink?: boolean;
  replacement?: Pick<InventoryItem, "id" | "ownership" | "path">;
  action: "review" | "adopt" | "relink" | "retire" | "prune" | "ignore";
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

export async function createMigrationPlan(
  home: string,
  library: string,
  agents: AgentsRegistry,
): Promise<MigrationPlan> {
  const rootAliases: MigrationPlan["rootAliases"] = [];
  const candidates: MigrationCandidate[] = [];
  const diagnostics: string[] = [];
  const registry = await loadSkillsRegistry(library);
  const externalLinks = new Set(
    (await buildExternalLinkInventory(home, registry, diagnostics)).map((item) => item.linkPath),
  );
  const replacements = new Map<string, InventoryItem>();
  for (const item of await buildCodexOwnedInventory(home, diagnostics)) {
    if (!replacements.has(item.name)) replacements.set(item.name, item);
  }

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
      if (externalLinks.has(sourcePath)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const resolvedPath = entry.isSymbolicLink()
        ? path.resolve(path.dirname(sourcePath), await readlink(sourcePath))
        : sourcePath;
      if (isInside(library, resolvedPath)) continue;
      const resolvedStat = await lstat(resolvedPath).catch(() => undefined);
      if (entry.isSymbolicLink() && !resolvedStat) {
        candidates.push({
          id: `legacy:${agentName}/${entry.name}`,
          name: entry.name,
          agent: agentName,
          sourcePath,
          resolvedPath,
          proposedLibraryPath: path.join(library, "owned", entry.name),
          digest: createHash("sha256").update(`broken-link:${resolvedPath}`).digest("hex"),
          brokenLink: true,
          action: "review",
          agents: [],
        });
        continue;
      }
      const skillFile = path.join(resolvedPath, "SKILL.md");
      if (!(await readFile(skillFile, "utf8").then(() => true).catch(() => false))) continue;
      const replacement = agentName === "codex" ? replacements.get(entry.name) : undefined;
      candidates.push({
        id: `legacy:${agentName}/${entry.name}`,
        name: entry.name,
        agent: agentName,
        sourcePath,
        resolvedPath,
        proposedLibraryPath: path.join(library, "owned", entry.name),
        digest: await hashDirectory(resolvedPath),
        replacement: replacement
          ? { id: replacement.id, ownership: replacement.ownership, path: replacement.path }
          : undefined,
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
  status?: "prepared" | "committed" | "rolled-back";
  previousRegistry: string;
  adopted: Array<{ destination: string; backups: Array<{ original: string; backup: string }> }>;
  relinked: Array<{ original: string; backup: string; target: string }>;
  retired: Array<{ original: string; backup: string; replacementPath: string }>;
  pruned: Array<{ original: string; backup: string; target: string }>;
  rootAliases: Array<{ original: string; backup: string }>;
}

interface ManagedLinksState {
  version: number;
  links: Array<{ linkPath: string; targetPath: string }>;
}

function validateMigrationJournal(
  library: string,
  transactionId: string,
  journal: MigrationJournal,
  agents: AgentsRegistry,
): void {
  if (
    journal.version !== 1
    || journal.transactionId !== transactionId
    || typeof journal.previousRegistry !== "string"
    || !Array.isArray(journal.adopted)
    || !Array.isArray(journal.relinked)
    || !Array.isArray(journal.retired)
    || !Array.isArray(journal.pruned)
    || !Array.isArray(journal.rootAliases)
  ) {
    throw new Error("迁移事务日志格式无效");
  }
  const backupRoot = path.join(library, ".skillmanager", "migration-backups", transactionId);
  const ownedRoot = path.join(library, "owned");
  const assertAgentEntry = (candidate: string): void => {
    const valid = Object.values(agents.agent).some((agent) => {
      const relative = path.relative(path.resolve(agent.skills_dir), path.resolve(candidate));
      return relative !== "" && !relative.includes(path.sep) && relative !== "." && relative !== "..";
    });
    if (!valid) throw new Error(`迁移日志包含 Agent Skill 目录以外的入口：${candidate}`);
  };
  const assertBackup = (candidate: string): void => assertInside(backupRoot, candidate, "迁移备份");

  for (const item of journal.adopted) {
    assertInside(ownedRoot, item.destination, "迁移目标");
    if (!Array.isArray(item.backups)) throw new Error("迁移事务日志格式无效");
    for (const backup of item.backups) {
      assertAgentEntry(backup.original);
      assertBackup(backup.backup);
    }
  }
  for (const item of journal.relinked) {
    assertAgentEntry(item.original);
    assertBackup(item.backup);
    assertInside(library, item.target, "relink 目标");
  }
  for (const item of [...journal.retired, ...journal.pruned]) {
    assertAgentEntry(item.original);
    assertBackup(item.backup);
  }
  for (const alias of journal.rootAliases) {
    if (!Object.values(agents.agent).some((agent) => path.resolve(agent.skills_dir) === path.resolve(alias.original))) {
      throw new Error(`迁移日志包含未登记的 Agent Skill 根目录：${alias.original}`);
    }
    assertBackup(alias.backup);
  }
}

export async function applyMigrationPlan(
  home: string,
  library: string,
  plan: MigrationPlan,
  agentsRegistry: AgentsRegistry,
): Promise<{ transactionId: string; adopted: number; relinked: number; retired: number; pruned: number }> {
  if (path.resolve(plan.library) !== path.resolve(library)) throw new Error("迁移计划不属于当前 SkillLibrary");
  const selected = plan.candidates.filter((candidate) => ["adopt", "relink", "retire", "prune"].includes(candidate.action));
  const adopted = selected.filter((candidate) => candidate.action === "adopt");
  const relinked = selected.filter((candidate) => candidate.action === "relink");
  const retired = selected.filter((candidate) => candidate.action === "retire");
  const pruned = selected.filter((candidate) => candidate.action === "prune");
  const aliasesToSplit = plan.rootAliases.filter((item) => item.action === "split");
  if (!selected.length && !aliasesToSplit.length) {
    throw new Error("迁移计划中没有可执行的候选项或 action=split 的整目录别名");
  }
  if (new Set(selected.map((candidate) => candidate.id)).size !== selected.length) {
    throw new Error("迁移计划包含重复候选项");
  }

  const currentPlan = await createMigrationPlan(home, library, agentsRegistry);
  const currentCandidates = new Map(currentPlan.candidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of selected) {
    if (!["retire", "prune"].includes(candidate.action) && !candidate.agents.length) {
      throw new Error(`${candidate.id} 尚未填写 Agent 白名单`);
    }
    const current = currentCandidates.get(candidate.id);
    if (
      !current
      || current.name !== candidate.name
      || current.agent !== candidate.agent
      || current.sourcePath !== candidate.sourcePath
      || current.resolvedPath !== candidate.resolvedPath
      || current.proposedLibraryPath !== candidate.proposedLibraryPath
      || current.digest !== candidate.digest
      || current.brokenLink !== candidate.brokenLink
      || current.replacement?.id !== candidate.replacement?.id
      || current.replacement?.path !== candidate.replacement?.path
    ) {
      throw new Error(`${candidate.id} 的来源、路径或内容已经变化，请重新生成迁移计划`);
    }
  }
  const currentAliases = new Map(currentPlan.rootAliases.map((alias) => [alias.agent, alias]));
  for (const alias of aliasesToSplit) {
    const current = currentAliases.get(alias.agent);
    if (!current || current.path !== alias.path || current.target !== alias.target) {
      throw new Error(`${alias.agent} 的整目录别名已经变化，请重新生成迁移计划`);
    }
  }

  const grouped = new Map<string, MigrationCandidate[]>();
  for (const candidate of adopted) grouped.set(candidate.name, [...(grouped.get(candidate.name) ?? []), candidate]);
  for (const [name, group] of grouped) {
    if (new Set(group.map((item) => item.digest)).size > 1) throw new Error(`${name} 存在同名不同内容，不能自动迁移`);
  }

  const transactionId = `migration-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
  const previousRegistry = await readFile(path.join(library, "skills.toml"), "utf8");
  const registry: SkillsRegistry = await loadSkillsRegistry(library);
  for (const candidate of relinked) {
    if (!registry.skill[candidate.name]) throw new Error(`${candidate.name} 尚未登记在 SkillLibrary，不能 relink`);
  }
  for (const candidate of retired) {
    if (!candidate.replacement || !["plugin-owned", "system-owned"].includes(candidate.replacement.ownership)) {
      throw new Error(`${candidate.name} 没有可验证的 Codex System/Plugin 替代项，不能 retire`);
    }
  }
  for (const candidate of pruned) {
    if (!candidate.brokenLink) throw new Error(`${candidate.name} 不是断开的软链接，不能 prune`);
  }
  const journal: MigrationJournal = {
    version: 1,
    transactionId,
    status: "prepared",
    previousRegistry,
    adopted: [],
    relinked: [],
    retired: [],
    pruned: [],
    rootAliases: [],
  };
  const backupRoot = path.join(library, ".skillmanager", "migration-backups", transactionId);
  const journalPath = path.join(library, ".skillmanager", "transactions", `${transactionId}.json`);
  const libraryDevice = (await stat(library)).dev;
  for (const mutablePath of [
    ...selected.map((candidate) => candidate.sourcePath),
    ...aliasesToSplit.map((alias) => alias.path),
  ]) {
    if ((await lstat(mutablePath)).dev !== libraryDevice) {
      throw new Error(`迁移源与 SkillLibrary 位于不同文件系统，无法保证原子迁移：${mutablePath}`);
    }
  }
  await atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const persistJournal = async (): Promise<void> => {
    await atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  };

  try {
    for (const alias of aliasesToSplit) {
      const stat = await lstat(alias.path).catch(() => undefined);
      if (!stat?.isSymbolicLink()) throw new Error(`整目录别名已经变化：${alias.path}`);
      if (await readlink(alias.path) !== alias.target) throw new Error(`整目录别名目标已经变化：${alias.path}`);
      const backup = path.join(backupRoot, "root-aliases", alias.agent);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(alias.path, backup);
      await mkdir(alias.path, { recursive: true });
      journal.rootAliases.push({ original: alias.path, backup });
      await persistJournal();
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
      await persistJournal();
      registry.skill[name] = {
        from: "own",
        path: name,
        agents: [...new Set(group.flatMap((item) => item.agents))],
      };
    }

    for (const candidate of relinked) {
      const backup = path.join(backupRoot, candidate.agent, candidate.name);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(candidate.sourcePath, backup);
      journal.relinked.push({
        original: candidate.sourcePath,
        backup,
        target: resolveSkillSource(library, registry, candidate.name),
      });
      await persistJournal();
      registry.skill[candidate.name].agents = [...new Set(candidate.agents)];
    }

    for (const candidate of retired) {
      const backup = path.join(backupRoot, candidate.agent, candidate.name);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(candidate.sourcePath, backup);
      journal.retired.push({
        original: candidate.sourcePath,
        backup,
        replacementPath: candidate.replacement!.path,
      });
      await persistJournal();
    }

    for (const candidate of pruned) {
      const backup = path.join(backupRoot, candidate.agent, candidate.name);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(candidate.sourcePath, backup);
      journal.pruned.push({ original: candidate.sourcePath, backup, target: candidate.resolvedPath });
      await persistJournal();
    }

    await saveSkillsRegistry(library, registry);
    const syncPlan = await buildSyncPlan(library, registry, agentsRegistry);
    await applySyncPlan(syncPlan);
    journal.status = "committed";
    await persistJournal();
    return {
      transactionId,
      adopted: grouped.size,
      relinked: journal.relinked.length,
      retired: journal.retired.length,
      pruned: journal.pruned.length,
    };
  } catch (error) {
    await atomicWriteFile(path.join(library, "skills.toml"), previousRegistry);
    for (const item of journal.relinked.reverse()) {
      await rm(item.original, { recursive: true, force: true });
      await rename(item.backup, item.original).catch(() => undefined);
    }
    for (const item of journal.retired.reverse()) {
      await rm(item.original, { recursive: true, force: true });
      await rename(item.backup, item.original).catch(() => undefined);
    }
    for (const item of journal.pruned.reverse()) {
      await rm(item.original, { recursive: true, force: true });
      await rename(item.backup, item.original).catch(() => undefined);
    }
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
    journal.status = "rolled-back";
    await persistJournal().catch(() => undefined);
    throw error;
  }
}

export async function rollbackMigration(
  library: string,
  transactionId: string,
  agents: AgentsRegistry,
): Promise<void> {
  assertMigrationTransactionId(transactionId);
  const journalPath = path.join(library, ".skillmanager", "transactions", `${transactionId}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal & {
    rolledBackAt?: string;
    finalizedAt?: string;
  };
  validateMigrationJournal(library, transactionId, journal, agents);
  if (journal.rolledBackAt) throw new Error(`迁移事务已经回滚：${journal.rolledBackAt}`);
  if (journal.finalizedAt) throw new Error(`迁移事务已经结束：${journal.finalizedAt}`);
  journal.relinked ??= [];
  journal.retired ??= [];
  journal.pruned ??= [];

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
  for (const item of [...journal.relinked, ...journal.retired, ...journal.pruned]) {
    const current = await lstat(item.original).catch(() => undefined);
    if (current && !current.isSymbolicLink()) {
      throw new Error(`无法恢复，原位置已被真实文件占用：${item.original}`);
    }
    if (!(await lstat(item.backup).catch(() => undefined))) {
      throw new Error(`无法恢复，备份不存在：${item.backup}`);
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
  for (const item of [...journal.relinked, ...journal.retired, ...journal.pruned].reverse()) {
    const current = await lstat(item.original).catch(() => undefined);
    if (current?.isSymbolicLink()) await rm(item.original, { force: true });
    else if (current) throw new Error(`无法恢复，原位置已被真实文件占用：${item.original}`);
    await mkdir(path.dirname(item.original), { recursive: true });
    await rename(item.backup, item.original);
  }
  for (const alias of [...(journal.rootAliases ?? [])].reverse()) {
    await rm(alias.original, { recursive: true, force: true });
    await rename(alias.backup, alias.original);
  }
  await atomicWriteFile(path.join(library, "skills.toml"), journal.previousRegistry);

  if (managedState) {
    const removedTargets = new Set(journal.adopted.map((item) => item.destination));
    const restoredPaths = new Set([...journal.relinked, ...journal.retired, ...journal.pruned].map((item) => item.original));
    managedState.links = managedState.links.filter(
      (link) => !removedTargets.has(link.targetPath) && !restoredPaths.has(link.linkPath),
    );
    await atomicWriteFile(managedStatePath, `${JSON.stringify(managedState, null, 2)}\n`);
  }

  journal.rolledBackAt = new Date().toISOString();
  journal.status = "rolled-back";
  await atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

export async function finalizeMigration(
  library: string,
  transactionId: string,
  agents: AgentsRegistry,
): Promise<void> {
  assertMigrationTransactionId(transactionId);
  const journalPath = path.join(library, ".skillmanager", "transactions", `${transactionId}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal & {
    rolledBackAt?: string;
    finalizedAt?: string;
  };
  validateMigrationJournal(library, transactionId, journal, agents);
  if (journal.status === "prepared") throw new Error("迁移事务尚未完成，请先回滚而不是结束迁移");
  if (journal.rolledBackAt) throw new Error(`迁移事务已经回滚：${journal.rolledBackAt}`);
  if (journal.finalizedAt) throw new Error(`迁移事务已经结束：${journal.finalizedAt}`);
  journal.relinked ??= [];
  journal.retired ??= [];
  journal.pruned ??= [];

  for (const item of journal.adopted) {
    if (!isInside(library, item.destination) || path.resolve(item.destination) === path.resolve(library)) {
      throw new Error("迁移日志包含 SkillLibrary 以外的目标路径");
    }
    const skillFile = await lstat(path.join(item.destination, "SKILL.md")).catch(() => undefined);
    if (!skillFile?.isFile()) throw new Error(`不能结束迁移，目标 Skill 已失效：${item.destination}`);
    for (const backup of item.backups) {
      const current = await lstat(backup.original).catch(() => undefined);
      if (!current?.isSymbolicLink()) throw new Error(`不能结束迁移，入口不再是软链接：${backup.original}`);
      const target = path.resolve(path.dirname(backup.original), await readlink(backup.original));
      if (target !== path.resolve(item.destination)) throw new Error(`不能结束迁移，入口目标已经变化：${backup.original}`);
    }
  }
  for (const item of journal.relinked) {
    const current = await lstat(item.original).catch(() => undefined);
    if (!current?.isSymbolicLink()) throw new Error(`不能结束迁移，入口不再是软链接：${item.original}`);
    const target = path.resolve(path.dirname(item.original), await readlink(item.original));
    if (target !== path.resolve(item.target)) throw new Error(`不能结束迁移，入口目标已经变化：${item.original}`);
  }
  for (const item of journal.retired) {
    if (await lstat(item.original).then(() => true).catch(() => false)) {
      throw new Error(`不能结束迁移，已退役入口再次出现：${item.original}`);
    }
    const replacement = await lstat(path.join(item.replacementPath, "SKILL.md")).catch(() => undefined);
    if (!replacement?.isFile()) throw new Error(`不能结束迁移，Codex 替代项已失效：${item.replacementPath}`);
  }
  for (const item of journal.pruned) {
    if (await lstat(item.original).then(() => true).catch(() => false)) {
      throw new Error(`不能结束迁移，已清理断链再次出现：${item.original}`);
    }
  }
  for (const alias of journal.rootAliases) {
    const current = await lstat(alias.original).catch(() => undefined);
    if (!current?.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`不能结束迁移，Agent Skill 目录已变化：${alias.original}`);
    }
  }
  const backups = [
    ...journal.adopted.flatMap((item) => item.backups.map((backup) => backup.backup)),
    ...journal.relinked.map((item) => item.backup),
    ...journal.retired.map((item) => item.backup),
    ...journal.pruned.map((item) => item.backup),
    ...journal.rootAliases.map((item) => item.backup),
  ];
  for (const backup of backups) {
    if (!(await lstat(backup).catch(() => undefined))) throw new Error(`不能结束迁移，备份不存在：${backup}`);
  }

  const backupRoot = path.join(library, ".skillmanager", "migration-backups", transactionId);
  if (!isInside(library, backupRoot) || path.resolve(backupRoot) === path.resolve(library)) {
    throw new Error("迁移备份路径无效");
  }
  await rm(backupRoot, { recursive: true, force: true });
  journal.finalizedAt = new Date().toISOString();
  await atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}
