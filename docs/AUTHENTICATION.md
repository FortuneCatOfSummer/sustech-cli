# Authentication and credential storage

`sustech-cli` separates long-lived account credentials from short-lived service
sessions. An account password may be persisted only in the operating system's
credential store. Blackboard's native calendar subscription link is handled as
a separate secret. Blackboard service cookies are cached locally with
AES-256-GCM encryption and a key derived from the account password using scrypt.
CAS ticket-granting cookies, other services' tokens, nonces, and submission state
remain in memory.

## Local desktop login

```bash
sustech auth login
sustech auth status
sustech auth check --service bb
sustech auth check --service bb --browser --interactive
sustech doctor --service bb --live --browser --interactive
sustech auth logout
```

`auth login` prompts for the SID and hides password input. It verifies the
credentials against Blackboard CAS by default and writes them only after a
successful login. Select another validation path with `--service`.

The password is never accepted as a command-line argument. For controlled
non-interactive input, provide the SID separately and redirect exactly one
password line from a secret provider into:

```bash
sustech auth login --sid 12410000 --password-stdin --service bb
```

Do not place a literal password in shell history.

Fresh CAS login is not always password-only. If CAS serves an interactive slide
CAPTCHA, the CLI stops before password submission and returns
`CAS_INTERACTIVE_CHALLENGE_REQUIRED`. It does not attempt to bypass that
challenge.

For Blackboard only, `auth check` and `doctor --live` also support a separate
read-only browser-backed verification path. Use `--browser` to request that
path, and add `--interactive` when you need to complete the CAS page manually
in the opened browser window. This path does not accept browser credentials in
the CLI. With an existing credential profile, `auth check --service bb --browser
--interactive` also saves the verified Blackboard cookies for subsequent normal
CLI commands. The browser account must match the selected profile. Without
available credentials, browser verification remains session-only.

## Blackboard session reuse

After a successful CLI login, subsequent BB commands reuse the encrypted cookie
cache instead of submitting the password to CAS again. Each new session checks
`/learn/api/public/v1/users/me` and verifies the account before using the cache.
Expired or rejected cookies are discarded and the CLI signs in again; a network
outage does not trigger another password login. CAPTCHA still requires manual
completion through the official browser page.

The cache lives under `sessions/` in the configuration directory described below,
with separate entries for each profile, SID, and service. Files use mode `0600`
and directories use `0700` on POSIX systems. Cookie expiry/deletion is respected,
and a cached login has a maximum local lifetime of seven days. Cookies refreshed
by Blackboard are saved without extending that lifetime. Changing the password
makes the old cache unreadable. If local cache storage is unavailable, the current
login can still be used in memory.

`auth logout --profile NAME` removes that profile's cached sessions as well as
its stored credentials. The CLI does not import Safari's login session. To seed
the cache while CAS requires a CAPTCHA, use the selected stored profile:

```bash
sustech auth check --service bb --browser --interactive --profile default
sustech bb courses --profile default
sustech bb deadlines --profile default
```

Only read requests may be retried after session expiry. Submission and other
write requests are never replayed automatically.

### Chrome, Edge, and Chromium

Choose a browser for a manual login, then reuse the saved session with normal
BB commands:

```bash
sustech auth check --service bb --browser --browser-channel chrome --interactive
sustech auth check --service bb --browser --browser-channel msedge --interactive
sustech bb courses
```

To reuse a browser that already exposes a local Chrome DevTools Protocol (CDP)
endpoint, select it explicitly:

```bash
sustech auth check --service bb --browser --browser-cdp-url http://127.0.0.1:9222
```

The CLI opens one BB tab in that browser's existing default context, reads only
BB-domain cookies, verifies the selected account, and saves the encrypted CLI
cache. It closes its own tab and disconnects while preserving existing tabs and
the browser. Add `--interactive` if that browser still needs a manual login.
`doctor --live --service bb --browser` accepts the same browser selectors for
diagnostics; use `auth check` to save the session.

