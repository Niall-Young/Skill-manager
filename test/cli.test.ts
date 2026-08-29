import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { runCli } from "../src/cli-app.ts";

test("library init creates a dedicated skill repository skeleton", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-init-"));
  const library = path.join(sandbox, "MySkills");
  const stdout: string[] = [];

  const exitCode = await runCli(["library", "init", library], {
    cwd: sandbox,
    home: sandbox,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  });

  assert.equal(exitCode, 0);
  assert.match(await readFile(path.join(library, "skills.toml"), "utf8"), /\[source\.own\]/);
  assert.match(await readFile(path.join(library, ".gitignore"), "utf8"), /^\/sources\/$/m);
  assert.match(stdout.join("\n"), /MySkills/);
});

test("sync distributes each library skill only to its approved agents", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-sync-"));
  const library = path.join(sandbox, "MySkills");
  await runCli(["library", "init", library], {
    cwd: sandbox,
    home: sandbox,
    stdout: () => undefined,
    stderr: () => undefined,
  });

  for (const name of ["i-am-codex", "expert"]) {
    await mkdir(path.join(library, "owned", name), { recursive: true });
    await writeFile(
      path.join(library, "owned", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test skill.\n---\n`,
    );
  }

  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1

[source.own]
kind = "owned"
path = "owned"

[skill.i-am-codex]
from = "own"
path = "i-am-codex"
agents = ["codex"]

[skill.expert]
from = "own"
path = "expert"
agents = ["*"]
`,
  );

  const configDir = path.join(sandbox, ".config", "skillmanager");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "agents.toml"),
    `version = 1

[agent.codex]
skills_dir = "${path.join(sandbox, ".codex", "skills")}"
approved = true

[agent.claude]
skills_dir = "${path.join(sandbox, ".claude", "skills")}"
approved = true

[agent.gemini]
skills_dir = "${path.join(sandbox, ".gemini", "skills")}"
approved = false
`,
  );

  const output: string[] = [];
  const exitCode = await runCli(["sync", "--library", library, "--apply", "--json"], {
    cwd: sandbox,
    home: sandbox,
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });

  assert.equal(exitCode, 0);
  assert.equal(
    await readlink(path.join(sandbox, ".codex", "skills", "i-am-codex")),
    path.join(library, "owned", "i-am-codex"),
  );
  assert.equal(
    await readlink(path.join(sandbox, ".codex", "skills", "expert")),
    path.join(library, "owned", "expert"),
  );
  assert.equal(
    await readlink(path.join(sandbox, ".claude", "skills", "expert")),
    path.join(library, "owned", "expert"),
  );
  assert.equal(JSON.parse(output.join("\n")).summary.created, 3);
  await assert.rejects(readlink(path.join(sandbox, ".claude", "skills", "i-am-codex")));
  await assert.rejects(readlink(path.join(sandbox, ".gemini", "skills", "expert")));
});

test("sync retargets only a previously managed link whose recorded target still matches", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-retarget-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const oldTarget = path.join(library, "owned", "expert");
  const newTarget = path.join(library, "owned", "expert-next");
  for (const target of [oldTarget, newTarget]) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: expert\ndescription: Expert.\n---\n");
  }
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.expert]\nfrom = "own"\npath = "expert"\nagents = ["codex"]\n`,
  );
  await runCli(["sync", "--library", library, "--apply", "--json"], quiet);
  const linkPath = path.join(sandbox, ".codex", "skills", "expert");
  assert.equal(await readlink(linkPath), oldTarget);

  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.expert]\nfrom = "own"\npath = "expert-next"\nagents = ["codex"]\n`,
  );
  const planOutput: string[] = [];
  assert.equal(
    await runCli(["plan", "--library", library, "--json"], { ...quiet, stdout: (line) => planOutput.push(line) }),
    0,
  );
  assert.deepEqual(JSON.parse(planOutput.join("\n")).actions[0], {
    action: "retarget",
    agent: "codex",
    skill: "expert",
    linkPath,
    targetPath: newTarget,
    previousTargetPath: oldTarget,
  });

  const syncOutput: string[] = [];
  assert.equal(
    await runCli(["sync", "--library", library, "--apply", "--json"], {
      ...quiet,
      stdout: (line) => syncOutput.push(line),
    }),
    0,
  );
  assert.equal(await readlink(linkPath), newTarget);
  assert.equal(JSON.parse(syncOutput.join("\n")).summary.retargeted, 1);
});

