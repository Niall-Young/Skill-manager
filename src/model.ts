export interface SourceConfig {
  kind: "owned" | "git";
  path?: string;
  url?: string;
  revision?: string;
  default_agents?: string[];
}

export interface SkillConfig {
  from: string;
  path: string;
  agents?: string[];
  requires?: string[];
}

export interface ExternalSkillConfig {
  agent: string;
  name: string;
  link_path: string;
  path: string;
  owner: string;
}

export interface SkillsRegistry {
  version: number;
  source: Record<string, SourceConfig>;
  skill: Record<string, SkillConfig>;
  external: Record<string, ExternalSkillConfig>;
}

export interface AgentConfig {
  skills_dir: string;
  approved: boolean;
  capabilities?: string[];
  system_roots?: string[];
}

export interface AgentsRegistry {
  version: number;
  agent: Record<string, AgentConfig>;
}

export type PlanActionKind = "create" | "keep" | "remove" | "conflict";

export interface PlanAction {
  action: PlanActionKind;
  agent: string;
  skill: string;
  linkPath: string;
  targetPath: string;
  reason?: string;
}

export interface SyncPlan {
  library: string;
  actions: PlanAction[];
  diagnostics: string[];
}
