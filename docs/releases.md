# Grouped releases

Follows pi-team's separation of integration and publication:

- Feature/fix/documentation branches start from `develop`; ordinary PRs target it.
- Only a grouped promotion PR from this repository's `develop` may target `main`.
- Use a merge commit for promotion so semantic-release sees the complete batch.
- After a release version/changelog commit, synchronize `main` back into `develop`
  through an authorized PR before starting the next batch.

## Publication

Only the Release workflow publishes, through npm trusted publishing (GitHub OIDC):
no npm token is stored anywhere, and every version carries a provenance statement.
Never run `npm publish` by hand; `prepublishOnly` refuses outside GitHub Actions.

- npmjs.com → `@prjct.app/pi-mcp` → Settings → Trusted Publisher: GitHub Actions,
  organization `prjct-app`, repository `pi-mcp`, workflow `release.yml`, no environment.
- The repository variable `PI_MCP_RELEASE_ENABLED` must equal `true`.
- To check the setup without publishing, run the Release workflow manually with
  `dry_run`: semantic-release verifies the OIDC exchange before anything else.

## Checks and versioning

The Check workflow validates PRs and pushes to `develop`/`main`. Its dependency audit includes development dependencies so vulnerable protocol fixtures or host-test dependencies cannot silently pass. The root manifest constrains Zod to `^4.6.6`, the test MCP server to `2.3.1`, Hono to `^4.13.11` and Undici to `8.12.2`. The Hono/Undici overrides keep the tested Pi peer versions unchanged; update these floors deliberately when their upstream pins are patched. Root-package overrides protect this repository's install, not the host Pi installation's dependency tree.

Native credential checks run in a Linux/macOS/Windows hosted-runner matrix with a ten-minute job limit. Linux also executes the explicit old-binding fallback reproduction against its private test vault. Configuring the matrix is not evidence that the remote OS jobs have run; require their results before releasing. Release PR policy
rejects a main-targeting branch other than the repository's `develop` branch.
Release dependencies are locked separately in `.github/release/` and excluded
from the extension package. They are not part of runtime installation.

Semantic-release selects the highest conventional-commit bump in the promoted
batch: `fix`/`perf` patch, `feat` minor, breaking changes major. As in pi-team,
`docs`, `refactor`, `build`, `ci(release)`, and `chore(deps)` request a patch.
The workflow manages version, changelog, tag, npm package and GitHub release.

```sh
npm ci --prefix .github/release --ignore-scripts
node --test .github/release/policy.test.cjs
```

Publication runs are serialized and not cancelled mid-publication. A superseded
main checkout is skipped. npm publication and GitHub tags are not a cross-service
transaction: inspect registry state and logs before retrying a failed release.
Never move an existing release tag or delete a published version to recover.

References: [semantic-release](https://semantic-release.gitbook.io/semantic-release/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
