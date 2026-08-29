import { rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { SkillsRegistry } from "./model.ts";
import { loadSkillsLock, saveSkillsLock, saveSkillsRegistry } from "./registry.ts";

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} 执行失败`);
  return result.stdout.trim();
}

export function fetchGitSource(library: string, registry: SkillsRegistry, name: string): void {
  const source = registry.source[name];
  if (!source || source.kind !== "git") throw new Error(`不存在 Git source：${name}`);
  runGit(["-C", path.join(library, "sources", name), "fetch", "--all", "--prune"]);
}

export async function addGitSource(
  library: string,
  registry: SkillsRegistry,
  name: string,
  url: string,
  revision?: string,
  defaultAgents?: string[],
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("source 名称只能使用小写字母、数字和连字符");
  if (registry.source[name]) throw new Error(`source.${name} 已存在`);
  const destination = path.join(library, "sources", name);
  try {
    runGit(["clone", "--no-checkout", "--", url, destination]);
    let selectedRevision = revision;
    if (!selectedRevision) {
      try {
        selectedRevision = runGit(["-C", destination, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      } catch {
        selectedRevision = "HEAD";
      }
    }
    const commit = runGit(["-C", destination, "rev-parse", `${selectedRevision}^{commit}`]);
    runGit(["-C", destination, "checkout", "--detach", commit]);
    registry.source[name] = { kind: "git", url, revision: selectedRevision, default_agents: defaultAgents };
    const lock = await loadSkillsLock(library);
    lock.source[name] = { commit };
    await saveSkillsRegistry(library, registry);
    await saveSkillsLock(library, lock);
    return commit;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function updateGitSource(
  library: string,
  registry: SkillsRegistry,
  name: string,
  revision?: string,
): Promise<string> {
  const source = registry.source[name];
  if (!source || source.kind !== "git") throw new Error(`不存在 Git source：${name}`);
  const destination = path.join(library, "sources", name);
  runGit(["-C", destination, "fetch", "--all", "--prune"]);
  const selectedRevision = revision ?? source.revision ?? "HEAD";
  const commit = runGit(["-C", destination, "rev-parse", `${selectedRevision}^{commit}`]);
  runGit(["-C", destination, "checkout", "--detach", commit]);
  source.revision = selectedRevision;
  const lock = await loadSkillsLock(library);
  lock.source[name] = { commit };
  await saveSkillsRegistry(library, registry);
  await saveSkillsLock(library, lock);
  return commit;
}