test("sync never retargets a recorded link whose old target is outside SkillLibrary", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-external-retarget-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const desiredTarget = path.join(library, "owned", "expert");
  const externalTarget = path.join(sandbox, "external", "expert");
  for (const target of [desiredTarget, externalTarget]) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: expert\ndescription: Expert.\n---\n");
  }
  const linkPath = path.join(sandbox, ".codex", "skills", "expert");
  await mkdir(path.dirname(linkPath), { recursive: true });
  await (await import("node:fs/promises")).symlink(externalTarget, linkPath, "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.expert]\nfrom = "own"\npath = "expert"\nagents = ["codex"]\n`,
  );
  await mkdir(path.join(library, ".skillmanager"), { recursive: true });
  await writeFile(
    path.join(library, ".skillmanager", "managed-links.json"),
    JSON.stringify({
      version: 1,
      links: [{ agent: "codex", skill: "expert", linkPath, targetPath: externalTarget }],
    }),
  );

  const output: string[] = [];
  assert.equal(
    await runCli(["plan", "--library", library, "--json"], { ...quiet, stdout: (line) => output.push(line) }),
    0,
  );
  assert.equal(JSON.parse(output.join("\n")).actions[0].action, "conflict");
  assert.equal(await readlink(linkPath), externalTarget);
});

test("inventory keeps Codex system and plugin skills outside the managed library", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-inventory-"));
  const library = path.join(sandbox, "MySkills");
  await runCli(["library", "init", library], {
    cwd: sandbox,
    home: sandbox,
    stdout: () => undefined,
    stderr: () => undefined,
  });

  const systemSkill = path.join(sandbox, ".codex", "skills", ".system", "imagegen");
  await mkdir(systemSkill, { recursive: true });
  await writeFile(path.join(systemSkill, "SKILL.md"), "---\nname: imagegen\ndescription: Codex image tool.\n---\n");

  const pluginRoot = path.join(sandbox, ".codex", "plugins", "cache", "openai-curated", "figma", "1.0.0");
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(pluginRoot, "skills", "figma-use"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "figma", version: "1.0.0", skills: "./skills/" }),
  );
  await writeFile(
    path.join(pluginRoot, "skills", "figma-use", "SKILL.md"),
    "---\nname: figma-use\ndescription: Use the Figma plugin.\n---\n",
  );
  await writeFile(
    path.join(sandbox, ".codex", "config.toml"),
    `[plugins."figma@openai-curated"]\nenabled = true\n`,
  );

  const output: string[] = [];
  const exitCode = await runCli(["inventory", "--library", library, "--json"], {
    cwd: sandbox,
    home: sandbox,
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });

  assert.equal(exitCode, 0);
  const inventory = JSON.parse(output.join("\n"));
  assert.deepEqual(
    inventory.external.map((item: { id: string; ownership: string }) => [item.id, item.ownership]),
    [
      ["plugin:codex/figma/figma-use@1.0.0", "plugin-owned"],
      ["system:codex/imagegen", "system-owned"],
    ],
  );
  assert.equal(inventory.external.every((item: { manageable: boolean }) => item.manageable === false), true);
});

