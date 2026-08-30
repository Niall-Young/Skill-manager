import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { SkillsRegistry } from "./model.ts";
import { loadSkillsLock, saveSkillsLock, saveSkillsRegistry } from "./registry.ts";
import { assertSafeSegment, atomicWriteFile, childPath } from "./safety.ts";

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} 执行失败`);
  return result.stdout.trim();
}

export function fetchGitSource(library: string, registry: SkillsRegistry, name: string): void {
  assertSafeSegment(name, "source");
  const source = registry.source[name];
  if (!source || source.kind !== "git") throw new Error(`不存在 Git source：${name}`);
  runGit(["-C", childPath(path.join(library, "sources"), name, "source"), "fetch", "--all", "--prune"]);
}

export async function addGitSource(
  library: string,
  registry: SkillsRegistry,
  name: string,
  url: string,
  revision?: string,
  defaultAgents?: string[],
): Promise<string> {
  assertSafeSegment(name, "source");
  if (registry.source[name]) throw new Error(`source.${name} 已存在`);
  const destination = childPath(path.join(library, "sources"), name, "source");
  const registryPath = path.join(library, "skills.toml");
  const lockPath = path.join(library, "skills.lock");
  const previousRegistry = await readFile(registryPath, "utf8");
  const previousLock = await readFile(lockPath, "utf8");
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
    delete registry.source[name];
    await rm(destination, { recursive: true, force: true });
    await atomicWriteFile(registryPath, previousRegistry).catch(() => undefined);
    await atomicWriteFile(lockPath, previousLock).catch(() => undefined);
    throw error;
  }
}

export async function updateGitSource(
  library: string,
  registry: SkillsRegistry,
  name: string,
  revision?: string,
): Promise<string> {
  assertSafeSegment(name, "source");
  const source = registry.source[name];
  if (!source || source.kind !== "git") throw new Error(`不存在 Git source：${name}`);
  const destination = childPath(path.join(library, "sources"), name, "source");
  const registryPath = path.join(library, "skills.toml");
  const lockPath = path.join(library, "skills.lock");
  const previousRegistry = await readFile(registryPath, "utf8");
  const previousLock = await readFile(lockPath, "utf8");
  const previousCommit = runGit(["-C", destination, "rev-parse", "HEAD^{commit}"]);
  try {
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
  } catch (error) {
    runGit(["-C", destination, "checkout", "--detach", previousCommit]);
    await atomicWriteFile(registryPath, previousRegistry).catch(() => undefined);
    await atomicWriteFile(lockPath, previousLock).catch(() => undefined);
    throw error;
  }
}
