# Skills panel

A sidebar **Skills** page for DeepSeek Harness: it lists every skill this profile
can currently reach, previews the `SKILL.md` of one, and switches a skill's
availability with one control.

## Verified version

- DSH desktop **0.2.2-rc.5** on Windows 10 22H2 x64.
- The panel and its routes (`/skills-panel/list`, `/file`, `/toggle`) were used on that build.
- Version-sensitive contracts and the upgrade checklist live in
  [docs/compatibility.md](../docs/compatibility.md).

## What it shows

- **Project** skills found in `<project>/.dsh/skills` and `<project>/.agents/skills`.
- **User and custom** skills found in `~/.dsh/skills`, `~/.agents/skills`, and any
  `customSkillDirs` a mounted filesystem provider declares.
- **Packaged** skills that ship inside DSH bundles (the Office skills and the
  bundled preset skills). These come from `app.asar` and are read-only here.
- Every live session's layer is merged in, so preset-scoped skills appear too.

Each row shows the skill name, its provider source, a two-line description, the
instruction file path, and a switch. **View SKILL.md** opens the file below the
row.

## What the switch does

DSH has no runtime enable/disable API for skills: a provider reads the
frontmatter of each `SKILL.md`. This panel therefore uses the harness's own
frontmatter contract and writes it for you:

| State | Frontmatter written |
| --- | --- |
| On | `disable-model-invocation: false`, `user-invocable: true` |
| Off | `disable-model-invocation: true`, `user-invocable: false` |

- `disable-model-invocation: true` removes the skill from the model catalog and
  the `skill` tool.
- `user-invocable: false` removes it from the `/` menu.

The filesystem provider watches skill roots, so the model catalog picks the
change up on the next step. The `/` menu keeps its own per-session catalog
cache; it re-reads after a preset switch, a plugin change, or a page reload.

**Packaged skills cannot be switched**: their files live inside `app.asar`,
which is read-only. Their switch is disabled and marked read-only.

## Limitations

- The switch rewrites the skill's own `SKILL.md`. Project skills are usually
  committed, so the change shows up in version control; the panel keeps no
  separate state and no backup.
- A skill that declares only one of the two keys, or a skill whose author
  deliberately disabled model invocation, is shown as **Partial**; switching it
  on enables both callers.
- A skill with malformed frontmatter is skipped by the provider and therefore
  never appears here.
- The panel is a profile-wide inventory. It merges the global layer with the
  layers of agents that are live at read time; a preset's skills appear only
  while a session with that preset is open.
- Bundled providers that register skills at runtime do not always publish an
  instruction-file path in their catalog summaries. Those rows show **No file**
  instead of a preview; the switch stays read-only either way.