test("inventory recognizes provider, runtime, and explicitly trusted project links as external-owned", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-external-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const codexSkills = path.join(sandbox, ".codex", "skills");
  await mkdir(codexSkills, { recursive: true });
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${codexSkills}"\napproved = true\n`,
  );

  const lark = path.join(sandbox, ".agents", "skills", "lark-doc");
  await mkdir(lark, { recursive: true });
  await writeFile(path.join(lark, "SKILL.md"), "---\nname: lark-doc\ndescription: Lark docs.\n---\n");
  await writeFile(
    path.join(sandbox, ".agents", ".skill-lock.json"),
    JSON.stringify({ version: 1, skills: { "lark-doc": { source: "open.feishu.cn", sourceType: "well-known" } } }),
  );
  await (await import("node:fs/promises")).symlink(lark, path.join(codexSkills, "lark-doc"), "dir");

  const runtime = path.join(sandbox, ".aily-cli", "current", "js", "skills", "aily-cli-runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "SKILL.md"), "---\nname: aily-cli-runtime\ndescription: Aily runtime.\n---\n");
  await (await import("node:fs/promises")).symlink(runtime, path.join(codexSkills, "aily-cli-runtime"), "dir");

  const project = path.join(sandbox, "projects", "AItoFigma", "skills", "ai-to-figma");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "SKILL.md"), "---\nname: ai-to-figma\ndescription: Project skill.\n---\n");
  await (await import("node:fs/promises")).symlink(project, path.join(codexSkills, "ai-to-figma"), "dir");
  assert.equal(
    await runCli(["external", "trust", "codex", "ai-to-figma", "--owner", "AItoFigma", "--library", library], quiet),
    0,
  );

  const inventoryOutput: string[] = [];
  assert.equal(
    await runCli(["inventory", "--library", library], { ...quiet, stdout: (line) => inventoryOutput.push(line) }),
    0,
  );
  const inventory = JSON.parse(inventoryOutput.join("\n"));
  assert.deepEqual(
    inventory.external.map((item: { name: string; ownership: string; owner: string }) => [item.name, item.ownership, item.owner]),
    [
      ["ai-to-figma", "external-owned", "AItoFigma"],
      ["aily-cli-runtime", "runtime-owned", "aily-cli"],
      ["lark-doc", "external-owned", "open.feishu.cn"],
    ],
  );
  const migrationOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => migrationOutput.push(line) });
  assert.deepEqual(JSON.parse(migrationOutput.join("\n")).candidates, []);
});

