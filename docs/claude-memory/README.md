# Claude memory backup

This folder is a **verbatim snapshot of Claude Code's long-term memory** for this
project — the accumulated understanding between David and Claude: working
preferences, feedback/corrections, project decisions, and open questions that are
*not* otherwise recorded in the codebase or git history.

It lives in the repo (instead of only in `~/.claude/`) so it survives a computer
change. The live memory itself is stored **outside** the repo, at:

```
~/.claude/projects/c--Users-v-normand-Workspaces-TimeCrunch-Claude/memory/
```

(`~` = your home dir, e.g. `C:\Users\<you>` on Windows.) That path is derived from
the checkout location, so it only matches if the repo lives at
`…\Workspaces\TimeCrunch_Claude`. If you clone somewhere else, the folder name
under `projects\` will differ — see "If the path is different" below.

## `MEMORY.md` is the index

`MEMORY.md` is the file Claude loads automatically each session. It's a
one-line-per-memory index; the individual `*.md` files hold the actual facts.
Everything here is plain Markdown — safe to read by hand.

## Restoring on a new computer

1. Clone the repo to `…\Workspaces\TimeCrunch_Claude` (so the derived path matches).
2. Create the memory folder if it doesn't exist:
   ```
   mkdir "%USERPROFILE%\.claude\projects\c--Users-v-normand-Workspaces-TimeCrunch-Claude\memory"
   ```
   (Git Bash: `mkdir -p ~/.claude/projects/c--Users-v-normand-Workspaces-TimeCrunch-Claude/memory`)
3. Copy every `*.md` from this folder into that memory folder **except this
   `README.md`**:
   ```
   cp docs/claude-memory/*.md ~/.claude/projects/c--Users-v-normand-Workspaces-TimeCrunch-Claude/memory/
   rm ~/.claude/projects/c--Users-v-normand-Workspaces-TimeCrunch-Claude/memory/README.md
   ```
4. Start Claude Code in the repo. It will load `MEMORY.md` and have the full
   context back.

## If the path is different

If you clone somewhere other than `…\Workspaces\TimeCrunch_Claude`, start a Claude
Code session in the repo and just ask it to "restore the memory backup from
`docs/claude-memory/`" — it can find the correct `~/.claude/projects/<hash>/memory`
folder for the new location and copy the files in.

## Keeping this fresh

This is a point-in-time snapshot. When memory changes meaningfully, re-copy the
live memory folder over this one and commit. To ask Claude: "update the memory
backup in `docs/claude-memory/`."

Snapshot last refreshed: see the commit that touched this folder (`git log -1 -- docs/claude-memory`).
