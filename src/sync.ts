import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentsRegistry, PlanAction, SkillsRegistry, SyncPlan } from "./model.ts";
import { assertSkillDirectory, resolveSkillSource } from "./registry.ts";

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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readManagedState(library: string): Promise<ManagedState> {
  try {
    return JSON.parse(await readFile(path.join(library, ".skillmanager", "managed-links.json"), "utf8"));
  } catch {
    return EMPTY_STATE;
  }
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
  const state = await readManagedState(library);
  const managedByPath = new Map(state.links.map((link) => [link.linkPath, link]));

  for (const [skillName, skill] of Object.entries(registry.skill)) {
    const source = registry.source[skill.from];
    if (!source) throw new Error(`skill.${skillName} 引用了不存在的 source.${skill.from}`);
    const targetNames = skill.agents ?? source.default_agents;
    if (!targetNames?.length) throw new Error(`skill.${skillName} 没有 Agent 白名单`);
    const wildcard = targetNames.includes("*");
    const expandedTargets = wildcard
      ? Object.keys(agents.agent).filter((name) => agents.agent[name].approved)
      : [...new Set(targetNames)];
    const targetPath = resolveSkillSource(library, registry, skillName);
    await assertSkillDirectory(skillName, targetPath);

    for (const agentName of expandedTargets) {
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
          linkPath: path.join(agent.skills_dir, skillName),
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
          linkPath: path.join(agent.skills_dir, skillName),
          targetPath,
          reason: "Agent 的整个 skills_dir 是软链接，无法保证白名单隔离",
        });
        continue;
      }
      const linkPath = path.join(agent.skills_dir, skillName);
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

  const transactionId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const applied: PlanAction[] = [];
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
        await unlink(action.linkPath);
        applied.push(action);
      }
    }
  } catch (error) {
    for (const action of applied.reverse()) {
      if (action.action === "create") await unlink(action.linkPath).catch(() => undefined);
      if (action.action === "retarget" && action.previousTargetPath) {
        await unlink(action.linkPath).catch(() => undefined);
        await symlink(action.previousTargetPath, action.linkPath, "dir").catch(() => undefined);
      }
      if (action.action === "remove") await symlink(action.targetPath, action.linkPath, "dir").catch(() => undefined);
    }
    throw error;
  }

  const links: ManagedLink[] = plan.actions
    .filter((item) => item.action === "create" || item.action === "keep" || item.action === "retarget")
    .map(({ agent, skill, linkPath, targetPath }) => ({ agent, skill, linkPath, targetPath }));
  const state: ManagedState = { version: 1, links };
  await mkdir(path.join(plan.library, ".skillmanager", "transactions"), { recursive: true });
  await writeFile(
    path.join(plan.library, ".skillmanager", "managed-links.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  await writeFile(
    path.join(plan.library, ".skillmanager", "transactions", `${transactionId}.json`),
    `${JSON.stringify({ version: 1, transactionId, actions: applied }, null, 2)}\n`,
  );

  return {
    transactionId,
    created: plan.actions.filter((item) => item.action === "create").length,
    retargeted: plan.actions.filter((item) => item.action === "retarget").length,
    removed: plan.actions.filter((item) => item.action === "remove").length,
    kept: plan.actions.filter((item) => item.action === "keep").length,
  };
}
