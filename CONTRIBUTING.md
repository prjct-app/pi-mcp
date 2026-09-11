# Contributing

- Stable release branch: `main`. Integration branch: `develop`.
- Work on feature branches based on `develop`; normal PRs target `develop`.
- Only grouped `develop` → `main` promotions may target `main`; use merge commits.
- Deliver changes through a pull request using `.github/pull_request_template.md`.
- Use English for code, documentation, tests, issues, and pull requests.
- Use strict TypeScript and public Pi 0.85.1 and MCP SDK 2.0 APIs only.
- Follow pi-team's package pattern: minimal root entry, `installMcp` with injectable boundaries, immutable session snapshots, isolated harness and package-discovery tests.
- `npm run check:immutable` rejects `let` bindings under `src/`. Never capture mutable session state across an await.
- Keep README operational; put design and compatibility details in `docs/architecture.md` and `docs/package.md`.
- Pi-provided libraries are wildcard peer dependencies with exact tested devDependency versions.
- Never launch browsers or execute MCP App HTML. OAuth links may be offered automatically; opening the link and granting consent belong to the user.
- Never read real credentials or contact production MCP services in automated tests.
- Honor Pi project trust before loading project-local server commands or configuration.
- Test at the approved boundaries: the MCP client against local protocol fixtures, and the Pi extension tool/command/lifecycle API. Test parallel requests, cancellation, teardown, protocol compatibility, and zero browser launches there.
- Run `npm run check`, `npm test`, and `npm run check:package` before review.
- Never push, create or merge a PR, publish, or deploy without explicit user authorization.
