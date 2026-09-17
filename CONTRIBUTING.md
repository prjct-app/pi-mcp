# Contributing

- Stable branch: `main`. Integration branch: `develop`.
- Work on feature branches based on `develop`. Normal PRs target `develop`.
- Only grouped `develop` → `main` promotions may target `main` (merge commits).
- Use `.github/pull_request_template.md`.
- Use English for code, docs, tests, issues, and PRs.
- Strict TypeScript. Public Pi 0.85.1 and MCP SDK 2.0 APIs only.
- Follow pi-team: minimal root entry, injectable `installMcp`, immutable snapshots, isolated tests.
- `npm run check:immutable` rejects `let` in `src/`. Never capture mutable state across an await.
- README is operational. Design and compatibility go in `docs/`.
- Pi-provided libraries: wildcard peer dependencies with exact tested devDependencies.
- Never launch browsers or execute MCP App HTML.
- Never read real credentials or contact production MCP services in automated tests.
- Honor project trust before loading project-local server configuration or commands.
- Test at approved boundaries: MCP client vs local protocol fixtures, and Pi extension tool/command/lifecycle API.
- Run `npm run check`, `npm test`, `npm run check:package` before review.
- Build the compiled local copy Pi loads with `npm run build:pi`. It writes `~/.pi/agent/builds/<package>` outside the repository, because compiled code inside it would load the repository's development copy of Pi instead of the host's.
- Never push, create or merge a PR, publish, or deploy without explicit user authorization.