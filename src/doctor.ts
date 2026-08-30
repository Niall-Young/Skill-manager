import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import type { AgentsRegistry, SkillsRegistry } from "./model.ts";
import { resolveSkillSource } from "./registry.ts";
import { validateManagedState } from "./sync.ts";

export interface DoctorIssue {
  level: "warning" | "error";
  code: string;
  message: string;
}

export async function runDoctor(
  library: string,
  registry: SkillsRegistry,
  agents: AgentsRegistry,
): Promise<{ status: "ok" | "warning" | "error"; issues: DoctorIssue[] }> {
  const issues: DoctorIssue[] = [];
  try {
    await validateManagedState(library, agents);
  } catch (error) {
    issues.push({
      level: "error",
      code: "invalid-managed-state",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const transactionsRoot = path.join(library, ".skillmanager", "transactions");
  for (const entry of await readdir(transactionsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const transactionPath = path.join(transactionsRoot, entry.name);
    try {
      const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as { status?: string; transactionId?: string };
      if (transaction.status === "prepared") {
        issues.push({
          level: "error",
          code: "incomplete-transaction",
          message: `发现未完成事务：${transaction.transactionId ?? entry.name}`,
        });
      }
    } catch {
      issues.push({ level: "error", code: "invalid-transaction", message: `事务日志损坏：${entry.name}` });
    }
  }
  for (const [name, skill] of Object.entries(registry.skill)) {
    const source = resolveSkillSource(library, registry, name);
    const skillFile = await lstat(path.join(source, "SKILL.md")).catch(() => undefined);
    if (!skillFile?.isFile()) {
      issues.push({ level: "error", code: "missing-skill", message: `${name} 缺少 SKILL.md` });
    }
    if (!skill.agents?.length && !registry.source[skill.from]?.default_agents?.length) {
      issues.push({ level: "error", code: "missing-targets", message: `${name} 没有 Agent 白名单` });
    }
  }
  for (const external of Object.values(registry.external)) {
    const relativeToLibrary = path.relative(path.resolve(library), path.resolve(external.path));
    if (relativeToLibrary === "" || (!relativeToLibrary.startsWith("..") && !path.isAbsolute(relativeToLibrary))) {
      issues.push({
        level: "error",
        code: "external-source-library",
        message: `${external.agent}/${external.name} 已经位于 SkillLibrary，不应登记为外部 Skill`,
      });
      continue;
    }
    const stat = await lstat(external.link_path).catch(() => undefined);
    if (!stat?.isSymbolicLink()) {
      issues.push({
        level: "error",
        code: "external-link-invalid",
        message: `${external.agent}/${external.name} 的外部入口不再是软链接`,
      });
      continue;
    }
    const current = path.resolve(path.dirname(external.link_path), await readlink(external.link_path));
    if (current !== path.resolve(external.path)) {
      issues.push({
        level: "error",
        code: "external-link-changed",
        message: `${external.agent}/${external.name} 的外部入口目标已经变化`,
      });
      continue;
    }
    const skillFile = await lstat(path.join(current, "SKILL.md")).catch(() => undefined);
    if (!skillFile?.isFile()) {
      issues.push({
        level: "error",
        code: "external-skill-missing",
        message: `${external.agent}/${external.name} 的外部来源缺少 SKILL.md`,
      });
    }
  }
  for (const [name, agent] of Object.entries(agents.agent)) {
    const stat = await lstat(agent.skills_dir).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      issues.push({
        level: "error",
        code: "agent-root-symlink",
        message: `${name} 的整个 Skill 目录指向 ${await readlink(agent.skills_dir)}，无法隔离白名单`,
      });
    }
  }
  const status = issues.some((issue) => issue.level === "error")
    ? "error"
    : issues.some((issue) => issue.level === "warning") ? "warning" : "ok";
  return { status, issues };
}
