import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, readdir, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";

import type { AgentsRegistry, PlanAction, SkillsRegistry, SyncPlan } from "./model.ts";
import { assertSkillDirectory, resolveSkillSource } from "./registry.ts";
import { assertInside, assertSafeSegment, atomicWriteFile, childPath, isInside } from "./safety.ts";

interface ManagedLink {
  agent: string;
  skill: string;
  linkPath: string;
  targetPath: string;
}

interface ManagedState {
  version: 1;
  links: ManagedLink[];
}

const EMPTY_STATE: ManagedState = { version: 1, links: [] };
const SYNC_TRANSACTION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/i;

interface SyncJournal {
  version: 1;
  transactionId: string;
  status: "prepared" | "committed" | "rolled-back";
  previousState?: string;
  actions: PlanAction[];
}

function parseManagedState(raw: string, statePath: string, agents: AgentsRegistry): ManagedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`受管状态文件损坏：${statePath}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as ManagedState).version !== 1 || !Array.isArray((parsed as ManagedState).links)) {
    throw new Error(`受管状态格式无效：${statePath}`);
  }
  const state = parsed as ManagedState;
  for (const link of state.links) {
    if (!link || typeof link !== "object") throw new Error(`受管状态格式无效：${statePath}`);
    if (![link.agent, link.skill, link.linkPath, link.targetPath].every((item) => typeof item === "string")) {
      throw new Error(`受管状态格式无效：${statePath}`);
    }
    assertSafeSegment(link.agent, "受管链接 Agent");
    assertSafeSegment(link.skill, "受管链接 Skill");
    const agent = agents.agent[link.agent];
    if (!agent || path.resolve(link.linkPath) !== childPath(agent.skills_dir, link.skill, "受管链接")) {
      throw new Error(`受管链接不在已登记的 Agent Skill 目录：${link.linkPath}`);
    }
  }
  return state;
}

async function currentLinkTarget(linkPath: string): Promise<string | undefined> {
  const stat = await lstat(linkPath).catch(() => undefined);
  return stat?.isSymbolicLink()
    ? path.resolve(path.dirname(linkPath), await readlink(linkPath))
    : undefined;
}

export async function recoverIncompleteSyncTransactions(
  library: string,
  agents: AgentsRegistry,
): Promise<string[]> {
  const transactionsRoot = path.join(library, ".skillmanager", "transactions");
  const recovered: string[] = [];
  for (const entry of await readdir(transactionsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const transactionPath = path.join(transactionsRoot, entry.name);
    const journal = JSON.parse(await readFile(transactionPath, "utf8")) as SyncJournal;
    if (journal.status !== "prepared" || !SYNC_TRANSACTION_ID.test(journal.transactionId)) continue;
    if (entry.name !== `${journal.transactionId}.json` || !Array.isArray(journal.actions)) {
      throw new Error(`同步事务日志格式无效：${entry.name}`);
    }
    if (journal.previousState !== undefined) {
      parseManagedState(journal.previousState, `事务 ${journal.transactionId} 的旧受管状态`, agents);
    }
    for (const action of journal.actions) {
      if (!["create", "keep", "retarget", "remove"].includes(action.action)) {
        throw new Error(`同步事务包含无效动作：${String(action.action)}`);
      }
      assertSafeSegment(action.agent, "Agent");
      assertSafeSegment(action.skill, "Skill");
      const agent = agents.agent[action.agent];
      if (!agent || path.resolve(action.linkPath) !== childPath(agent.skills_dir, action.skill, "同步事务入口")) {
        throw new Error(`同步事务包含 Agent Skill 目录以外的入口：${action.linkPath}`);
      }
      assertInside(library, action.targetPath, "同步事务 Skill 来源");
      const current = await lstat(action.linkPath).catch(() => undefined);
      const target = current?.isSymbolicLink() ? await currentLinkTarget(action.linkPath) : undefined;
      if (current && !current.isSymbolicLink()) throw new Error(`无法恢复同步事务，入口已成为真实文件：${action.linkPath}`);
      if (action.action === "create" && target !== undefined && target !== path.resolve(action.targetPath)) {
        throw new Error(`无法恢复同步事务，入口目标已经变化：${action.linkPath}`);
      }
      if (action.action === "retarget") {
        if (!action.previousTargetPath) throw new Error(`同步事务缺少原目标：${action.linkPath}`);
        assertInside(library, action.previousTargetPath, "同步事务原 Skill 来源");
        if (target !== path.resolve(action.targetPath) && target !== path.resolve(action.previousTargetPath)) {
          throw new Error(`无法恢复同步事务，入口目标已经变化：${action.linkPath}`);
        }
      }
      if (action.action === "keep" && target !== path.resolve(action.targetPath)) {
        throw new Error(`无法恢复同步事务，保留入口已经变化：${action.linkPath}`);
      }
      if (action.action === "remove" && target !== undefined && target !== path.resolve(action.targetPath)) {
        throw new Error(`无法恢复同步事务，入口目标已经变化：${action.linkPath}`);
      }
    }

    for (const action of [...journal.actions].reverse()) {
      const target = await currentLinkTarget(action.linkPath);
      if (action.action === "create" && target === path.resolve(action.targetPath)) {
        await unlink(action.linkPath);
      } else if (action.action === "retarget" && target === path.resolve(action.targetPath)) {
        await unlink(action.linkPath);
        await symlink(action.previousTargetPath!, action.linkPath, "dir");
      } else if (action.action === "remove" && target === undefined) {
        await mkdir(path.dirname(action.linkPath), { recursive: true });
        await symlink(action.targetPath, action.linkPath, "dir");
      }
    }
    const statePath = path.join(library, ".skillmanager", "managed-links.json");
    if (journal.previousState === undefined) await rm(statePath, { force: true });
    else await atomicWriteFile(statePath, journal.previousState);
    journal.status = "rolled-back";
    await atomicWriteFile(transactionPath, `${JSON.stringify(journal, null, 2)}\n`);
    recovered.push(journal.transactionId);
  }
  return recovered;
}

async function readManagedState(library: string, agents: AgentsRegistry): Promise<ManagedState> {
  const statePath = path.join(library, ".skillmanager", "managed-links.json");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw error;
  }
  return parseManagedState(raw, statePath, agents);
}

export async function validateManagedState(library: string, agents: AgentsRegistry): Promise<void> {
  await readManagedState(library, agents);
}

async function inspectDesiredLink(
  agent: string,
  skill: string,
  linkPath: string,
  targetPath: string,
  library: string,
  managed?: ManagedLink,
): Promise<PlanAction> {
  const stat = await lstat(linkPath).catch(() => undefined);
  if (!stat) return { action: "create", agent, skill, linkPath, targetPath };
  if (!stat.isSymbolicLink()) {
    return { action: "conflict", agent, skill, linkPath, targetPath, reason: "目标已存在且不是软链接" };
  }
  const existing = path.resolve(path.dirname(linkPath), await readlink(linkPath));
  if (existing === targetPath) return { action: "keep", agent, skill, linkPath, targetPath };
  if (
    managed
    && managed.agent === agent
    && managed.skill === skill
    && path.resolve(managed.targetPath) === existing
    && isInside(library, existing)
  ) {
    return {
      action: "retarget",
      agent,
      skill,
      linkPath,
      targetPath,
      previousTargetPath: existing,
    };
  }
  return { action: "conflict", agent, skill, linkPath, targetPath, reason: `目标指向其他位置：${existing}` };
}

export async function buildSyncPlan(
  library: string,
  registry: SkillsRegistry,
  agents: AgentsRegistry,
): Promise<SyncPlan> {
  const actions: PlanAction[] = [];
  const diagnostics: string[] = [];
  const desired = new Set<string>();
  const state = await readManagedState(library, agents);
  const managedByPath = new Map(state.links.map((link) => [link.linkPath, link]));

  for (const [skillName, skill] of Object.entries(registry.skill)) {
    assertSafeSegment(skillName, "Skill");
    const source = registry.source[skill.from];
    if (!source) throw new Error(`skill.${skillName} 引用了不存在的 source.${skill.from}`);
    const targetNames = skill.agents ?? source.default_agents;
    if (!targetNames?.length) throw new Error(`skill.${skillName} 没有 Agent 白名单`);
    const wildcard = targetNames.includes("*");
    const expandedTargets = wildcard
      ? Object.keys(agents.agent).filter((name) => agents.agent[name].approved)
      : [...new Set(targetNames)];
    const targetPath = resolveSkillSource(library, registry, skillName);
    await assertSkillDirectory(skillName, targetPath, library);

    for (const agentName of expandedTargets) {
      assertSafeSegment(agentName, "Agent");
      const agent = agents.agent[agentName];
      if (!agent) throw new Error(`skill.${skillName} 指向未知 Agent：${agentName}`);
      if (!agent.approved) throw new Error(`Agent ${agentName} 尚未批准`);
      const missing = (skill.requires ?? []).filter(
        (capability) => !(agent.capabilities ?? []).includes(capability),
      );
      if (missing.length) {
        if (wildcard) {
          diagnostics.push(`${agentName} 未获得 ${skillName}：缺少能力 ${missing.join(", ")}`);
          continue;
        }
        actions.push({
          action: "conflict",
          agent: agentName,
          skill: skillName,
          linkPath: childPath(agent.skills_dir, skillName, "Skill 入口"),
          targetPath,
          reason: `缺少能力：${missing.join(", ")}`,
        });
        continue;
      }
      const rootStat = await lstat(agent.skills_dir).catch(() => undefined);
      if (rootStat?.isSymbolicLink()) {
        actions.push({
          action: "conflict",
          agent: agentName,
          skill: skillName,
          linkPath: childPath(agent.skills_dir, skillName, "Skill 入口"),
          targetPath,
          reason: "Agent 的整个 skills_dir 是软链接，无法保证白名单隔离",
        });
        continue;
      }
      const linkPath = childPath(agent.skills_dir, skillName, "Skill 入口");
      desired.add(linkPath);
      actions.push(await inspectDesiredLink(
        agentName,
        skillName,
        linkPath,
        targetPath,
        library,
        managedByPath.get(linkPath),
      ));
    }
  }

  for (const managed of state.links) {
    if (desired.has(managed.linkPath)) continue;
    const stat = await lstat(managed.linkPath).catch(() => undefined);
    if (!stat) continue;
    if (!stat.isSymbolicLink()) {
      actions.push({ ...managed, action: "conflict", reason: "原受管链接已被真实文件替换" });
      continue;
    }
    const current = path.resolve(path.dirname(managed.linkPath), await readlink(managed.linkPath));
    actions.push(current === managed.targetPath
      ? { ...managed, action: "remove" }
      : { ...managed, action: "conflict", reason: "原受管链接已被改指向其他位置" });
  }

  return { library, actions, diagnostics };
}

export async function applySyncPlan(plan: SyncPlan): Promise<{
  transactionId: string;
  created: number;
  retargeted: number;
  removed: number;
  kept: number;
}> {
  const conflicts = plan.actions.filter((item) => item.action === "conflict");
  if (conflicts.length) throw new Error(`同步计划包含 ${conflicts.length} 个冲突，未执行`);
  for (const action of plan.actions) {
    assertSafeSegment(action.agent, "Agent");
    assertSafeSegment(action.skill, "Skill");
    if (path.basename(action.linkPath) !== action.skill) throw new Error(`同步计划包含无效入口：${action.linkPath}`);
    assertInside(plan.library, action.targetPath, "Skill 来源");
  }

  const transactionId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
  const applied: PlanAction[] = [];
  const statePath = path.join(plan.library, ".skillmanager", "managed-links.json");
  const transactionPath = path.join(plan.library, ".skillmanager", "transactions", `${transactionId}.json`);
  const previousState = await readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(path.dirname(transactionPath), { recursive: true });
  await atomicWriteFile(
    transactionPath,
    `${JSON.stringify({ version: 1, transactionId, status: "prepared", previousState, actions: plan.actions }, null, 2)}\n`,
  );
  try {
    for (const action of plan.actions) {
      if (action.action === "create") {
        await mkdir(path.dirname(action.linkPath), { recursive: true });
        await symlink(action.targetPath, action.linkPath, "dir");
        applied.push(action);
      } else if (action.action === "retarget") {
        if (!action.previousTargetPath) throw new Error(`retarget 缺少原目标：${action.linkPath}`);
        const stat = await lstat(action.linkPath).catch(() => undefined);
        const current = stat?.isSymbolicLink()
          ? path.resolve(path.dirname(action.linkPath), await readlink(action.linkPath))
          : undefined;
        if (current !== path.resolve(action.previousTargetPath)) {
          throw new Error(`受管链接已变化，未改指向：${action.linkPath}`);
        }
        await unlink(action.linkPath);
        try {
          await symlink(action.targetPath, action.linkPath, "dir");
        } catch (error) {
          await symlink(action.previousTargetPath, action.linkPath, "dir").catch(() => undefined);
          throw error;
        }
        applied.push(action);
      } else if (action.action === "remove") {
        const stat = await lstat(action.linkPath).catch(() => undefined);
        const current = stat?.isSymbolicLink()
          ? path.resolve(path.dirname(action.linkPath), await readlink(action.linkPath))
          : undefined;
        if (current !== path.resolve(action.targetPath)) {
          throw new Error(`受管链接已变化，未删除：${action.linkPath}`);
        }
        await unlink(action.linkPath);
        applied.push(action);
      }
    }
    const links: ManagedLink[] = plan.actions
      .filter((item) => item.action === "create" || item.action === "keep" || item.action === "retarget")
      .map(({ agent, skill, linkPath, targetPath }) => ({ agent, skill, linkPath, targetPath }));
    const state: ManagedState = { version: 1, links };
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await atomicWriteFile(
      transactionPath,
      `${JSON.stringify({ version: 1, transactionId, status: "committed", actions: applied }, null, 2)}\n`,
    );
  } catch (error) {
    for (const action of applied.reverse()) {
      if (action.action === "create") await unlink(action.linkPath).catch(() => undefined);
      if (action.action === "retarget" && action.previousTargetPath) {
        await unlink(action.linkPath).catch(() => undefined);
        await symlink(action.previousTargetPath, action.linkPath, "dir").catch(() => undefined);
      }
      if (action.action === "remove") await symlink(action.targetPath, action.linkPath, "dir").catch(() => undefined);
    }
    if (previousState === undefined) await rm(statePath, { force: true }).catch(() => undefined);
    else await atomicWriteFile(statePath, previousState).catch(() => undefined);
    await atomicWriteFile(
      transactionPath,
      `${JSON.stringify({ version: 1, transactionId, status: "rolled-back", actions: applied }, null, 2)}\n`,
    ).catch(() => undefined);
    throw error;
  }

  return {
    transactionId,
    created: plan.actions.filter((item) => item.action === "create").length,
    retargeted: plan.actions.filter((item) => item.action === "retarget").length,
    removed: plan.actions.filter((item) => item.action === "remove").length,
    kept: plan.actions.filter((item) => item.action === "keep").length,
  };
}
