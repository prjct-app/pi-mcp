# Grouped releases

Follows pi-team's separation of integration and publication:

- Feature/fix/documentation branches start from `develop`; ordinary PRs target it.
- Only a grouped promotion PR from this repository's `develop` may target `main`.
- Use a merge commit for promotion so semantic-release sees the complete batch.
- After a release version/changelog commit, synchronize `main` back into `develop`
  through an authorized PR before starting the next batch.

## Preview safety gate

This repository is private on GitHub and the package remains `private: true`. Publishing is disabled.
The release workflow's publication jobs also require the repository variable
`PI_MCP_RELEASE_ENABLED` to equal `true`. Neither creating these files nor running
tests authorizes pushing, opening/merging a PR, or publishing.

Before enabling publication, obtain explicit user authorization, verify the
intended remote and npm identity, complete manual compatibility checks, configure
npm trusted publishing for `.github/workflows/release.yml`, remove `private: true`
in a reviewed PR, and explicitly enable the repository release variable. The private remote and integration workflow are configured; no publication
activation has been performed.

## Checks and versioning

The Check workflow validates PRs and pushes to `develop`/`main`. Release PR policy
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
