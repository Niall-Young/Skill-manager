# SkillManager

Distribute personal global Agent Skills from one dedicated library with explicit allowlists.

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 中文

### 项目简介

SkillManager 把 Skill 的“原件”和 Agent 的“使用入口”分开：原件统一放在独立的 `MySkills` 仓库，Codex、Claude Code、Qoder CN、Kimi Code、Gemini 等 Agent 的全局 Skill 目录只接收按白名单生成的软链接。项目级 Skill、Plugin Skill 和 Agent 系统 Skill 不属于这个分发流程。

当前版本是面向单机的 CLI v0.1。它不会自动改动你现有的全局 Skill；迁移必须先生成计划，再把候选项明确标记为 `adopt`、`relink`、`retire` 或 `prune`，或把需要取消的整目录别名标记为 `split`。

最简单的判断方式是先分清“谁拥有它”：

| Skill 类型 | 原件放在哪里 | SkillManager 怎么处理 |
| --- | --- | --- |
| 个人、可跨 Agent 使用 | 独立的 `~/MySkills` | 按 Agent 白名单分发软链接 |
| 只属于某个项目 | 该项目自己的 Skill 目录 | 不迁移；显式登记后只审计入口 |
| Plugin / System / Runtime 提供 | 原 Agent 生态管理的位置 | 只读识别，绝不复制、迁移或链接 |

所以“我是 Codex”可以设为 `agents = ["codex"]`；“我是专家”可以设为 `agents = ["*"]`。后者也不会盲目发给所有目录，只会发给你已经批准、且具备所需能力的 Agent。

### 核心能力

- 初始化独立 `MySkills` Git 仓库，不把任何 Agent 目录当作真源。
- 使用 `skills.toml` 为每个 Skill 指定 Agent 白名单，`["*"]` 仅覆盖已批准且能力兼容的 Agent。
- 从本地或远程 Git 仓库检出第三方 Skill，并在 `skills.lock` 中固定 commit。
- 识别 Codex System 与当前启用 Plugin 的 Skill，只读展示、不迁移。
- 自动识别 `.agents` 安装器和 Aily Runtime 的外部 Skill；项目链接可显式登记为外部所有。
- 以事务方式创建、改指向和移除逐 Skill 链接；只有旧目标仍与受管记录一致且位于 SkillLibrary 内的链接才能安全改指向，真实目录、未知链接和整目录别名会成为冲突。
- 审计遗留 Skill，支持迁入、换链、退役、回滚和验收后清理备份。
- 附带轻量自然语言入口 [`skills/skillmanager`](skills/skillmanager/SKILL.md)。

### 快速开始

#### 环境要求

- Node.js 22 或更高版本
- pnpm 11
- Git
- macOS 或其他支持目录软链接的系统

#### 安装与构建

```sh
pnpm install
pnpm build
node dist/cli.js --help
```

构建后的 npm binary 名为 `skillmgr`。在仓库内可用 `node dist/cli.js` 执行相同命令。

#### 初始化专门仓库

```sh
node dist/cli.js library init ~/MySkills
node dist/cli.js agent detect --json
node dist/cli.js agent approve codex
node dist/cli.js agent approve claude
node dist/cli.js agent approve qodercn
node dist/cli.js agent approve kimi
```

`agent detect` 是只读操作；只有 `agent approve` 才会把 Agent 写入本机的 `~/.config/skillmanager/agents.toml`。

### 使用方法

`~/MySkills/skills.toml` 是 Skill 与白名单的真源：

```toml
version = 1

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
```

将 Skill 放入 `~/MySkills/owned/<name>/SKILL.md` 后，先预览再同步：

```sh
node dist/cli.js plan --library ~/MySkills
node dist/cli.js sync --library ~/MySkills --apply
```

当已登记 Skill 的来源路径发生变化时，`plan` 会把仍指向旧目标且与受管记录一致的入口显示为 `retarget`。请先检查计划，再执行 `sync --apply`；未受管链接、已被手工改向的链接，以及旧目标位于 SkillLibrary 外的链接仍会报告冲突，不会被覆盖。

常用白名单操作：

```sh
node dist/cli.js target set expert codex,claude --library ~/MySkills
node dist/cli.js target all expert --library ~/MySkills
node dist/cli.js target remove expert claude --library ~/MySkills
```