test("doctor reports a trusted external link whose target changed", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-external-doctor-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const codexSkills = path.join(sandbox, ".codex", "skills");
  const original = path.join(sandbox, "projects", "one", "skills", "expert");
  const changed = path.join(sandbox, "projects", "two", "skills", "expert");
  for (const target of [original, changed]) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: expert\ndescription: Project expert.\n---\n");
  }
  await mkdir(codexSkills, { recursive: true });
  const linkPath = path.join(codexSkills, "expert");
  await (await import("node:fs/promises")).symlink(original, linkPath, "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${codexSkills}"\napproved = true\n`,
  );
  await runCli(["external", "trust", "codex", "expert", "--owner", "project-one", "--library", library], quiet);
  await (await import("node:fs/promises")).rm(linkPath);
  await (await import("node:fs/promises")).symlink(changed, linkPath, "dir");
  const output: string[] = [];

  assert.equal(
    await runCli(["doctor", "--library", library], { ...quiet, stdout: (line) => output.push(line) }),
    1,
  );
  const result = JSON.parse(output.join("\n"));
  assert.equal(result.status, "error");
  assert.equal(result.issues[0].code, "external-link-changed");
});

test("changing a whitelist removes only the previously managed link", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-target-"));
  const library = path.join(sandbox, "MySkills");
  await runCli(["library", "init", library], { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined });
  await mkdir(path.join(library, "owned", "expert"), { recursive: true });
  await writeFile(path.join(library, "owned", "expert", "SKILL.md"), "---\nname: expert\ndescription: Expert.\n---\n");
  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.expert]\nfrom = "own"\npath = "expert"\nagents = ["codex"]\n`,
  );
  const configDir = path.join(sandbox, ".config", "skillmanager");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n[agent.claude]\nskills_dir = "${path.join(sandbox, ".claude", "skills")}"\napproved = true\n`,
  );
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  assert.equal(await runCli(["sync", "--library", library, "--apply"], quiet), 0);
  assert.equal(await runCli(["target", "set", "expert", "claude", "--library", library], quiet), 0);
  assert.equal(await runCli(["sync", "--library", library, "--apply"], quiet), 0);

  await assert.rejects(readlink(path.join(sandbox, ".codex", "skills", "expert")));
  assert.equal(
    await readlink(path.join(sandbox, ".claude", "skills", "expert")),
    path.join(library, "owned", "expert"),
  );
});

test("audit treats an existing agent directory as a migration candidate, never as the library source", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-audit-"));
  const library = path.join(sandbox, "MySkills");
  await runCli(["library", "init", library], { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined });
  const legacy = path.join(sandbox, ".codex", "skills", "legacy-writer");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: legacy-writer\ndescription: Legacy writer.\n---\n");
  const configDir = path.join(sandbox, ".config", "skillmanager");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );

  const output: string[] = [];
  const exitCode = await runCli(["migrate", "plan", "--library", library, "--json"], {
    cwd: sandbox,
    home: sandbox,
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(exitCode, 0);
  const plan = JSON.parse(output.join("\n"));
  assert.equal(plan.candidates[0].name, "legacy-writer");
  assert.equal(plan.candidates[0].action, "review");
  assert.equal(plan.candidates[0].sourcePath, legacy);
  assert.equal(plan.candidates[0].proposedLibraryPath, path.join(library, "owned", "legacy-writer"));
});

test("a Git source is checked out inside SkillLibrary and can be registered for selected agents", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-source-"));
  const upstream = path.join(sandbox, "upstream");
  await mkdir(path.join(upstream, "skills", "remote-expert"), { recursive: true });
  await writeFile(
    path.join(upstream, "skills", "remote-expert", "SKILL.md"),
    "---\nname: remote-expert\ndescription: Remote expert.\n---\n",
  );
  assert.equal(spawnSync("git", ["init", "-b", "main", upstream]).status, 0);
  assert.equal(spawnSync("git", ["-C", upstream, "add", "skills/remote-expert/SKILL.md"]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", upstream, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]).status,
    0,
  );

  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  assert.equal(
    await runCli(["source", "add", upstream, "--name", "upstream", "--library", library], quiet),
    0,
  );
  assert.equal(
    await runCli([
      "skill", "add", "upstream", "skills/remote-expert", "--name", "remote-expert", "--agents", "codex", "--library", library,
    ], quiet),
    0,
  );

  assert.match(await readFile(path.join(library, "skills.toml"), "utf8"), /\[skill\.remote-expert\]/);
  assert.match(await readFile(path.join(library, "skills.lock"), "utf8"), /\[source\.upstream\]/);
  assert.match(
    await readFile(path.join(library, "sources", "upstream", "skills", "remote-expert", "SKILL.md"), "utf8"),
    /remote-expert/,
  );
});

test("an explicitly approved migration adopts a legacy skill and replaces it with a library link", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-migrate-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const legacy = path.join(sandbox, ".codex", "skills", "legacy-writer");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: legacy-writer\ndescription: Legacy writer.\n---\n");
  const configDir = path.join(sandbox, ".config", "skillmanager");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], {
    ...quiet,
    stdout: (line) => planOutput.push(line),
  });
  const migrationPlan = JSON.parse(planOutput.join("\n"));
  migrationPlan.candidates[0].action = "adopt";
  migrationPlan.candidates[0].agents = ["codex"];
  const planFile = path.join(sandbox, "migration.json");
  await writeFile(planFile, JSON.stringify(migrationPlan));

  const output: string[] = [];
  const exitCode = await runCli(["migrate", "apply", planFile, "--library", library, "--json"], {
    ...quiet,
    stdout: (line) => output.push(line),
  });
  assert.equal(exitCode, 0);
  assert.match(await readFile(path.join(library, "owned", "legacy-writer", "SKILL.md"), "utf8"), /legacy-writer/);
  assert.equal(await readlink(legacy), path.join(library, "owned", "legacy-writer"));
  assert.match(JSON.parse(output.join("\n")).transactionId, /^migration-/);
});

test("migration relinks a legacy external entry to an existing library skill without copying its source", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-relink-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  await mkdir(path.join(library, "owned", "expert"), { recursive: true });
  await writeFile(path.join(library, "owned", "expert", "SKILL.md"), "---\nname: expert\ndescription: Current expert.\n---\n");
  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.expert]\nfrom = "own"\npath = "expert"\nagents = ["claude"]\n`,
  );
  const external = path.join(sandbox, ".agents", "skills", "expert");
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "SKILL.md"), "---\nname: expert\ndescription: Legacy expert.\n---\n");
  await writeFile(
    path.join(sandbox, ".agents", ".skill-lock.json"),
    JSON.stringify({ version: 1, skills: { expert: { source: "example/provider", sourceType: "github" } } }),
  );
  const codexEntry = path.join(sandbox, ".codex", "skills", "expert");
  await mkdir(path.dirname(codexEntry), { recursive: true });
  await (await import("node:fs/promises")).symlink(external, codexEntry, "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n[agent.claude]\nskills_dir = "${path.join(sandbox, ".claude", "skills")}"\napproved = true\n`,
  );

  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.candidates[0].action = "relink";
  plan.candidates[0].agents = ["codex", "claude"];
  const planFile = path.join(sandbox, "relink.json");
  await writeFile(planFile, JSON.stringify(plan));
  const applyOutput: string[] = [];

  assert.equal(
    await runCli(["migrate", "apply", planFile, "--library", library], {
      ...quiet,
      stdout: (line) => applyOutput.push(line),
    }),
    0,
  );
  assert.equal(await readlink(codexEntry), path.join(library, "owned", "expert"));
  assert.match(await readFile(path.join(external, "SKILL.md"), "utf8"), /Legacy expert/);
  assert.match(await readFile(path.join(library, "skills.toml"), "utf8"), /agents = \[ "codex", "claude" \]/);

  const transactionId = JSON.parse(applyOutput.join("\n")).transactionId;
  assert.equal(await runCli(["migrate", "rollback", transactionId, "--library", library], quiet), 0);
  assert.equal(await readlink(codexEntry), external);
  assert.match(await readFile(path.join(external, "SKILL.md"), "utf8"), /Legacy expert/);
});

