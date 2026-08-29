import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";

import type { SkillsRegistry } from "./model.ts";
import { resolveSkillSource } from "./registry.ts";

export interface InventoryItem {
  id: string;
  name: string;
  ownership: "library-owned" | "plugin-owned" | "system-owned" | "runtime-owned" | "external-owned" | "legacy-candidate" | "unresolved";
  path: string;
  linkPath?: string;
  manageable: boolean;
  owner?: string;
  version?: string;
}

export interface InventoryResult {
  managed: InventoryItem[];
  external: InventoryItem[];
  diagnostics: string[];
}

export async function buildCodexOwnedInventory(home: string, diagnostics: string[] = []): Promise<InventoryItem[]> {
  const systemRoot = path.join(home, ".codex", "skills", ".system");
  const system = (await directoryNamesWithSkill(systemRoot)).map<InventoryItem>((name) => ({
    id: `system:codex/${name}`,
    name,
    ownership: "system-owned",
    path: path.join(systemRoot, name),
    manageable: false,
    owner: "codex",
  }));
  return [...await scanCodexPlugins(home, diagnostics), ...system].sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildExternalLinkInventory(
  home: string,
  registry: SkillsRegistry,
  diagnostics: string[] = [],
): Promise<InventoryItem[]> {
  const items = new Map<string, InventoryItem>();
  for (const [id, external] of Object.entries(registry.external)) {
    const stat = await lstat(external.link_path).catch(() => undefined);
    if (!stat?.isSymbolicLink()) {
      diagnostics.push(`外部 Skill 登记已失效：${external.link_path} 不再是软链接`);
      continue;
    }
    const target = path.resolve(path.dirname(external.link_path), await readlink(external.link_path));
    if (target !== path.resolve(external.path)) {
      diagnostics.push(`外部 Skill 登记已失效：${external.link_path} 的目标已经变化`);
      continue;
    }
    items.set(external.link_path, {
      id: `external:${external.agent}/${external.name}`,
      name: external.name,
      ownership: "external-owned",
      path: target,
      linkPath: external.link_path,
      manageable: false,
      owner: external.owner,
    });
  }

  const lock: { skills?: Record<string, { source?: string }> } = await readFile(
    path.join(home, ".agents", ".skill-lock.json"),
    "utf8",
  )
    .then((content) => JSON.parse(content) as { skills?: Record<string, { source?: string }> })
    .catch(() => ({ skills: {} }));
  const codexSkills = path.join(home, ".codex", "skills");
  const entries = await readdir(codexSkills, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(codexSkills, entry.name);
    if (items.has(linkPath)) continue;
    const target = path.resolve(path.dirname(linkPath), await readlink(linkPath));
    const locked = lock.skills?.[entry.name];
    if (locked && !registry.skill[entry.name] && target === path.join(home, ".agents", "skills", entry.name)) {
      items.set(linkPath, {
        id: `external:codex/${entry.name}`,
        name: entry.name,
        ownership: "external-owned",
        path: target,
        linkPath,
        manageable: false,
        owner: locked.source ?? ".agents",
      });
      continue;
    }
    const ailyRoot = path.join(home, ".aily-cli");
    const relative = path.relative(ailyRoot, target);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      items.set(linkPath, {
        id: `runtime:codex/${entry.name}`,
        name: entry.name,
        ownership: "runtime-owned",
        path: target,
        linkPath,
        manageable: false,
        owner: "aily-cli",
      });
    }
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function directoryNamesWithSkill(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillFile = path.join(root, entry.name, "SKILL.md");
    if (await readFile(skillFile, "utf8").then(() => true).catch(() => false)) names.push(entry.name);
  }
  return names.sort();
}

async function findPluginManifests(root: string, depth = 0): Promise<string[]> {
  if (depth > 7) return [];
  const direct = path.join(root, ".codex-plugin", "plugin.json");
  if (await readFile(direct, "utf8").then(() => true).catch(() => false)) return [direct];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("plugin-install-"))
      .map((entry) => findPluginManifests(path.join(root, entry.name), depth + 1)),
  );
  return nested.flat();
}

async function enabledCodexPlugins(home: string, diagnostics: string[]): Promise<Set<string>> {
  try {
    const config = parse(await readFile(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, unknown>;
    const plugins = config.plugins as Record<string, { enabled?: boolean }> | undefined;
    return new Set(
      Object.entries(plugins ?? {})
        .filter(([, value]) => value?.enabled === true)
        .map(([qualified]) => qualified.split("@")[0]),
    );
  } catch (error) {
    diagnostics.push(`无法读取 Codex Plugin 启用状态：${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

async function scanCodexPlugins(home: string, diagnostics: string[]): Promise<InventoryItem[]> {
  const enabled = await enabledCodexPlugins(home, diagnostics);
  const manifests = await findPluginManifests(path.join(home, ".codex", "plugins", "cache"));
  const candidates = new Map<string, { manifest: string; name: string; version: string; skillsRoot: string }>();

  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: string;
        version?: string;
        skills?: string;
      };
      if (!manifest.name || !manifest.skills || !enabled.has(manifest.name)) continue;
      const version = manifest.version ?? "unknown";
      const current = candidates.get(manifest.name);
      if (!current || version.localeCompare(current.version, undefined, { numeric: true }) > 0) {
        const pluginRoot = path.dirname(path.dirname(manifestPath));
        candidates.set(manifest.name, {
          manifest: manifestPath,
          name: manifest.name,
          version,
          skillsRoot: path.resolve(pluginRoot, manifest.skills),
        });
      }
    } catch (error) {
      diagnostics.push(`无法解析 Plugin manifest ${manifestPath}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const result: InventoryItem[] = [];
  for (const plugin of candidates.values()) {
    for (const skillName of await directoryNamesWithSkill(plugin.skillsRoot)) {
      result.push({
        id: `plugin:codex/${plugin.name}/${skillName}@${plugin.version}`,
        name: skillName,
        ownership: "plugin-owned",
        path: path.join(plugin.skillsRoot, skillName),
        manageable: false,
        owner: plugin.name,
        version: plugin.version,
      });
    }
  }
  return result;
}

export async function buildInventory(home: string, library: string, registry: SkillsRegistry): Promise<InventoryResult> {
  const diagnostics: string[] = [];
  const managed: InventoryItem[] = Object.keys(registry.skill).sort().map((name) => ({
    id: `library:${name}`,
    name,
    ownership: "library-owned",
    path: resolveSkillSource(library, registry, name),
    manageable: true,
  }));
  const external = [
    ...await buildCodexOwnedInventory(home, diagnostics),
    ...await buildExternalLinkInventory(home, registry, diagnostics),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { managed, external, diagnostics };
}
