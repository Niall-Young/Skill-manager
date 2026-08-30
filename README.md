# SkillManager

在一个独立仓库中管理 Agent Skills，并按白名单安全分发给 Codex、Claude Code、Gemini 等本地 AI Agent。

Manage Agent Skills in one dedicated repository and safely distribute them to local AI agents with explicit allowlists.

[![npm](https://img.shields.io/npm/v/@niallayoung/skillmanager)](https://www.npmjs.com/package/@niallayoung/skillmanager)
[![CI](https://github.com/Niall-Young/Skill-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Niall-Young/Skill-manager/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/npm/l/@niallayoung/skillmanager)](LICENSE)

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 中文

### 项目简介

当你同时使用多个 AI 编程工具，同一份 Skill 往往会散落在不同的全局目录里：改了一份，其他副本不会更新；哪些 Agent 能使用它，也很难说清楚。

SkillManager 提供一个简单规则：

```text
~/MySkills（唯一原件）
        │
        ├── skills.toml（分发白名单）
        │
        └── SkillManager
              ├──→ ~/.codex/skills/<skill>
              ├──→ ~/.claude/skills/<skill>
              └──→ 其他已批准 Agent 的 Skill 目录
```

Agent 目录里只有指向原件的软链接。你只维护一份 Skill，并明确决定它能分发给谁。

当前版本为本地 CLI `v0.1.0`。它不会自动接管现有 Skill，也不会覆盖真实目录或未知软链接；所有迁移都必须先生成计划，再由你明确选择动作。

### 核心能力

- **一份原件**：个人 Skill 统一保存在独立的 `~/MySkills` Git 仓库。
- **明确授权**：每个 Skill 使用 Agent 白名单；`["*"]` 也只覆盖已批准且能力兼容的 Agent。
- **安全同步**：先 `plan` 预览，再 `sync --apply`；写入带事务记录，失败可回滚。
- **第三方来源**：支持本地或远程 Git 仓库，并在 `skills.lock` 中固定 commit。
- **存量迁移**：审计旧目录，支持迁入、换链、退役、回滚和验收后清理备份。
- **尊重所有权**：项目级、Plugin、System 和 Runtime Skill 只读识别，不擅自搬运。

内置识别：Codex、Claude Code、Qoder CN、Kimi Code、Gemini、Kiro、Qwen、Roo Code、Continue、CodeBuddy、WorkBuddy 和 AiderDesk。

### 快速开始

#### 1. 安装

需要 Node.js 22+、Git，以及支持目录软链接的系统。

```sh
npm install --global @niallayoung/skillmanager
skillmgr --help
```

如果 npm 镜像还没有同步最新版本，可临时使用官方 registry：

```sh
npm install --global @niallayoung/skillmanager --registry=https://registry.npmjs.org/
```

#### 2. 初始化 SkillLibrary

```sh
skillmgr library init ~/MySkills
skillmgr agent detect --json
skillmgr agent approve codex
```

把最后一行的 `codex` 换成你检测到并希望授权的 Agent。`agent detect` 只读；只有 `agent approve` 会把批准信息写入 `~/.config/skillmanager/agents.toml`。

#### 3. 添加第一份 Skill

```sh
mkdir -p ~/MySkills/owned/hello
```

创建 `~/MySkills/owned/hello/SKILL.md`：

```markdown
---
name: hello
description: 用一句友好的话向用户问好
---

# Hello

用简洁、自然的语言向用户问好。
```

登记它，并只授权给 Codex：

```sh
skillmgr skill add own hello --name hello --agents codex
```

#### 4. 预览并同步

```sh
skillmgr plan
skillmgr sync --apply
skillmgr doctor
```

完成后，`~/.codex/skills/hello` 会指向 `~/MySkills/owned/hello`。以后修改原件，无需复制多份文件。

> `sync --apply` 只处理 SkillManager 已登记且当前状态可验证的入口。请始终先阅读 `plan` 输出。

### 日常使用

| 目标 | 命令 |
| --- | --- |
| 查看已登记 Skill 和批准的 Agent | `skillmgr list` |
| 查看某个 Skill 的来源与归属 | `skillmgr explain <skill>` |
| 修改 Agent 白名单 | `skillmgr target set <skill> codex,claude` |
| 分发给所有兼容且已批准的 Agent | `skillmgr target all <skill>` |
| 从白名单移除一个 Agent | `skillmgr target remove <skill> <agent>` |
| 预览同步变更 | `skillmgr plan` |
| 应用同步变更 | `skillmgr sync --apply` |
| 检查配置、链接与未完成事务 | `skillmgr doctor` |
| 审计现有 Skill | `skillmgr audit` |

所有命令默认使用 `~/MySkills`。如需其他位置，追加 `--library /path/to/library`。

#### 使用第三方 Git Skill

```sh
skillmgr source add https://github.com/OWNER/REPO --name example
skillmgr skill add example skills/example-skill --agents codex,claude
skillmgr plan
skillmgr sync --apply
```

更新第三方来源：

```sh
skillmgr update example
```

> 固定 commit 只能保证版本可复现，不能证明第三方 Skill 安全。分发前请审查对应 commit 中的 `SKILL.md`、脚本和资源。

### 迁移已有 Skill

先审计，再生成迁移计划：

```sh
skillmgr audit
skillmgr migrate plan --output migration.json
```

生成的候选项默认都是 `"action": "review"`，不会直接执行。确认所有权后，可在计划中选择：

- `adopt`：把个人 Skill 原件迁入 MySkills；
- `relink`：把旧入口改为已登记的 MySkills Skill；
- `retire`：仅在已有同名 System/Plugin 替代项时退役旧版本；
- `prune`：仅清理目标不存在的断链；
- `split`：拆分指向整套旧 Skill 目录的别名。

执行、回滚或确认完成：

```sh
skillmgr migrate apply migration.json
skillmgr migrate rollback TRANSACTION_ID
skillmgr migrate finalize TRANSACTION_ID
```

`finalize` 会重新验证原件和软链接，然后删除该事务的备份并关闭回滚窗口。

### 配置与安全边界

| 路径 | 用途 |
| --- | --- |
| `~/MySkills/skills.toml` | Skill 来源、路径、白名单和能力要求 |
| `~/MySkills/skills.lock` | 第三方 Git commit 锁定 |
| `~/.config/skillmanager/agents.toml` | 本机 Agent 路径、批准状态和能力 |
| `~/MySkills/.skillmanager/` | 受管链接状态、事务日志和迁移备份 |

- Skill、source 和 Agent 名称必须是单层路径名。
- SkillManager 不修改项目级 Skill，不安装或升级 Plugin，也不移动 Agent System/Runtime Skill。
- 真实目录、未知软链接、被手工改向的链接和库外目标都会报告冲突，不会被覆盖。
- 如果 `doctor` 报告未完成事务，请保留日志和备份，不要手工移动相关入口。

### 从源码开发

```sh
git clone https://github.com/Niall-Young/Skill-manager.git
cd Skill-manager
pnpm install --frozen-lockfile
pnpm check
npm pack --dry-run
```

测试使用临时 HOME、临时 SkillLibrary 和本地 Git fixture，不接触真实 Agent 目录。

### 贡献、安全与许可证

- 贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全漏洞请通过 [Private Vulnerability Reporting](https://github.com/Niall-Young/Skill-manager/security/advisories/new) 私下报告。
- 本项目采用 [MIT License](LICENSE)。

[English](#english) · [返回顶部](#skillmanager)

---

<a id="english"></a>
## English

### Overview

When you use multiple AI coding tools, the same Skill often ends up copied across several global directories. Updating one copy leaves the others stale, and it becomes difficult to tell which agents are allowed to use it.

SkillManager follows one simple rule:

```text
~/MySkills (single source of truth)
        │
        ├── skills.toml (distribution allowlists)
        │
        └── SkillManager
              ├──→ ~/.codex/skills/<skill>
              ├──→ ~/.claude/skills/<skill>
              └──→ Skill directories of other approved agents
```

Agent directories contain symlinks to the originals. You maintain one copy of each Skill and explicitly decide where it can be distributed.

The current release is a local CLI, `v0.1.0`. It never takes over existing Skills automatically and never overwrites real directories or unknown symlinks. Every migration starts with a plan and requires an explicit action choice.

### Features

- **One source of truth**: keep personal Skills in a dedicated `~/MySkills` Git repository.
- **Explicit access**: assign every Skill an Agent allowlist; even `["*"]` targets only approved, capability-compatible agents.
- **Safe synchronization**: preview with `plan`, apply with `sync --apply`, and recover failed writes through transaction records.
- **Third-party sources**: use local or remote Git repositories with commits pinned in `skills.lock`.
- **Legacy migration**: audit old directories, adopt or relink Skills, retire replacements, roll back, and remove backups after verification.
- **Ownership-aware**: detect project, Plugin, System, and Runtime Skills without moving them.

Built-in detection covers Codex, Claude Code, Qoder CN, Kimi Code, Gemini, Kiro, Qwen, Roo Code, Continue, CodeBuddy, WorkBuddy, and AiderDesk.

### Quick Start

#### 1. Install

Requires Node.js 22+, Git, and an operating system with directory symlink support.

```sh
npm install --global @niallayoung/skillmanager
skillmgr --help
```

If your npm mirror has not synchronized the latest release yet, temporarily use the official registry:

```sh
npm install --global @niallayoung/skillmanager --registry=https://registry.npmjs.org/
```

#### 2. Initialize SkillLibrary

```sh
skillmgr library init ~/MySkills
skillmgr agent detect --json
skillmgr agent approve codex
```

Replace `codex` on the last line with an agent you detected and want to approve. `agent detect` is read-only; only `agent approve` writes approval data to `~/.config/skillmanager/agents.toml`.

#### 3. Add your first Skill

```sh
mkdir -p ~/MySkills/owned/hello
```

Create `~/MySkills/owned/hello/SKILL.md`:

```markdown
---
name: hello
description: Greet the user with one friendly sentence
---

# Hello

Greet the user in concise, natural language.
```

Register it and allow only Codex to use it:

```sh
skillmgr skill add own hello --name hello --agents codex
```

#### 4. Preview and sync

```sh
skillmgr plan
skillmgr sync --apply
skillmgr doctor
```

After synchronization, `~/.codex/skills/hello` points to `~/MySkills/owned/hello`. Future edits affect the original, so there are no copies to keep in sync.

> `sync --apply` touches only registered entries whose current state SkillManager can verify. Always review the `plan` output first.

### Everyday Usage

| Goal | Command |
| --- | --- |
| List registered Skills and approved agents | `skillmgr list` |
| Explain a Skill's source and ownership | `skillmgr explain <skill>` |
| Set an Agent allowlist | `skillmgr target set <skill> codex,claude` |
| Target every compatible approved agent | `skillmgr target all <skill>` |
| Remove one Agent from an allowlist | `skillmgr target remove <skill> <agent>` |
| Preview synchronization | `skillmgr plan` |
| Apply synchronization | `skillmgr sync --apply` |
| Check configuration, links, and incomplete transactions | `skillmgr doctor` |
| Audit existing Skills | `skillmgr audit` |

Commands use `~/MySkills` by default. Append `--library /path/to/library` to use another location.

#### Use a third-party Git Skill

```sh
skillmgr source add https://github.com/OWNER/REPO --name example
skillmgr skill add example skills/example-skill --agents codex,claude
skillmgr plan
skillmgr sync --apply
```

Update a third-party source with:

```sh
skillmgr update example
```

> Pinning a commit makes a version reproducible; it does not make a third-party Skill safe. Review that commit's `SKILL.md`, scripts, and assets before distributing it.

### Migrate Existing Skills

Audit first, then create a migration plan:

```sh
skillmgr audit
skillmgr migrate plan --output migration.json
```

Every candidate starts with `"action": "review"` and is not applied automatically. After confirming ownership, choose:

- `adopt`: move a personal Skill original into MySkills;
- `relink`: redirect a legacy entry to a registered MySkills Skill;
- `retire`: retire an old copy only when a same-name System/Plugin replacement exists;
- `prune`: remove only a symlink whose target no longer exists;
- `split`: split an alias that points to an entire legacy Skill directory.

Apply, roll back, or finalize the migration:

```sh
skillmgr migrate apply migration.json
skillmgr migrate rollback TRANSACTION_ID
skillmgr migrate finalize TRANSACTION_ID
```

`finalize` revalidates originals and symlinks, removes the transaction backup, and closes the rollback window.

### Configuration and Safety Boundaries

| Path | Purpose |
| --- | --- |
| `~/MySkills/skills.toml` | Skill sources, paths, allowlists, and capability requirements |
| `~/MySkills/skills.lock` | Pinned third-party Git commits |
| `~/.config/skillmanager/agents.toml` | Machine-local Agent paths, approvals, and capabilities |
| `~/MySkills/.skillmanager/` | Managed-link state, transaction journals, and migration backups |

- Skill, source, and Agent names must be single path segments.
- SkillManager does not modify project-local Skills, install or update Plugins, or move Agent System/Runtime Skills.
- Real directories, unknown symlinks, manually redirected links, and targets outside the library are reported as conflicts and never overwritten.
- If `doctor` reports an incomplete transaction, preserve its journal and backup instead of moving affected entries manually.

### Develop from Source

```sh
git clone https://github.com/Niall-Young/Skill-manager.git
cd Skill-manager
pnpm install --frozen-lockfile
pnpm check
npm pack --dry-run
```

Tests use a temporary HOME, a temporary SkillLibrary, and local Git fixtures; they never touch live Agent directories.

### Contributing, Security, and License

- See [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.
- Report vulnerabilities privately through [Private Vulnerability Reporting](https://github.com/Niall-Young/Skill-manager/security/advisories/new).
- This project is licensed under the [MIT License](LICENSE).

[中文](#中文) · [Back to top](#skillmanager)