项目仍拥有正文、Codex 只保留入口的 Skill，需要显式登记：

```sh
node dist/cli.js external trust codex project-skill --owner PROJECT_NAME --library ~/MySkills
node dist/cli.js external untrust codex project-skill --library ~/MySkills
```

添加第三方 Git 来源和其中的 Skill：

```sh
node dist/cli.js source add https://github.com/OWNER/REPO --name example --library ~/MySkills
node dist/cli.js skill add example skills/example-skill --agents codex,claude --library ~/MySkills
```

安全审计与迁移：

```sh
node dist/cli.js audit --library ~/MySkills
node dist/cli.js migrate plan --library ~/MySkills --output migration.json
```

生成的迁移候选默认都是 `"action": "review"`。确认来源后选择动作：`adopt` 把个人原件迁入 MySkills；`relink` 把旧入口换到已登记的同名 MySkills Skill；`retire` 仅用于已有同名 Codex System/Plugin 替代项的旧版本；`prune` 仅清理目标不存在的断链。`adopt` 和 `relink` 都必须填写 `agents`。

```sh
node dist/cli.js migrate apply migration.json --library ~/MySkills
node dist/cli.js migrate rollback TRANSACTION_ID --library ~/MySkills
node dist/cli.js migrate finalize TRANSACTION_ID --library ~/MySkills
```

`finalize` 会再次验证迁入正文和软链接，再删除该事务的备份并关闭回滚窗口。

### 配置与边界

- `~/MySkills/skills.toml`：Skill 来源、路径、白名单和能力要求。
- `~/MySkills/skills.lock`：第三方 Git commit。
- `~/.config/skillmanager/agents.toml`：本机 Agent 的独立全局目录、批准状态和能力。
- `~/MySkills/.skillmanager/`：受管链接、事务与迁移备份，不进入 Git。
- SkillManager 不修改项目级 Skill，不安装或升级 Plugin，也不移动 Agent System/Runtime Skill。
- 某 Agent 的整个 Skill 目录若是软链接，`doctor` 和迁移计划会报告；只有明确把对应 `rootAliases[].action` 改为 `split` 后，迁移才会拆分它。

### 开发与验证

```sh
pnpm check
pnpm pack --dry-run
```

测试使用临时 HOME、临时 SkillLibrary 和本地 Git fixture，不接触真实 Agent 目录。