CDP must already be enabled by the user. Endpoints are restricted to loopback
HTTP(S) or browser WebSocket URLs, without URL credentials, queries, or fragments.
HTTP discovery rejects redirects and validates the advertised WebSocket endpoint.
Chrome 136 and later require a dedicated, non-default `--user-data-dir` for
remote debugging; see the [Chrome documentation](https://developer.chrome.com/blog/remote-debugging-port).
This path therefore reuses the session in the selected CDP browser profile;
ordinary Chrome/Edge windows without a CDP endpoint are not automatically imported.

## Primo browser mode

The library catalog browser flow is separate from `auth login`:

```bash
sustech library search "graph neural networks" --browser
sustech library search "graph neural networks" --browser --interactive
sustech library detail PC:cdi_proquest_miscellaneous_1901310093 --browser
```

This mode is read-only and manual-auth only:

- the CLI does not accept a browser username, password, cookie, or token
- if Primo redirects to CAS, the user must complete that page themselves in the
  opened browser window
- the CLI does not solve CAPTCHAs or automate the challenge
- browser cookies are not persisted by the CLI

Use it when the host cannot complete the public Primo HTTP path directly or
when the record is easier to reach through the browser transport.

## Platform backends

| Platform | Backend | Persistence rule |
| --- | --- | --- |
| macOS | Keychain through the native Security framework | persistent for the current user |
| Windows | Credential Manager | persistent for the current Windows user |
| Linux desktop | freedesktop Secret Service through `secret-tool` | persistent when the user's collection is available and unlocked |
| Headless Linux, container, CI | encrypted local file (AES-256-GCM) | persistent, encrypted with a user-provided master password |

When Linux Secret Service is unavailable (no D-Bus session or `secret-tool` not
installed), the CLI automatically falls back to an encrypted local credential
store. This store uses AES-256-GCM encryption with PBKDF2 key derivation
(600,000 iterations) and requires a master password on first use.

The encrypted store is created at
`~/.config/sustech-cli/encrypted-credentials/` with file mode `0600`. The
master password is never stored on disk and must be provided for each CLI
invocation that accesses stored credentials:

```bash
# Interactive: prompted for master password on first login
sustech auth login --sid 12410000 --password-stdin

# Non-interactive: set SUSTECH_MASTER_PASSWORD environment variable
export SUSTECH_MASTER_PASSWORD="your-master-password"
sustech auth login --sid 12410000 --password-stdin

# Alternative: use explicit credentials file (no master password needed)
echo "12410000:password" > credentials.txt
chmod 600 credentials.txt
sustech --credentials-file credentials.txt bb courses
```

For non-interactive use, set `SUSTECH_MASTER_PASSWORD` or use
`--credentials-file` with explicit credentials.

`auth status` does not read the stored password when checking macOS Keychain.
It uses a metadata-only `security find-generic-password` lookup without `-w`.
Credential-helper subprocesses have a five-second deadline and are never
retried automatically. If a helper exceeds that deadline, structured status
sets `reasonCode` to `CREDENTIAL_STORE_TIMEOUT`, marks the backend unavailable
for that probe, and leaves the credential and profile metadata unchanged.

Credential writes are verified by an immediate read-back before profile
metadata is committed. Linux Secret Service errors distinguish a locked
collection, a missing desktop D-Bus/Secret Service session, an access denial,
and an unclassified `secret-tool` failure. Run `sustech auth status --json` in
the same unlocked graphical session and follow its `remediation`; do not delete
profile metadata or assume the password expired merely because the collection
is locked.

For the encrypted-file backend, decryption failures indicate an incorrect
master password and produce `MASTER_PASSWORD_INVALID`. Missing master passwords
produce `MASTER_PASSWORD_REQUIRED` with remediation mentioning
`SUSTECH_MASTER_PASSWORD` or interactive unlock. The backend does not impose a
retry limit or lockout; protect the master password accordingly. Each encrypted
credential entry uses a unique salt and initialization vector to prevent
cross-entry attacks.

`auth status`, `doctor`, and credential read paths now consistently distinguish:
backend available vs profile metadata present vs secret unlockable vs remote
auth OK. When the linux-encrypted-file backend is active, missing or incorrect
master passwords fail with stable error codes rather than generic store errors.

## Profiles

The default profile is named `default`. Multiple accounts use explicit names:

```bash
sustech auth login --profile personal
sustech auth check --profile personal --service tis
sustech bb courses --profile personal
sustech auth logout --profile personal
```

`SUSTECH_PROFILE` selects a default profile for commands that do not pass
`--profile`. Re-running `auth login` updates the password for the same SID only;
a profile cannot silently switch to a different account. Saving another named
profile never changes the implicit `default` profile.

The CLI writes non-secret profile metadata with mode `0600` where POSIX modes
exist. `XDG_CONFIG_HOME` takes precedence; otherwise the path is:

- macOS: `~/Library/Application Support/sustech-cli/credentials.json`
- Windows: `%APPDATA%\sustech-cli\credentials.json`
- Linux: `~/.config/sustech-cli/credentials.json`

This file contains the SID, credential reference, selected backend, and storage
timestamp. It never contains the password.

## Blackboard calendar links

Blackboard's native shared calendar link is not part of `auth login`. It is a
bearer-like secret in its own operating-system credential-store namespace and
is stored without on-disk profile metadata. The current namespace is
`cn.edu.sustech.cli.bb-calendar-link`, separate from the CAS credential entry.

The CLI intentionally refuses a URL command argument for this workflow. Save the
link through stdin only:

```bash
# macOS
pbpaste | sustech bb calendar-link set --url-stdin
# Windows PowerShell
Get-Clipboard | sustech bb calendar-link set --url-stdin
```

`bb calendar-link set` validates that the link is a supported Learn ICS feed on
`bb.sustech.edu.cn` before storing it. `show` masks the token by default and
requires `--reveal` to print the full link. `fetch` reads the stored secret and
either prints ICS content or writes it to an explicit destination, with
`--overwrite` required to replace an existing file. `delete` removes the stored
link for that profile.

```bash
sustech bb calendar-link show
sustech bb calendar-link show --reveal
sustech bb calendar-link fetch
sustech bb calendar-link fetch --destination ./blackboard.ics
sustech bb calendar-link delete
```

The CLI normalizes and stores the native Learn feed URL copied from Blackboard.
In practice this is usually the account-level shared calendar feed, so treat it as
an all-courses subscription for that Blackboard account unless Blackboard
itself issued a narrower feed. Because the feed is a direct secret link,
`bb calendar-link fetch` can work even when a fresh CAS login would currently
stop at `CAS_INTERACTIVE_CHALLENGE_REQUIRED`.

For the upstream UI flow, see the
[SUSTech-specific calendar-link guide](https://sustech.online/service/blackboard/retrive-ics-url/)
and Anthology's official
[Blackboard calendar documentation](https://help.anthology.com/blackboard/student/en/getting-started/calendar.html).

## Resolution precedence

Authenticated commands resolve credentials in this order:

1. explicit `--credentials-file`
2. `SUSTECH_SID` plus `SUSTECH_PASSWORD`
3. `SUSTECH_CREDENTIALS_FILE`
4. selected system credential-store profile

The first three paths are compatibility and automation overrides. Do not keep
`SUSTECH_PASSWORD` in a shell startup file; inject it only into the process that
needs it. A credentials file is plaintext and should be used only when an
external runner already protects that file.

## Failure behavior

- A missing safe backend returns `CREDENTIAL_STORE_UNAVAILABLE`.
- Invalid or corrupt profile metadata is never overwritten automatically.
- Failed remote authentication does not update the stored password.
- Metadata-write failures restore and verify the prior credential-store state;
  an unverifiable rollback fails closed with `CREDENTIAL_STORE_ROLLBACK_FAILED`.
- Keyring and session values are excluded from text, JSON, JSONL, errors, and
  capability output.
- Blackboard calendar-link storage never writes the link token into
  `credentials.json`.
- `auth logout` deletes cached sessions, the system-store item, and local profile metadata;
  it does not alter the SUSTech account itself.
