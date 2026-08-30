# Contributing / 参与贡献

## 中文

欢迎提交问题和 Pull Request。开始开发前请先确认相关 Issue，避免重复工作或改变项目的安全边界。

```sh
pnpm install --frozen-lockfile
pnpm check
npm pack --dry-run
```

文件系统相关改动必须包含失败路径测试，并证明不会覆盖真实目录、未知软链接或 SkillLibrary 与 Agent Skill 目录之外的路径。请勿在 Issue 中公开安全漏洞；按 [SECURITY.md](SECURITY.md) 私下报告。

## English

Issues and pull requests are welcome. Please confirm the relevant issue before starting substantial work so changes do not duplicate effort or weaken the project's safety boundaries.

```sh
pnpm install --frozen-lockfile
pnpm check
npm pack --dry-run
```

Filesystem changes must include failure-path tests proving they cannot overwrite real directories, unknown symlinks, or paths outside the SkillLibrary and Agent Skill roots. Do not disclose vulnerabilities in a public issue; report them privately as described in [SECURITY.md](SECURITY.md).