[English](#english) · [返回顶部](#skillmanager)

---

<a id="english"></a>
## English

### Overview

SkillManager separates Skill originals from Agent discovery entries. Originals live in a dedicated `MySkills` repository, while global Skill directories for Codex, Claude Code, Qoder CN, Kimi Code, Gemini, and other agents receive only allowlisted symlinks. Project-local, Plugin-owned, and Agent System Skills stay outside this distribution flow.

The current release is a local-first CLI v0.1. It never migrates existing global Skills automatically: migration starts with a plan, and each selected Skill must be changed to `adopt`, `relink`, `retire`, or `prune`, or a whole-directory alias must be changed to `split`.

The ownership rule is intentionally simple:

| Skill type | Where its original belongs | SkillManager behavior |
| --- | --- | --- |
| Personal and portable across Agents | Dedicated `~/MySkills` library | Distribute allowlisted symlinks |
| Owned by one project | That project's own Skill directory | Never migrate it; audit only explicitly trusted links |
| Supplied by a Plugin, System, or Runtime | Its Agent ecosystem's managed location | Detect read-only; never copy, migrate, or link it |

For example, “I am Codex” can use `agents = ["codex"]`, while a portable “expert” Skill can use `agents = ["*"]`. The wildcard still targets only approved Agents that satisfy the Skill's capability requirements.

### Features

- Initialize a dedicated `MySkills` Git repository without treating any Agent directory as a source of truth.
- Assign each Skill an Agent allowlist in `skills.toml`; `["*"]` includes only approved, capability-compatible Agents.
- Check out third-party Skills from local or remote Git repositories and pin their commits in `skills.lock`.
- Detect Codex System Skills and Skills from currently enabled Plugins as read-only inventory.
- Recognize provider-installed and Aily Runtime Skills automatically, with explicit trust records for project-owned links.
- Create, retarget, and remove per-Skill links transactionally. Retargeting is allowed only when the old target still matches managed state and remains inside SkillLibrary; real directories, unknown links, and whole-directory aliases become conflicts.
- Audit legacy Skills, adopt, relink, retire, roll back, and finalize their migrations.
- Include a lightweight natural-language entrypoint at [`skills/skillmanager`](skills/skillmanager/SKILL.md).

### Quick Start

#### Prerequisites

- Node.js 22 or later
- pnpm 11
- Git
- macOS or another system with directory symlink support

#### Install and build

```sh
pnpm install
pnpm build
node dist/cli.js --help
```

The built npm binary is named `skillmgr`. Inside this repository, `node dist/cli.js` runs the same commands.

#### Initialize the dedicated library

```sh
node dist/cli.js library init ~/MySkills
node dist/cli.js agent detect --json
node dist/cli.js agent approve codex
node dist/cli.js agent approve claude
node dist/cli.js agent approve qodercn
node dist/cli.js agent approve kimi
```

`agent detect` is read-only. Only `agent approve` writes the Agent to `~/.config/skillmanager/agents.toml`.

### Usage

`~/MySkills/skills.toml` is the source of truth for Skills and allowlists:

```toml
version = 1

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
```

After adding a Skill at `~/MySkills/owned/<name>/SKILL.md`, preview and then apply distribution:

```sh
node dist/cli.js plan --library ~/MySkills
node dist/cli.js sync --library ~/MySkills --apply
```

When a registered Skill's source path changes, `plan` reports an existing entry as `retarget` only if it still points to the recorded managed target. Review the plan before running `sync --apply`. Unmanaged links, manually redirected links, and links whose old target is outside SkillLibrary remain conflicts and are never overwritten.

Common allowlist operations:

```sh
node dist/cli.js target set expert codex,claude --library ~/MySkills
node dist/cli.js target all expert --library ~/MySkills
node dist/cli.js target remove expert claude --library ~/MySkills
```

Explicitly register a project-owned Skill whose source stays with its project:

```sh
node dist/cli.js external trust codex project-skill --owner PROJECT_NAME --library ~/MySkills
node dist/cli.js external untrust codex project-skill --library ~/MySkills
```

Add a third-party Git source and one of its Skills:

```sh
node dist/cli.js source add https://github.com/OWNER/REPO --name example --library ~/MySkills
node dist/cli.js skill add example skills/example-skill --agents codex,claude --library ~/MySkills
```

Safe audit and migration:

```sh
node dist/cli.js audit --library ~/MySkills
node dist/cli.js migrate plan --library ~/MySkills --output migration.json
```

Every generated candidate starts with `"action": "review"`. Use `adopt` to move a personal original into MySkills, `relink` to replace a legacy entry with an already registered MySkills Skill, `retire` only when a same-name Codex System/Plugin replacement is present, or `prune` only for a symlink whose target is missing. Both `adopt` and `relink` require `agents`.

```sh
node dist/cli.js migrate apply migration.json --library ~/MySkills
node dist/cli.js migrate rollback TRANSACTION_ID --library ~/MySkills
node dist/cli.js migrate finalize TRANSACTION_ID --library ~/MySkills
```

`finalize` revalidates migrated originals and links, removes that transaction's backup, and closes the rollback window.

### Configuration and Boundaries

- `~/MySkills/skills.toml`: Skill sources, paths, allowlists, and capability requirements.
- `~/MySkills/skills.lock`: pinned third-party Git commits.
- `~/.config/skillmanager/agents.toml`: machine-local Agent directories, approvals, and capabilities.
- `~/MySkills/.skillmanager/`: managed-link state, transactions, and migration backups; excluded from Git.
- SkillManager does not modify project-local Skills, install or update Plugins, or move Agent System/Runtime Skills.
- If an Agent's entire Skill directory is a symlink, `doctor` and the migration plan report it. Migration splits it only after the matching `rootAliases[].action` is explicitly changed to `split`.

### Development and Verification

```sh
pnpm check
pnpm pack --dry-run
```

Tests use a temporary HOME, temporary SkillLibrary, and local Git fixtures; they never touch live Agent directories.

[中文](#中文) · [Back to top](#skillmanager)
