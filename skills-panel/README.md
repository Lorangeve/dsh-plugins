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

The page has two levels: a **list** of every skill, grouped into Project, User and
custom, Packaged and Other, and a **detail page** for a single skill. A group with
no members is hidden and each group heading carries its count.

**The list.** The header shows the title, the counters `N skills · N switchable ·
N on` and a **Refresh** button, which reads `Reading…` while a read is in flight.
Each row is a 48 px card: the skill name in monospace, its description clamped to
one line, a source badge (Project / User / Custom / Packaged / Runtime), a
**Read-only** badge when the panel may not rewrite the file, a **Partial** badge
when the two invocation switches disagree, the switch, and a chevron. Clicking
the row opens the detail page; the switch stays a separate control and only
toggles. The instruction path is not shown here; it lives on the detail page.

An empty list explains that a skill can simply be dropped into the user or
project directory, and prints both directories. A warning line appears when
discovery reports itself incomplete, and a failed read shows the reason plus a
**Retry** button.

**The detail page.** Opening a row replaces the list with that skill's page:

- A **Skills** breadcrumb at the top is the back control (`Esc` also returns to
  the list). This level has no page header of its own.
- The skill's icon, its current state (`On`, `Off` or `Partial`) and the same
  switch.
- The name with source and **Read-only** badges, the description, and the
  `SKILL.md` path in monospace.
- **Invocation** — a fact list: `Source` (the badge label, or the raw source
  string, or `—`), `Provider` (only when the skill declares one, shown as code),
  `Model can call it`, `Slash menu` and `File is writable`, each `Yes` or `No`.
- **When to use it** — the skill's `whenToUse` text, shown only when it declares
  one.
- **SKILL.md** — the file body in a scrollable block, with a **Copy** button in
  the section header. The button stays disabled until the body has arrived and
  reads `Copied` for a moment after a successful copy. A read error is reported
  in place (`Could not read SKILL.md: …`); a skill without an instruction file
  has no copy button and says `No instruction file to preview`.

Switching from either level updates the entry in place and then re-reads the
list, so the counters agree with the provider's own view.

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
  instruction-file path in their catalog summaries. Their detail page shows **No
  instruction file to preview** instead of a body and offers no copy button; with
  no path there is nothing to rewrite, so such a skill is read-only and its switch
  stays disabled.
