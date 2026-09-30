# AGENTS.md

Instructions for AI coding agents (Codex, Copilot, Cursor, Gemini CLI, opencode, and others) working
on this repository live in [CLAUDE.md](CLAUDE.md). They apply to every agent,
not only Claude. Read it in full before making changes. In short:

- Use no runtime dependencies. Node standard library only.
- Every version or name written to a user's file must pass `src/validate.js`.
- The remote MCP mode stays read-only. Local tools stay inside the project directory.
- Pin every workflow action to a commit SHA, with least-privilege `permissions`.
- Don't hand-edit `data/latest.json` or `VERSIONS.md`.
- Run `npm test` before you finish, and add tests for behaviour changes.
