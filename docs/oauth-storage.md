# OAuth credential persistence

## Root cause and correction

An isolated native reproduction demonstrates this failure mechanism in the previous binding (`@napi-rs/keyring` 1.3.0). It automatically selected a Linux store for every entry. If connecting to Secret Service failed, it silently selected keyutils instead. A write could therefore fulfill in kernel memory while a subsequent entry or process searched Secret Service and found no client registration. Kernel storage also cannot preserve credentials across reboot.

The same binding converted all native password-read errors to a missing value and all deletion errors to `false`. Locked, inaccessible, ambiguous or invalid data could look like a new account or successful sign-out. Retrying OAuth or merely checking a write did not correct those underlying contracts.

pi-mcp now pins `@napi-rs/keyring` to **2.1.2** and passes `{ linux: { store: 'secret-service' } }` on every entry. An unavailable persistent store fails instead of selecting another backend. The binding preserves native errors and returns `null` only for genuine absence; pi-mcp normalizes that absence to its existing `undefined` contract. Deletion errors are never swallowed, and a separate entry must confirm removal before sign-out succeeds. Local cached-token use is blocked when sign-out begins, even if removal fails. Account generations prevent an in-flight callback or an older authorization start from undoing that block.

Issuer-bound records, service `app.prjct.pi-mcp`, credential account hashes and version-1 JSON are unchanged. State, PKCE, issuer/resource checks, credential locks, single-use code exchange and verified write readback still apply. No plaintext fallback, credential enumeration or automatic migration is added.

## Platform requirements and compatibility

- **Linux:** an unlocked freedesktop Secret Service (gnome-keyring, KWallet or KeePassXC) must be reachable over the Pi process's session D-Bus. Configure that service before requesting a new authorization link. A kernel keyring alone is no longer accepted as durable OAuth storage.
- **macOS / Windows:** the native platform stores and credential identities remain unchanged. Windows credential-lock directories are secured and independently verified using a protected owner-only DACL through noninteractive system Windows PowerShell; POSIX mode bits are not used as an ACL substitute. Unsafe existing grants, reparse points and ACL verification failures are rejected. The native API accepts but ignores Linux-specific options on these platforms.
- Existing persistent records remain readable without re-registration. Old kernel-only entries are not migrated or consulted; after enabling Secret Service, explicitly sign in once. No callback code or failed operation is automatically replayed.
- Read/unlock failures do not create a replacement client registration, erase existing records or fall back to disk. Provider text, callback values and raw native error causes are not shown in browser/Pi failure messages.

## Validation and regression coverage

```sh
npm run check
npm test
npm run test:keyring
# Optional Linux before/after reproduction; requires kernel-keyring access:
npm run test:keyring -- --reproduce-legacy-loss
npm run check:package
```

The default suite forbids OS keychain imports and tests the narrow injected native boundary. It covers persistent-store pinning, absence normalization, propagated read/write/delete failures, independently verified deletion and blocked cached tokens after failed logout.

`test:keyring` is a separate opt-in native check. On Linux it requires `dbus-run-session`, `gnome-keyring-daemon` and `gdbus`. It creates a private session bus, private temporary HOME/XDG directories and a password-protected synthetic vault. It never launches a browser, contacts a production server or reads personal credential accounts. Only its own daemon PID is stopped; encrypted fixture files are removed on completion. Personal macOS/Windows vaults are never used: both the launcher and worker require a GitHub-hosted runner; self-hosted runners are rejected.

The optional Linux reproduction writes a fresh synthetic record with the legacy binding during a simulated D-Bus outage, observes that a separate persistent reader cannot find the fulfilled write, verifies that the corrected store refuses fallback, and removes the exact synthetic kernel entry. It also compares legacy error suppression with the corrected native read. This demonstrates the mechanism without reading the original Jira record or asserting a forensic diagnosis of that real authorization attempt.

The historical 1.3.0 binding is an explicit development-only npm alias (`@napi-rs/keyring-legacy-fixture`), blocked by the ordinary test-isolation hook. It is not a runtime dependency or a fallback. The unused `@prjct.app/pi-secrets` dependency and its build link were removed; this does not alter any user's installed vault or its credentials.

The native suite uses random synthetic identities and fake HTTPS responses to prove:

1. Native 1.3.0 records retain their service/account identity and remain readable with the corrected store.
2. Independent processes and newly constructed entries see the same data.
3. On Linux, legacy registration, authorized tokens and refreshed tokens survive separate daemon restarts against the same encrypted vault.
4. A saved client completes a PKCE authorization without registering again.
5. Concurrent processes rotate a refresh token once; a later process reads the persisted token without a network request.
6. Concurrent locked updates do not lose writes.
7. Invalid native data is an error, not a missing record; unavailable D-Bus refuses all fallback without changing stored credentials.
8. Sign-out is verified by new entries and a new OAuth manager.
9. The Windows CI path rejects a dedicated synthetic lock directory with an unsafe Everyone grant.

Injected and callback tests additionally cover callback endpoint rediscovery, fragmented response bodies and sign-out interleavings.

CI runs the native suite on Linux, macOS and Windows. Local Linux validation does not by itself claim that the remote platform jobs have run or that a real Jira login succeeded.
