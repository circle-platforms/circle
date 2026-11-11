---
name: skill-creator
description: Create or improve a reusable SKILL.md workflow and verify Circle can discover and load it. Use when asked to create or edit a skill.
---

# Create or improve a skill

Read existing skills and the project's instructions first. Establish the task, when the skill should apply, and the result the user expects. Ask only about missing choices that materially change the workflow.

For a new project skill, write `.circle/skills/<name>/SKILL.md`. If the user asks for a global skill, use `<Circle data folder>/skills/<name>/SKILL.md`; find the active folder with `circle --print-home` rather than assuming `~/.circle`. Honor a supplied location. The desktop file tools exclude `.circle` and application data. For those configuration directories, use an approved `execute` command with the existing Node filesystem API to inspect and write the requested skill, rather than changing file grants. Use an exclusive create for a new file so an existing skill is not overwritten. Read an existing skill before editing it; to customize a built-in, create a project or user copy of the same name.

Use lowercase letters, digits and single hyphens for the name, at most 64 characters, matching the folder. Start with:

```markdown
---
name: example-workflow
description: Explain the task and when this skill applies.
---

# Workflow

Instructions needed to perform the task.
```

Keep the description under 160 characters so it fits Circle's initial list. Put only information that changes the agent's decisions in the body. Reuse the target project's tools, formats and conventions. Do not copy another agent's tool names or invocation syntax without checking Circle's equivalents.

Keep longer conditional guidance in `references/`, with links explaining when to read it. The `skill` tool's `reference` argument reads files under that directory. Add scripts or templates only when they solve a concrete repeated problem; run any new script on synthetic input. Hooks execute commands once the skill is loaded: add them only when requested, not as scaffolding.

Check the frontmatter, paths and actual resources. Use `/skill` to confirm discovery and `/skill <name>` to load it; when working through tools, list its metadata and load it with `skill` once it appears in the catalog. If the active model catalog has not refreshed, use `/reload`. Try a representative task and inspect the resulting files or other effects. Loading instructions alone does not demonstrate that the model follows them.

Report the location, invocation and what was checked. Keep unrelated files and user instructions intact.
