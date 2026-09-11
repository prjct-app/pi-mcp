# Initial MCP client acceptance criteria

Source: the user's implementation and live-test requests in the originating Pi
conversation. This records those requirements, not a claim of external certification.

## Client and package

- Replace the previous MCP adapter with a standalone native Pi extension.
- Follow pi-team's public API, root entry, test-harness, package, and branch patterns.
- Use the official MCP SDK 2.0 and support modern/legacy negotiation.
- Reuse connections across requests and keep context/output bounded.
- Preserve project trust, cancellation, lifecycle cleanup, and secure credentials.

## Authentication and presentation

- Never open browsers or execute MCP Apps/widgets automatically.
- Detect missing OAuth credentials, return one link through the agent, and wait for
  the user to click and approve. No pasted callback URLs/codes or manual commands
  are needed on the normal path.
- Capture the callback automatically, store tokens securely, and notify the agent
  to continue. Parallel requests must share a pending flow.
- Do not depend on the previous adapter for authentication or refresh.
- Keep tool schemas available to the agent, but hide raw schemas/JSON in user-facing
  TUI rows, including expanded rows. Preserve the machine-facing payload.

## Delivery and validation

- Validate against offline fixtures and an explicitly authorized real Linear test.
- Preserve the previous adapter's configuration and credentials for rollback.
- Use a private GitHub repository; integrate through a feature PR into `develop`.
- Test locally from `develop`'s unpacked `build/`, like pi-team.
- Do not promote to `main`, enable publication, or publish until separately authorized.
