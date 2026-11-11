# Subagent working folder

A delegated child can be given a working folder of its own. The folder changes
where its relative paths resolve; it never changes what the child may reach.

## Contract

- `task` takes an optional `directory`. A relative request resolves from the
  folder the caller already works in, so the same request means the same thing
  from the project session and from a child that was itself given a folder.
- Omitting `directory` inherits the caller's folder. The resolved folder is
  recorded on the child session when it is created, so the foreground run, the
  background run and every resume resolve from the same place.
- A session's folder is fixed at creation. Resuming with `task_id` keeps the
  recorded folder; an explicit `directory` that differs is refused instead of
  silently moving a conversation whose earlier work happened elsewhere. A
  session created before folders were selectable keeps the project directory it
  was created in.
- The folder must exist and be a directory. `~` is expanded; nothing else is.
- A request is read by the rules of the platform the session runs on. An
  absolute path - including a Windows UNC path (`\\server\share\folder`) - names
  its own target. A relative one resolves from the caller's folder. Anything
  that leans on process state instead - `C:folder`, which follows that drive's
  current directory, and `\folder`, which follows the process's current drive -
  is refused rather than quietly resolved from somewhere the caller never named.
- Folders are compared the way the platform compares them: case-insensitively on
  Windows, exactly everywhere else. A resume that only re-spells the case is
  therefore the same task on Windows and a different folder elsewhere, where it
  is refused. (Whether `FSUtil.resolve` canonicalizes on-disk casing on
  case-insensitive non-Windows volumes such as default macOS APFS has not been
  verified on a macOS runner.)
- `read`, `grep`, `glob`, `edit`, `write` and `apply_patch` resolve relative
  paths - and, for the search tools, their default root - from the session's
  folder. When the session's folder is the project directory, `<env>` keeps
  `Working directory` unchanged; when it differs, `<env>` reports
  `Session working folder (Read, Grep, Glob, Edit, Write, ApplyPatch only)` and
  `Project directory (default Shell working directory)` separately, scopes the
  git status line to `Is project directory a git repo`, and appends an explicit
  per-tool working-directory split warning.

## Permissions

The folder is a resolution base, never a boundary:

- The instance the session runs in stays the trust anchor. Every
  `external_directory` decision is still measured against it, so a folder chosen
  outside the project - a home directory, a sibling project - is reached through
  the permissions that already gate those paths. Selecting it is not an
  authorization, and nothing adds an allow rule for it.
- Inherited restrictions are untouched: a child's ruleset still derives from its
  parent session, so a nested child cannot escape an ancestor's deny by choosing
  a folder.
- The selection is canonicalized. A folder reached through a symlink or junction
  is recorded as its real target, so an external tree can never be selected
  under an internal-looking name.
- Choosing a folder never reroots the instance, the config, the project
  detection, or the store of approvals, and never changes the process working
  directory of the parent or of a sibling.

## Not covered yet

`bash` still runs in the instance directory when the model omits `workdir`, so a
child's default shell folder does not follow its selection:

```ts
const cwd = params.workdir
  ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
  : instanceCtx.directory
```

Both branches of that line are in `packages/opencode/src/tool/shell.ts`, which
also holds the shell permission ask and the tool-id rename in flight, so it is
handed over rather than changed here.

Until it lands, the workaround differs by spelling. An absolute `workdir` is
used as given and gated by the same `external_directory` check, so a child can
reach its folder that way. A relative one does not follow the selection: it
resolves from the instance directory, because that is the base on the
`resolvePath` call above - not from the child's folder, and not from the caller's
either.

Both the child's environment prompt (`system.ts`) and the parent's `task`
description/parameter schema (`task.txt`, `task.ts`) state this split explicitly:
file/search/edit tools use the selected folder, omitted and relative shell
`workdir` values use the project directory, and shell commands meant for the
child's folder (especially destructive, write, build, or git commands) must pass
an explicit absolute `workdir` and verify target paths. Calling the child folder
`Session working folder (... only)` instead of an unqualified `Working directory`
prevents `<env>` from pairing with the shell tool's `"Commands run in the
working directory by default"` text to imply shell commands default to the
child's folder.

This prompt distinction is an honest mitigation, **not** completion of folder
support, and disclosure alone cannot make destructive shell commands safe by
runtime enforcement: because `instanceCtx.directory` is inside the project,
`external_directory` does not block an in-project shell command if a model
ignores the prompt and omits `workdir` or passes a relative `workdir`.

The coordinated runtime change is to pass the session's folder into that call
and use it as the default - `ctx.cwd ?? instanceCtx.directory` for the base, the
same value for the fallback - together with the permission work landing on that
file. It is not made here, because two owners editing that line at once is how
the shell permission ask and the rename get broken.
