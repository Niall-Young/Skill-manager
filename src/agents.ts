import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";

import type { AgentConfig, AgentsRegistry } from "./model.ts";

const KNOWN_AGENTS: Array<{ id: string; homeDir: string; skillsDir: string; capabilities: string[] }> = [
  { id: "codex", homeDir: ".codex", skillsDir: ".codex/skills", capabilities: ["image_gen", "view_image", "codex-plugins"] },
  { id: "claude", homeDir: ".claude", skillsDir: ".claude/skills", capabilities: [] },
  { id: "qodercn", homeDir: ".qoder-cn", skillsDir: ".qoder-cn/skills", capabilities: [] },
  { id: "kimi", homeDir: ".kimi-code", skillsDir: ".kimi-code/skills", capabilities: [] },
  { id: "gemini", homeDir: ".gemini", skillsDir: ".gemini/skills", capabilities: [] },
  { id: "kiro", homeDir: ".kiro", skillsDir: ".kiro/skills", capabilities: [] },
  { id: "qwen", homeDir: ".qwen", skillsDir: ".qwen/skills", capabilities: [] },
  { id: "roo", homeDir: ".roo", skillsDir: ".roo/skills", capabilities: [] },
  { id: "continue", homeDir: ".continue", skillsDir: ".continue/skills", capabilities: [] },
  { id: "codebuddy", homeDir: ".codebuddy", skillsDir: ".codebuddy/skills", capabilities: [] },
  { id: "workbuddy", homeDir: ".workbuddy", skillsDir: ".workbuddy/skills", capabilities: [] },
  { id: "aider-desk", homeDir: ".aider-desk", skillsDir: ".aider-desk/skills", capabilities: [] },
];

export interface DetectedAgent {
  id: string;
  skillsDir: string;
  approved: boolean;
  capabilities: string[];
}

async function currentApprovals(home: string): Promise<Record<string, AgentConfig>> {
  try {
    const raw = parse(await readFile(path.join(home, ".config", "skillmanager", "agents.toml"), "utf8")) as {
      agent?: Record<string, AgentConfig>;
    };
    return raw.agent ?? {};
  } catch {
    return {};
  }
}

export async function detectAgents(home: string): Promise<DetectedAgent[]> {
  const approvals = await currentApprovals(home);
  const detected: DetectedAgent[] = [];
  for (const known of KNOWN_AGENTS) {
    const present = await lstat(path.join(home, known.homeDir)).then(() => true).catch(() => false);
    if (!present) continue;
    detected.push({
      id: known.id,
      skillsDir: path.join(home, known.skillsDir),
      approved: approvals[known.id]?.approved === true,
      capabilities: approvals[known.id]?.capabilities ?? known.capabilities,
    });
  }
  return detected;
}

export async function approveAgent(home: string, agentId: string): Promise<DetectedAgent> {
  const detected = await detectAgents(home);
  const candidate = detected.find((agent) => agent.id === agentId);
  if (!candidate) throw new Error(`未检测到 Agent：${agentId}`);
  const filePath = path.join(home, ".config", "skillmanager", "agents.toml");
  const current = await currentApprovals(home);
  current[agentId] = {
    skills_dir: candidate.skillsDir,
    approved: true,
    capabilities: candidate.capabilities,
  };
  const registry: AgentsRegistry = { version: 1, agent: current };
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, stringify(registry as unknown as Record<string, unknown>), "utf8");
  await rename(temporary, filePath);
  return { ...candidate, approved: true };
}