test("migration retires a legacy Codex skill only when an enabled native replacement exists", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-retire-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const legacy = path.join(sandbox, ".codex", "skills", "pdf");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: pdf\ndescription: Legacy PDF.\n---\n");
  const pluginRoot = path.join(sandbox, ".codex", "plugins", "cache", "openai", "pdf", "2.0.0");
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(pluginRoot, "skills", "pdf"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "pdf", version: "2.0.0", skills: "./skills/" }),
  );
  await writeFile(path.join(pluginRoot, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Native PDF.\n---\n");
  await writeFile(path.join(sandbox, ".codex", "config.toml"), `[plugins."pdf@openai"]\nenabled = true\n`);
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );

  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  assert.equal(plan.candidates[0].replacement.id, "plugin:codex/pdf/pdf@2.0.0");
  plan.candidates[0].action = "retire";
  const planFile = path.join(sandbox, "retire.json");
  await writeFile(planFile, JSON.stringify(plan));
  const applyOutput: string[] = [];

  assert.equal(
    await runCli(["migrate", "apply", planFile, "--library", library], {
      ...quiet,
      stdout: (line) => applyOutput.push(line),
    }),
    0,
  );
  await assert.rejects(readFile(path.join(legacy, "SKILL.md"), "utf8"));
  assert.match(await readFile(path.join(pluginRoot, "skills", "pdf", "SKILL.md"), "utf8"), /Native PDF/);

  const transactionId = JSON.parse(applyOutput.join("\n")).transactionId;
  assert.equal(await runCli(["migrate", "rollback", transactionId, "--library", library], quiet), 0);
  assert.match(await readFile(path.join(legacy, "SKILL.md"), "utf8"), /Legacy PDF/);
});

