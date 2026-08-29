import { lstat, readlink } from "node:fs/promises";
import path from "node:path";

import type { AgentsRegistry, SkillsRegistry } from "./model.ts";
import { resolveSkillSource } from "./registry.ts";

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
