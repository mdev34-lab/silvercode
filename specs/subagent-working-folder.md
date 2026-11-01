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
  is refused.
- `read`, `grep`, `glob`, `edit`, `write` and `apply_patch` resolve relative
  paths - and, for the search tools, their default root - from the session's
  folder. The system prompt reports it as `Working directory` and keeps the
  project directory visible as `Project directory`.

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
child's default shell folder does not follow its selection. The shell tool's
default-cwd resolution belongs to the shell permission surface (the `bash` tool
id is being renamed, and the same file holds the shell permission ask), so it is
handed over rather than changed here. Until it lands, a child that needs the
shell in its own folder must pass `workdir` explicitly, which is resolved the
same way and gated the same way.