test("migration prunes only a broken Skill symlink and can restore it", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-prune-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const brokenTarget = path.join(sandbox, "missing-project", "skills", "gone");
  const brokenLink = path.join(sandbox, ".codex", "skills", "gone");
  await mkdir(path.dirname(brokenLink), { recursive: true });
  await (await import("node:fs/promises")).symlink(brokenTarget, brokenLink, "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  assert.equal(plan.candidates[0].brokenLink, true);
  plan.candidates[0].action = "prune";
  const planFile = path.join(sandbox, "prune.json");
  await writeFile(planFile, JSON.stringify(plan));
  const applyOutput: string[] = [];

  assert.equal(
    await runCli(["migrate", "apply", planFile, "--library", library], {
      ...quiet,
      stdout: (line) => applyOutput.push(line),
    }),
    0,
  );
  await assert.rejects(readlink(brokenLink));
  const transactionId = JSON.parse(applyOutput.join("\n")).transactionId;
  assert.equal(await runCli(["migrate", "rollback", transactionId, "--library", library], quiet), 0);
  assert.equal(await readlink(brokenLink), brokenTarget);
});

test("migration apply rejects a stale or altered candidate plan", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-stale-migration-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const legacy = path.join(sandbox, ".codex", "skills", "legacy-writer");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: legacy-writer\ndescription: Original.\n---\n");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.candidates[0].action = "adopt";
  plan.candidates[0].agents = ["codex"];
  const planFile = path.join(sandbox, "stale.json");
  await writeFile(planFile, JSON.stringify(plan));
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: legacy-writer\ndescription: Changed later.\n---\n");

  const errors: string[] = [];
  assert.equal(
    await runCli(["migrate", "apply", planFile, "--library", library], {
      ...quiet,
      stderr: (line) => errors.push(line),
    }),
    1,
  );
  assert.match(errors.join("\n"), /已经变化/);
  assert.match(await readFile(path.join(legacy, "SKILL.md"), "utf8"), /Changed later/);
});

test("a migration transaction can restore the original agent directory", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-rollback-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const legacy = path.join(sandbox, ".codex", "skills", "legacy-writer");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: legacy-writer\ndescription: Legacy writer.\n---\n");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.candidates[0].action = "adopt";
  plan.candidates[0].agents = ["codex"];
  const planFile = path.join(sandbox, "migration.json");
  await writeFile(planFile, JSON.stringify(plan));
  const applyOutput: string[] = [];
  await runCli(["migrate", "apply", planFile, "--library", library], { ...quiet, stdout: (line) => applyOutput.push(line) });
  const transactionId = JSON.parse(applyOutput.join("\n")).transactionId;

  assert.equal(await runCli(["migrate", "rollback", transactionId, "--library", library], quiet), 0);
  assert.match(await readFile(path.join(legacy, "SKILL.md"), "utf8"), /legacy-writer/);
  await assert.rejects(readFile(path.join(library, "owned", "legacy-writer", "SKILL.md"), "utf8"));
  assert.doesNotMatch(await readFile(path.join(library, "skills.toml"), "utf8"), /skill\.legacy-writer/);
});

test("migration finalize removes its backup only after the migrated link remains valid", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-finalize-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const legacy = path.join(sandbox, ".codex", "skills", "legacy-writer");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: legacy-writer\ndescription: Legacy writer.\n---\n");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\n`,
  );
  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.candidates[0].action = "adopt";
  plan.candidates[0].agents = ["codex"];
  const planFile = path.join(sandbox, "migration.json");
  await writeFile(planFile, JSON.stringify(plan));
  const applyOutput: string[] = [];
  await runCli(["migrate", "apply", planFile, "--library", library], { ...quiet, stdout: (line) => applyOutput.push(line) });
  const transactionId = JSON.parse(applyOutput.join("\n")).transactionId;
  const backupRoot = path.join(library, ".skillmanager", "migration-backups", transactionId);
  assert.match(await readFile(path.join(backupRoot, "codex", "legacy-writer", "SKILL.md"), "utf8"), /Legacy writer/);

  assert.equal(await runCli(["migrate", "finalize", transactionId, "--library", library], quiet), 0);
  await assert.rejects(readFile(path.join(backupRoot, "codex", "legacy-writer", "SKILL.md"), "utf8"));
  const errors: string[] = [];
  assert.equal(
    await runCli(["migrate", "rollback", transactionId, "--library", library], { ...quiet, stderr: (line) => errors.push(line) }),
    1,
  );
  assert.match(errors.join("\n"), /已经结束/);
});

