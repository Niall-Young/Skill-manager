import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";

import type { AgentsRegistry, SkillsRegistry } from "./model.ts";
import { assertInside, assertSafeSegment, atomicWriteFile } from "./safety.ts";

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 TOML 表`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return value as string[];
}

export function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

export async function loadSkillsRegistry(library: string): Promise<SkillsRegistry> {
  const raw = parse(await readFile(path.join(library, "skills.toml"), "utf8"));
  const root = asObject(raw, "skills.toml");
  const sourcesRaw = asObject(root.source ?? {}, "source");
  const skillsRaw = asObject(root.skill ?? {}, "skill");
  const externalRaw = asObject(root.external ?? {}, "external");
  const source: SkillsRegistry["source"] = {};
  const skill: SkillsRegistry["skill"] = {};
  const external: SkillsRegistry["external"] = {};

  for (const [name, value] of Object.entries(sourcesRaw)) {
    assertSafeSegment(name, "source");
    const entry = asObject(value, `source.${name}`);
    if (entry.kind !== "owned" && entry.kind !== "git") {
      throw new Error(`source.${name}.kind 必须是 owned 或 git`);
    }
    source[name] = {
      kind: entry.kind,
      path: typeof entry.path === "string" ? entry.path : undefined,
      url: typeof entry.url === "string" ? entry.url : undefined,
      revision: typeof entry.revision === "string" ? entry.revision : undefined,
      default_agents: asStringArray(entry.default_agents, `source.${name}.default_agents`),
    };
  }

  for (const [name, value] of Object.entries(skillsRaw)) {
    assertSafeSegment(name, "Skill");
    const entry = asObject(value, `skill.${name}`);
    if (typeof entry.from !== "string" || typeof entry.path !== "string") {
      throw new Error(`skill.${name} 必须包含 from 和 path`);
    }
    skill[name] = {
      from: entry.from,
      path: entry.path,
      agents: asStringArray(entry.agents, `skill.${name}.agents`),
      requires: asStringArray(entry.requires, `skill.${name}.requires`),
    };
    assertSafeSegment(skill[name].from, `skill.${name}.from`);
    for (const agent of skill[name].agents ?? []) {
      if (agent !== "*") assertSafeSegment(agent, `skill.${name}.agents`);
    }
  }

  for (const [id, value] of Object.entries(externalRaw)) {
    const entry = asObject(value, `external.${id}`);
    if (
      typeof entry.agent !== "string"
      || typeof entry.name !== "string"
      || typeof entry.link_path !== "string"
      || typeof entry.path !== "string"
      || typeof entry.owner !== "string"
    ) {
      throw new Error(`external.${id} 必须包含 agent、name、link_path、path 和 owner`);
    }
    external[id] = {
      agent: entry.agent,
      name: entry.name,
      link_path: path.resolve(entry.link_path),
      path: path.resolve(entry.path),
      owner: entry.owner,
    };
    assertSafeSegment(external[id].agent, `external.${id}.agent`);
    assertSafeSegment(external[id].name, `external.${id}.name`);
    if (id !== `${external[id].agent}/${external[id].name}`) {
      throw new Error(`external.${id} 的 ID 必须匹配 agent/name`);
    }
  }

  return { version: Number(root.version ?? 1), source, skill, external };
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, withoutUndefined(child)]),
    );
  }
  return value;
}

export async function saveSkillsRegistry(library: string, registry: SkillsRegistry): Promise<void> {
  const target = path.join(library, "skills.toml");
  await atomicWriteFile(target, stringify(withoutUndefined(registry) as Record<string, unknown>));
}

export interface SkillsLock {
  version: number;
  source: Record<string, { commit: string }>;
}

export async function loadSkillsLock(library: string): Promise<SkillsLock> {
  const raw = parse(await readFile(path.join(library, "skills.lock"), "utf8")) as Record<string, unknown>;
  const sourceRaw = asObject(raw.source ?? {}, "skills.lock source");
  const source: SkillsLock["source"] = {};
  for (const [name, value] of Object.entries(sourceRaw)) {
    const entry = asObject(value, `skills.lock source.${name}`);
    if (typeof entry.commit !== "string") throw new Error(`skills.lock source.${name}.commit 无效`);
    source[name] = { commit: entry.commit };
  }
  return { version: Number(raw.version ?? 1), source };
}

export async function saveSkillsLock(library: string, lock: SkillsLock): Promise<void> {
  const target = path.join(library, "skills.lock");
  await atomicWriteFile(target, stringify(lock as unknown as Record<string, unknown>));
}

export async function loadAgentsRegistry(home: string): Promise<AgentsRegistry> {
  const filePath = path.join(home, ".config", "skillmanager", "agents.toml");
  const raw = parse(await readFile(filePath, "utf8"));
  const root = asObject(raw, "agents.toml");
  const agentsRaw = asObject(root.agent ?? {}, "agent");
  const agent: AgentsRegistry["agent"] = {};

  for (const [name, value] of Object.entries(agentsRaw)) {
    assertSafeSegment(name, "Agent");
    const entry = asObject(value, `agent.${name}`);
    if (typeof entry.skills_dir !== "string" || typeof entry.approved !== "boolean") {
      throw new Error(`agent.${name} 必须包含 skills_dir 和 approved`);
    }
    agent[name] = {
      skills_dir: path.resolve(expandHome(entry.skills_dir, home)),
      approved: entry.approved,
      capabilities: asStringArray(entry.capabilities, `agent.${name}.capabilities`),
      system_roots: asStringArray(entry.system_roots, `agent.${name}.system_roots`)?.map((item) =>
        path.resolve(expandHome(item, home)),
      ),
    };
  }

  return { version: Number(root.version ?? 1), agent };
}

export function resolveSkillSource(library: string, registry: SkillsRegistry, skillName: string): string {
  const skill = registry.skill[skillName];
  const source = registry.source[skill.from];
  if (!source) throw new Error(`skill.${skillName} 引用了不存在的 source.${skill.from}`);
  const sourceRoot = source.kind === "owned"
    ? path.resolve(library, source.path ?? "owned")
    : path.resolve(library, "sources", skill.from);
  const resolved = path.resolve(sourceRoot, skill.path);
  const libraryPrefix = `${path.resolve(library)}${path.sep}`;
  if (resolved !== path.resolve(library) && !resolved.startsWith(libraryPrefix)) {
    throw new Error(`skill.${skillName} 的路径逃出了 SkillLibrary`);
  }
  return resolved;
}

export async function assertSkillDirectory(skillName: string, skillPath: string, library?: string): Promise<void> {
  const rootStat = await lstat(skillPath).catch(() => undefined);
  if (rootStat?.isSymbolicLink()) throw new Error(`skill.${skillName} 的 Skill 根目录不能是软链接`);
  if (!rootStat?.isDirectory()) throw new Error(`skill.${skillName} 不是有效目录：${skillPath}`);
  if (library) assertInside(await realpath(library), await realpath(skillPath), `skill.${skillName} 的真实路径`);
  const stat = await lstat(path.join(skillPath, "SKILL.md")).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`skill.${skillName} 缺少 SKILL.md：${skillPath}`);
}
