# Claude Code mods

## Commits

Commits in this repository keep Claude Code's `Co-Authored-By` trailer, naming
the Claude model that helped, for example:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

This repository is an exception to the rule in `~/.claude/CLAUDE.md` that
drops the trailer: here it stays.

## Working on a mod

- This folder is the `local-mods` marketplace, and Claude Code reads each
  installed mod straight from its folder here. After an edit, `/reload-plugins`
  in a session loads it, with no version bump and no reinstall.
- Before a commit, run `claude plugin test <mod>` and
  `claude plugin validate <mod>` from this folder.
- Claude Code writes type declarations into `<mod>/.claude-plugin/types/` when
  it loads a mod; `.gitignore` keeps them out of the repository.