test("agent detection is read-only until the user approves a discovered agent", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-agent-"));
  await mkdir(path.join(sandbox, ".qwen"), { recursive: true });
  const output: string[] = [];
  assert.equal(
    await runCli(["agent", "detect", "--json"], {
      cwd: sandbox,
      home: sandbox,
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(output.join("\n")), [
    { id: "qwen", skillsDir: path.join(sandbox, ".qwen", "skills"), approved: false, capabilities: [] },
  ]);
  await assert.rejects(readFile(path.join(sandbox, ".config", "skillmanager", "agents.toml"), "utf8"));

  assert.equal(
    await runCli(["agent", "approve", "qwen"], {
      cwd: sandbox,
      home: sandbox,
      stdout: () => undefined,
      stderr: () => undefined,
    }),
    0,
  );
  assert.match(await readFile(path.join(sandbox, ".config", "skillmanager", "agents.toml"), "utf8"), /\[agent\.qwen\]/);
});

test("agent detection includes Qoder CN and Kimi Code with their native Skill directories", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-modern-agents-"));
  await mkdir(path.join(sandbox, ".qoder-cn"), { recursive: true });
  await mkdir(path.join(sandbox, ".kimi-code"), { recursive: true });
  const output: string[] = [];

  assert.equal(
    await runCli(["agent", "detect", "--json"], {
      cwd: sandbox,
      home: sandbox,
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    }),
    0,
  );

  assert.deepEqual(JSON.parse(output.join("\n")), [
    { id: "qodercn", skillsDir: path.join(sandbox, ".qoder-cn", "skills"), approved: false, capabilities: [] },
    { id: "kimi", skillsDir: path.join(sandbox, ".kimi-code", "skills"), approved: false, capabilities: [] },
  ]);
});

test("wildcard distribution skips agents that lack a required host capability", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-capability-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  await mkdir(path.join(library, "owned", "image-workflow"), { recursive: true });
  await writeFile(path.join(library, "owned", "image-workflow", "SKILL.md"), "---\nname: image-workflow\ndescription: Generate images.\n---\n");
  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.image-workflow]\nfrom = "own"\npath = "image-workflow"\nagents = ["*"]\nrequires = ["image_gen"]\n`,
  );
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${path.join(sandbox, ".codex", "skills")}"\napproved = true\ncapabilities = ["image_gen"]\n[agent.claude]\nskills_dir = "${path.join(sandbox, ".claude", "skills")}"\napproved = true\ncapabilities = []\n`,
  );
  const output: string[] = [];
  assert.equal(await runCli(["plan", "--library", library, "--json"], { ...quiet, stdout: (line) => output.push(line) }), 0);
  const plan = JSON.parse(output.join("\n"));
  assert.deepEqual(plan.actions.map((item: { agent: string; action: string }) => [item.agent, item.action]), [["codex", "create"]]);
  assert.match(plan.diagnostics[0], /claude.*image_gen/);
});

