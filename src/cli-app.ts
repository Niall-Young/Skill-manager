import path from "node:path";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";

import { approveAgent, detectAgents } from "./agents.ts";
import { buildAudit } from "./audit.ts";
import { runDoctor } from "./doctor.ts";
import { initializeLibrary } from "./library.ts";
import { addGitSource, fetchGitSource, updateGitSource } from "./git-source.ts";
import { buildInventory } from "./inventory.ts";
import { applyMigrationPlan, createMigrationPlan, finalizeMigration, rollbackMigration } from "./migration.ts";
import { assertSkillDirectory, loadAgentsRegistry, loadSkillsRegistry, resolveSkillSource, saveSkillsRegistry } from "./registry.ts";
import { applySyncPlan, buildSyncPlan } from "./sync.ts";

export interface CliIo {
  cwd: string;
  home: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function libraryPath(argv: string[], io: CliIo): string {
  return path.resolve(io.cwd, flagValue(argv, "--library") ?? path.join(io.home, "MySkills"));
}

const HELP = `SkillManager — 从专门仓库按白名单分发 Skill

常用命令：
  skillmgr library init [path]
  skillmgr agent detect|approve|list
  skillmgr source add|list|fetch
  skillmgr skill add <source> <path>
  skillmgr target set|all|remove
  skillmgr external trust|untrust
  skillmgr list|inventory|explain|plan|sync|audit|doctor
  skillmgr migrate plan|apply|rollback|finalize
  skillmgr update [source]
`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
      io.stdout(HELP);
      return 0;
    }
    if (argv[0] === "library" && argv[1] === "init") {
      const libraryPath = path.resolve(io.cwd, argv[2] ?? path.join(io.home, "MySkills"));
      await initializeLibrary(libraryPath);
      io.stdout(`SkillLibrary 已初始化：${libraryPath}`);
      return 0;
    }

    if (argv[0] === "plan" || argv[0] === "sync") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const agents = await loadAgentsRegistry(io.home);
      const plan = await buildSyncPlan(library, registry, agents);
      if (argv[0] === "sync" && argv.includes("--apply")) {
        const summary = await applySyncPlan(plan);
        io.stdout(JSON.stringify({ plan, summary }, null, 2));
      } else {
        io.stdout(JSON.stringify(plan, null, 2));
      }
      return 0;
    }

    if (argv[0] === "inventory") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      io.stdout(JSON.stringify(await buildInventory(io.home, library, registry), null, 2));
      return 0;
    }

    if (argv[0] === "target" && argv[1] === "set") {
      const skillName = argv[2];
      const agentList = argv[3];
      if (!skillName || !agentList) throw new Error("用法：skillmgr target set <skill> <agent,agent>");
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      if (!registry.skill[skillName]) throw new Error(`未登记 Skill：${skillName}`);
      registry.skill[skillName].agents = [...new Set(agentList.split(",").map((item) => item.trim()).filter(Boolean))];
      if (!registry.skill[skillName].agents?.length) throw new Error("Agent 白名单不能为空");
      await saveSkillsRegistry(library, registry);
      io.stdout(`已更新 ${skillName} 的 Agent 白名单`);
      return 0;
    }

    if (argv[0] === "external" && argv[1] === "trust") {
      const agentName = argv[2];
      const skillName = argv[3];
      const owner = flagValue(argv, "--owner");
      if (!agentName || !skillName || !owner) {
        throw new Error("用法：skillmgr external trust <agent> <skill> --owner <owner>");
      }
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const agents = await loadAgentsRegistry(io.home);
      const agent = agents.agent[agentName];
      if (!agent) throw new Error(`未登记 Agent：${agentName}`);
      const linkPath = path.join(agent.skills_dir, skillName);
      const stat = await lstat(linkPath).catch(() => undefined);
      if (!stat?.isSymbolicLink()) throw new Error(`外部 Skill 入口不是软链接：${linkPath}`);
      const target = path.resolve(path.dirname(linkPath), await readlink(linkPath));
      const relativeToLibrary = path.relative(path.resolve(library), target);
      if (relativeToLibrary === "" || (!relativeToLibrary.startsWith("..") && !path.isAbsolute(relativeToLibrary))) {
        throw new Error(`${skillName} 已经指向 SkillLibrary，不应登记为外部 Skill`);
      }
      const skillFile = await lstat(path.join(target, "SKILL.md")).catch(() => undefined);
      if (!skillFile?.isFile()) throw new Error(`外部 Skill 缺少 SKILL.md：${target}`);
      registry.external[`${agentName}/${skillName}`] = {
        agent: agentName,
        name: skillName,
        link_path: linkPath,
        path: target,
        owner,
      };
      await saveSkillsRegistry(library, registry);
      io.stdout(`已登记外部 Skill：${agentName}/${skillName}`);
      return 0;
    }

    if (argv[0] === "external" && argv[1] === "untrust") {
      const agentName = argv[2];
      const skillName = argv[3];
      if (!agentName || !skillName) throw new Error("用法：skillmgr external untrust <agent> <skill>");
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const id = `${agentName}/${skillName}`;
      if (!registry.external[id]) throw new Error(`未登记外部 Skill：${id}`);
      delete registry.external[id];
      await saveSkillsRegistry(library, registry);
      io.stdout(`已取消外部 Skill 登记：${id}`);
      return 0;
    }

    if (argv[0] === "migrate" && argv[1] === "plan") {
      const library = libraryPath(argv, io);
      const agents = await loadAgentsRegistry(io.home);
      const plan = await createMigrationPlan(io.home, library, agents);
      const output = flagValue(argv, "--output");
      if (output) await writeFile(path.resolve(io.cwd, output), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      io.stdout(JSON.stringify(plan, null, 2));
      return 0;
    }

    if (argv[0] === "source" && argv[1] === "add") {
      const url = argv[2];
      const nameIndex = argv.indexOf("--name");
      const name = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
      if (!url || !name) throw new Error("用法：skillmgr source add <git-url> --name <name>");
      const library = libraryPath(argv, io);
      const revisionIndex = argv.indexOf("--revision");
      const agentsIndex = argv.indexOf("--agents");
      const registry = await loadSkillsRegistry(library);
      const commit = await addGitSource(
        library,
        registry,
        name,
        url,
        revisionIndex >= 0 ? argv[revisionIndex + 1] : undefined,
        agentsIndex >= 0 ? argv[agentsIndex + 1]?.split(",").filter(Boolean) : undefined,
      );
      io.stdout(`已登记 source.${name}：${commit}`);
      return 0;
    }

    if (argv[0] === "skill" && argv[1] === "add") {
      const sourceName = argv[2];
      const skillPath = argv[3];
      const nameIndex = argv.indexOf("--name");
      const agentsIndex = argv.indexOf("--agents");
      const skillName = nameIndex >= 0 ? argv[nameIndex + 1] : skillPath ? path.basename(skillPath) : undefined;
      if (!sourceName || !skillPath || !skillName) throw new Error("用法：skillmgr skill add <source> <path> [--name <name>] --agents <list>");
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      if (!registry.source[sourceName]) throw new Error(`不存在 source.${sourceName}`);
      registry.skill[skillName] = {
        from: sourceName,
        path: skillPath,
        agents: agentsIndex >= 0 ? argv[agentsIndex + 1]?.split(",").filter(Boolean) : undefined,
      };
      const resolved = resolveSkillSource(library, registry, skillName);
      await assertSkillDirectory(skillName, resolved);
      if (!registry.skill[skillName].agents?.length && !registry.source[sourceName].default_agents?.length) {
        throw new Error(`${skillName} 必须指定 Agent 白名单`);
      }
      await saveSkillsRegistry(library, registry);
      io.stdout(`已登记 Skill：${skillName}`);
      return 0;
    }

    if (argv[0] === "migrate" && argv[1] === "apply") {
      const planFile = argv[2];
      if (!planFile) throw new Error("用法：skillmgr migrate apply <migration.json>");
      const library = libraryPath(argv, io);
      const migrationPlan = JSON.parse(await readFile(path.resolve(io.cwd, planFile), "utf8"));
      const agents = await loadAgentsRegistry(io.home);
      io.stdout(JSON.stringify(await applyMigrationPlan(io.home, library, migrationPlan, agents), null, 2));
      return 0;
    }

    if (argv[0] === "migrate" && argv[1] === "rollback") {
      const transactionId = argv[2];
      if (!transactionId) throw new Error("用法：skillmgr migrate rollback <transaction-id>");
      const library = libraryPath(argv, io);
      await rollbackMigration(library, transactionId);
      io.stdout(`已回滚迁移：${transactionId}`);
      return 0;
    }

    if (argv[0] === "migrate" && argv[1] === "finalize") {
      const transactionId = argv[2];
      if (!transactionId) throw new Error("用法：skillmgr migrate finalize <transaction-id>");
      const library = libraryPath(argv, io);
      await finalizeMigration(library, transactionId);
      io.stdout(`已结束迁移并清理备份：${transactionId}`);
      return 0;
    }

    if (argv[0] === "agent" && argv[1] === "detect") {
      io.stdout(JSON.stringify(await detectAgents(io.home), null, 2));
      return 0;
    }

    if (argv[0] === "agent" && argv[1] === "approve") {
      const agentId = argv[2];
      if (!agentId) throw new Error("用法：skillmgr agent approve <agent-id>");
      const approved = await approveAgent(io.home, agentId);
      io.stdout(`已批准 Agent：${approved.id}`);
      return 0;
    }

    if (argv[0] === "agent" && argv[1] === "list") {
      const agents = await loadAgentsRegistry(io.home);
      io.stdout(JSON.stringify(agents, null, 2));
      return 0;
    }

    if (argv[0] === "target" && argv[1] === "all") {
      const skillName = argv[2];
      if (!skillName) throw new Error("用法：skillmgr target all <skill>");
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      if (!registry.skill[skillName]) throw new Error(`未登记 Skill：${skillName}`);
      registry.skill[skillName].agents = ["*"];
      await saveSkillsRegistry(library, registry);
      io.stdout(`已将 ${skillName} 设置为所有兼容 Agent`);
      return 0;
    }

    if (argv[0] === "target" && argv[1] === "remove") {
      const skillName = argv[2];
      const agentName = argv[3];
      if (!skillName || !agentName) throw new Error("用法：skillmgr target remove <skill> <agent>");
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const skill = registry.skill[skillName];
      if (!skill) throw new Error(`未登记 Skill：${skillName}`);
      const effectiveAgents = skill.agents ?? registry.source[skill.from]?.default_agents ?? [];
      if (effectiveAgents.includes("*")) {
        const agents = await loadAgentsRegistry(io.home);
        skill.agents = Object.keys(agents.agent).filter((name) => agents.agent[name].approved && name !== agentName);
      } else {
        skill.agents = effectiveAgents.filter((name) => name !== agentName);
      }
      if (!skill.agents.length) throw new Error(`${skillName} 的白名单不能变为空；请删除 Skill 登记或设置其他目标`);
      await saveSkillsRegistry(library, registry);
      io.stdout(`已从 ${skillName} 白名单移除 ${agentName}`);
      return 0;
    }

    if (argv[0] === "source" && argv[1] === "list") {
      const registry = await loadSkillsRegistry(libraryPath(argv, io));
      io.stdout(JSON.stringify(registry.source, null, 2));
      return 0;
    }

    if (argv[0] === "source" && argv[1] === "fetch") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const names = argv[2] ? [argv[2]] : Object.keys(registry.source).filter((name) => registry.source[name].kind === "git");
      for (const name of names) fetchGitSource(library, registry, name);
      io.stdout(`已获取 ${names.length} 个 Git source`);
      return 0;
    }

    if (argv[0] === "update") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const names = argv[1] && !argv[1].startsWith("--")
        ? [argv[1]]
        : Object.keys(registry.source).filter((name) => registry.source[name].kind === "git");
      const updated: Record<string, string> = {};
      for (const name of names) updated[name] = await updateGitSource(library, registry, name, flagValue(argv, "--revision"));
      io.stdout(JSON.stringify(updated, null, 2));
      return 0;
    }

    if (argv[0] === "list") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const agents = await loadAgentsRegistry(io.home);
      const rows = Object.entries(registry.skill).map(([name, skill]) => ({
        name,
        source: skill.from,
        path: resolveSkillSource(library, registry, name),
        agents: skill.agents ?? registry.source[skill.from]?.default_agents ?? [],
        requires: skill.requires ?? [],
      }));
      io.stdout(JSON.stringify({ skills: rows, approvedAgents: Object.keys(agents.agent).filter((name) => agents.agent[name].approved) }, null, 2));
      return 0;
    }

    if (argv[0] === "explain") {
      const skillName = argv[1];
      if (!skillName) throw new Error("用法：skillmgr explain <skill>");
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const inventory = await buildInventory(io.home, library, registry);
      if (registry.skill[skillName]) {
        const skill = registry.skill[skillName];
        io.stdout(JSON.stringify({
          id: `library:${skillName}`,
          ownership: "library-owned",
          source: skill.from,
          path: resolveSkillSource(library, registry, skillName),
          agents: skill.agents ?? registry.source[skill.from]?.default_agents ?? [],
          requires: skill.requires ?? [],
        }, null, 2));
        return 0;
      }
      const external = inventory.external.find((item) => item.name === skillName || item.id === skillName);
      if (!external) throw new Error(`未找到 Skill：${skillName}`);
      io.stdout(JSON.stringify(external, null, 2));
      return 0;
    }

    if (argv[0] === "audit") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const agents = await loadAgentsRegistry(io.home);
      io.stdout(JSON.stringify(await buildAudit(io.home, library, registry, agents), null, 2));
      return 0;
    }

    if (argv[0] === "doctor") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      const agents = await loadAgentsRegistry(io.home);
      const result = await runDoctor(library, registry, agents);
      io.stdout(JSON.stringify(result, null, 2));
      return result.status === "error" ? 1 : 0;
    }

    if (argv[0] === "library" && argv[1] === "status") {
      const library = libraryPath(argv, io);
      const registry = await loadSkillsRegistry(library);
      io.stdout(JSON.stringify({ library, sources: Object.keys(registry.source).length, skills: Object.keys(registry.skill).length }, null, 2));
      return 0;
    }

    io.stderr("未知命令。运行 skillmgr --help 查看帮助。");
    return 2;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
