# Project Rules

## Portable paths

- Treat `~/.agents`, `~/.claude`, and `~/.codex` as multi-device, reusable directories.
- Do not hardcode drive letters, usernames, or machine-specific home-directory paths in reusable files.
- Prefer paths relative to the project, repository, or script location whenever the target can be expressed reliably that way.
- For user-home directories outside the project, prefer `~/.agents`, `~/.claude`, and `~/.codex` over filesystem-absolute paths.
- Use an absolute path only when a runtime or tool explicitly requires one and no stable relative or home-relative form exists.
- Resolve required absolute paths during installation or bootstrap from the current device environment, then write them to local, untracked configuration. Never commit another device's resolved path.
- Any change that introduces or modifies an absolute-path requirement must update the corresponding install, migration, and validation steps in the same change.
