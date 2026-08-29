import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";

import type { SkillsRegistry } from "./model.ts";
import { resolveSkillSource } from "./registry.ts";

export interface InventoryItem {
  id: string;
  name: string;
  ownership: "library-owned" | "plugin-owned" | "system-owned" | "runtime-owned" | "legacy-candidate" | "unresolved";
  path: string;
  manageable: boolean;
  owner?: string;
  version?: string;
}

export interface InventoryResult {
  managed: InventoryItem[];
  external: InventoryItem[];
  diagnostics: string[];
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
  const systemRoot = path.join(home, ".codex", "skills", ".system");
  const system = (await directoryNamesWithSkill(systemRoot)).map<InventoryItem>((name) => ({
    id: `system:codex/${name}`,
    name,
    ownership: "system-owned",
    path: path.join(systemRoot, name),
    manageable: false,
    owner: "codex",
  }));
  const plugin = await scanCodexPlugins(home, diagnostics);
  const external = [...plugin, ...system].sort((a, b) => a.id.localeCompare(b.id));
  return { managed, external, diagnostics };
}
