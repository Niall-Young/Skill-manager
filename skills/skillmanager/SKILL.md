---
name: skillmanager
description: Manage personal global Agent Skills from a dedicated SkillLibrary, including agent allowlists, audits, synchronization, Git sources, and reviewed legacy migration. Use when the user asks which Agent should receive a Skill or wants to inspect, distribute, update, or reorganize global Skills. Do not use for project-local Skills or Plugin/System-owned Skills.
---

# SkillManager

Use the `skillmgr` CLI as the only mutation interface. Never create ad-hoc links with `ln -s`, and never treat an Agent's own Skill directory as the source library.

## Scope

- Managed originals live under the configured SkillLibrary, normally `~/MySkills`.
- Agent global Skill directories are distribution targets only.
- Project-local Skills remain owned by their projects.
- Plugin, System, bundled, and Runtime Skills are read-only inventory. Explain their owner instead of copying or linking them.

## Workflow

1. For discovery or diagnosis, run the relevant read-only command: `skillmgr list`, `inventory`, `explain`, `agent detect`, `plan`, `audit`, `doctor`, `library status`, or `source list`.
2. Translate the user's requested recipients into an explicit allowlist with `skillmgr target set`, or use `skillmgr target all` only when the user clearly wants every compatible approved Agent.
3. Run `skillmgr plan` and inspect creates, removals, safe `retarget` actions, and conflicts before applying distribution.
4. Run `skillmgr sync --apply` only when the requested target change is explicit and the plan contains no unexpected removal or conflict. A `retarget` is safe only when the current link still matches SkillManager's recorded target and that old target is inside the SkillLibrary.
5. For legacy cleanup, run `skillmgr migrate plan --output <file>`. Do not change `review` candidates until the user confirms the action: use `adopt` to move a personal original into MySkills, `relink` to replace a legacy entry with an existing same-name library Skill, `retire` only when the plan identifies a same-name Codex System/Plugin replacement, and `prune` only when the plan marks a symlink as broken. `adopt` and `relink` require an explicit Agent allowlist.
6. Use `skillmgr external trust <agent> <skill> --owner <owner>` only for a verified project-owned link whose original must stay with its project. Provider-installed `.agents` Skills and Aily Runtime Skills are detected automatically.
7. After applying and verifying a migration, keep its transaction ID until rollback is no longer needed, then run `skillmgr migrate finalize <transaction-id>` to revalidate the result and remove only that transaction's backup.

Use `--library <path>` when the library is not `~/MySkills`. Prefer JSON output when results need to be reasoned over or reported.

## Safety invariants

- A Skill without an Agent allowlist is not distributed.
- Never overwrite a real directory or an unmanaged link in an Agent target.
- Never retarget a link whose current target differs from managed state or whose old target is outside the SkillLibrary.
- Never mark an unknown link as external merely to silence a migration candidate; verify its owner, target, and `SKILL.md` first.
- Do not break a whole-directory alias automatically; report it through `doctor` or the migration plan.
- Do not manage a Skill whose owner is Plugin, System, bundled, or Runtime.
- Update third-party Git sources explicitly; do not silently advance their locked commit.
- If a Skill requires a host capability the target Agent lacks, preserve the conflict and explain it.
- Use `migrate rollback <transaction-id>` when a completed migration must be reverted.