test("an approved migration can split a whole-directory agent alias before distribution", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-split-root-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const codexSkills = path.join(sandbox, ".codex", "skills");
  const legacy = path.join(codexSkills, "shared-expert");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: shared-expert\ndescription: Shared expert.\n---\n");
  await mkdir(path.join(sandbox, ".claude"), { recursive: true });
  await (await import("node:fs/promises")).symlink(codexSkills, path.join(sandbox, ".claude", "skills"), "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${codexSkills}"\napproved = true\n[agent.claude]\nskills_dir = "${path.join(sandbox, ".claude", "skills")}"\napproved = true\n`,
  );
  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.candidates[0].action = "adopt";
  plan.candidates[0].agents = ["codex", "claude"];
  plan.rootAliases[0].action = "split";
  const planFile = path.join(sandbox, "split.json");
  await writeFile(planFile, JSON.stringify(plan));

  assert.equal(await runCli(["migrate", "apply", planFile, "--library", library], quiet), 0);
  assert.equal((await (await import("node:fs/promises")).lstat(path.join(sandbox, ".claude", "skills"))).isDirectory(), true);
  assert.equal(
    await readlink(path.join(sandbox, ".claude", "skills", "shared-expert")),
    path.join(library, "owned", "shared-expert"),
  );
});

test("migration can split whole-directory aliases without adopting a legacy Skill", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-split-only-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  await mkdir(path.join(library, "owned", "expert"), { recursive: true });
  await writeFile(path.join(library, "owned", "expert", "SKILL.md"), "---\nname: expert\ndescription: Expert.\n---\n");
  await writeFile(
    path.join(library, "skills.toml"),
    `version = 1\n[source.own]\nkind = "owned"\npath = "owned"\n[skill.expert]\nfrom = "own"\npath = "expert"\nagents = ["claude"]\n`,
  );
  const codexSkills = path.join(sandbox, ".codex", "skills");
  const claudeSkills = path.join(sandbox, ".claude", "skills");
  await mkdir(codexSkills, { recursive: true });
  await mkdir(path.dirname(claudeSkills), { recursive: true });
  await (await import("node:fs/promises")).symlink(codexSkills, claudeSkills, "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.claude]\nskills_dir = "${claudeSkills}"\napproved = true\n`,
  );

  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.rootAliases[0].action = "split";
  const planFile = path.join(sandbox, "split-only.json");
  await writeFile(planFile, JSON.stringify(plan));

  assert.equal(await runCli(["migrate", "apply", planFile, "--library", library], quiet), 0);
  assert.equal((await (await import("node:fs/promises")).lstat(claudeSkills)).isDirectory(), true);
  assert.equal(await readlink(path.join(claudeSkills, "expert")), path.join(library, "owned", "expert"));
});

test("migration rollback refuses to delete unmanaged content in a split agent root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skillmanager-safe-root-rollback-"));
  const library = path.join(sandbox, "MySkills");
  const quiet = { cwd: sandbox, home: sandbox, stdout: () => undefined, stderr: () => undefined };
  await runCli(["library", "init", library], quiet);
  const codexSkills = path.join(sandbox, ".codex", "skills");
  const legacy = path.join(codexSkills, "shared-expert");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "SKILL.md"), "---\nname: shared-expert\ndescription: Shared expert.\n---\n");
  const claudeSkills = path.join(sandbox, ".claude", "skills");
  await mkdir(path.dirname(claudeSkills), { recursive: true });
  await (await import("node:fs/promises")).symlink(codexSkills, claudeSkills, "dir");
  await mkdir(path.join(sandbox, ".config", "skillmanager"), { recursive: true });
  await writeFile(
    path.join(sandbox, ".config", "skillmanager", "agents.toml"),
    `version = 1\n[agent.codex]\nskills_dir = "${codexSkills}"\napproved = true\n[agent.claude]\nskills_dir = "${claudeSkills}"\napproved = true\n`,
  );

  const planOutput: string[] = [];
  await runCli(["migrate", "plan", "--library", library], { ...quiet, stdout: (line) => planOutput.push(line) });
  const plan = JSON.parse(planOutput.join("\n"));
  plan.candidates[0].action = "adopt";
  plan.candidates[0].agents = ["codex", "claude"];
  plan.rootAliases[0].action = "split";
  const planFile = path.join(sandbox, "split.json");
  await writeFile(planFile, JSON.stringify(plan));
  const applyOutput: string[] = [];
  assert.equal(
    await runCli(["migrate", "apply", planFile, "--library", library], {
      ...quiet,
      stdout: (line) => applyOutput.push(line),
    }),
    0,
  );
  const transactionId = JSON.parse(applyOutput.join("\n")).transactionId;
  const unmanagedFile = path.join(claudeSkills, "unmanaged", "keep.txt");
  await mkdir(path.dirname(unmanagedFile), { recursive: true });
  await writeFile(unmanagedFile, "must survive\n");

  const errors: string[] = [];
  assert.equal(
    await runCli(["migrate", "rollback", transactionId, "--library", library], {
      ...quiet,
      stderr: (line) => errors.push(line),
    }),
    1,
  );
  assert.match(errors.join("\n"), /未受管内容/);
  assert.equal(await readFile(unmanagedFile, "utf8"), "must survive\n");
  assert.equal(await readlink(path.join(claudeSkills, "shared-expert")), path.join(library, "owned", "shared-expert"));
});
