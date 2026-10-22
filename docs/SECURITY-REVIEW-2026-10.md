# Rhizomon security review, October 2026

| | |
|---|---|
| Date | 2026-10-07 |
| Commit reviewed | `fa617c76c3cc4ba3b5c6ece52a9d520a3ed2faa5` (`main`, "ci: document how maintainer auto-merge and outside review fit together"), clean working tree |
| Reviewer | Automated review session (Claude Code, security-reviewer role) at the maintainer's request |
| Result | 0 CRITICAL, 0 HIGH, 2 MEDIUM, 10 LOW, 7 INFO |

## 0. Status after the review

Fixed in the pull request that publishes this report (the first commit after the reviewed one):

- **RZ-001:** the release workflow now runs its build jobs with a read-only token; only the `publish` job can write, and
  `actions/checkout` no longer persists credentials in any workflow.
- **RZ-004 (part):** tag names, repository names and PR URLs are passed to shell steps through environment variables instead
  of being interpolated into the script text.
- **RZ-016:** the two remaining real MAC addresses (one in a README example, one in a unit test) were replaced with the
  made-up values used elsewhere. They remain in earlier commits of the public history.

Fixed on 2026-10-22, in response to the GhostAction credential-theft campaign (the repository was checked and found
clean: no injected workflow on any branch, no workflow runs during the 8 to 12 October waves, no repository secrets or deploy
keys to exfiltrate, and `cargo audit` reports no advisories against `Cargo.lock`):

- **RZ-004 (part):** all actions are pinned to commit SHAs and the repository now requires SHA pinning and allows only
  GitHub-owned actions; CI gained a `cargo audit --deny warnings` job; Dependabot is configured for `cargo` and
  `github-actions` and Dependabot alerts are enabled; `pages.yml` reads the token from `env:` instead of interpolating it into
  the script. Still open from RZ-004: the unpinned toolchain and the tag ruleset.

Everything else listed below is open and tracked by its RZ id.

## 1. Scope, method, exclusions

**Scope.** The whole repository at the commit above: the Rust agent (`src/`, `tests/`), the browser UI (`ui/`, including
`ui/vendor/`), the static site (`site/`), the CI/release/Pages workflows (`.github/`), build and data scripts (`scripts/`,
`data/`), and the documentation that makes security claims (`README.md`, `docs/PLAN.md` section 5).

**Earlier reviews.** Two earlier reviews (base code, then the enrichment diff) reported fixes for Host/Origin/Sec-Fetch-Site
guards, CSP, DNS rebinding, XSS via device strings, SQL parameterisation, subprocess hygiene, mDNS/SSDP caps, PTR recursion,
mDNS TXT spoofing, the PUT race, the NetBIOS source port and the migration transaction. Each is re-verified in section 4
rather than assumed. This review concentrates on what they did not cover: the platform layer and Linux/Windows paths, capture
mode, the traffic route and SSE event, UPnP IGD SOAP, the UI sinks and demo mode, CI/supply chain, the static site, privacy,
and local-user isolation.

**What was done.**

- Read: every file under `src/` that touches the network, a subprocess, the filesystem, the database, HTTP, or parses
  untrusted input (`platform.rs`, `discovery/*`, `traffic/*`, `web/*`, `store/*`, `config.rs`, `main.rs`, `scanner.rs`,
  `state/merge.rs` in the relevant parts, `enrich/sanitize.rs`); all of `ui/*.js` sink sites plus `index.html`, `mode.js`,
  `demo.js`, `manifest.webmanifest`; `site/index.html`; all four workflows, `CODEOWNERS`, `FUNDING.yml`; `scripts/*.sh`;
  `ui/vendor/VERSIONS`, `data/OUI_SOURCE`; README security sections; PLAN.md section 5. Spot checks of the `netdev` and
  `directories` dependency sources (subprocess use; Windows data directory).
- Run: `cargo test --locked` (all pass, about 476 tests, 5 ignored live-network tests), `cargo clippy --all-targets --locked -- -D warnings`
  (clean), `node --test ui/tests/` (99 pass). `cargo audit` and `cargo deny` are **not installed** on the review machine, so no
  RustSec advisory scan was done (see RZ-004). Checksums of vendored JS, fonts and `data/oui.csv` were recomputed and
  match `VERSIONS` / `OUI_SOURCE`. The EIP-55 checksum of the donation address was recomputed with a local Keccak-256.
  A secret-pattern grep was run over all 28 commits on all refs.
- Probed: a private instance (`--port 7995`, database under a scratch directory, with `--no-upnp --no-dns --no-netbios
  --no-tcp-probe`) was started, exercised over loopback with curl and raw sockets (Host, Origin, Sec-Fetch-*, path tricks,
  oversized body, preflight, malformed request lines, PUT with hostile strings, SSE rate, file modes), and then stopped; no
  listener or process remained on that port afterwards.

**Not done / out of scope.**

- Live runs on Linux or Windows; those paths were reviewed by reading and by the fixture tests only.
- Live `--capture` (the review machine had no tcpdump permission) and live UPnP/DNS/NetBIOS enrichment (disabled in the
  probe instance); these were reviewed by reading and by unit tests.
- Running the UI in a browser. UI behaviour was traced from source and the Node tests.
- Fuzzing; the internals of three.js / 3d-force-graph; full source audit of third-party crates; the contents of the
  `gh-pages` branch; GitHub repository settings (branch ruleset, required checks, Actions approval policy, Pages config,
  tag protection), which are not in the repository and could not be verified.
- Anything on the maintainer's LAN itself. The probe instance scanned the reviewer's own network; no device identifiers
  from it appear in this report.

## 2. Threat model

1. **Hostile LAN peer.** Anyone on the same L2 segment can send crafted ARP, ICMP, mDNS, SSDP, UPnP/HTTP, NetBIOS and DNS
   replies, spoof sources, flood, and choose names, banners and XML. Goal: XSS or code execution in the agent or UI, make the
   agent contact other hosts, poison or bloat history, or mislead the user.
2. **Hostile web page in the user's browser.** Attempts DNS rebinding, cross-origin fetch/SSE, CSRF on the one PUT, or
   framing, against `127.0.0.1:<port>`.
3. **Other local users and processes** on a shared machine: read the LAN inventory over loopback, edit names, read or
   replace the database, squat the port.
4. **The agent as an off-subnet actor.** Any packet leaving the subnet, or to a non-multicast address not chosen by
   `is_scan_target`, is a privacy and safety failure.
5. **Supply chain.** Compromised Rust crate or npm bundle, malicious or compromised contributor/automation, tampered
   release binaries or site, tampered donation address.
6. **Privilege boundary of capture mode.** `tcpdump` is the only privileged-adjacent component; Rhizomon must not become a
   route to wider capture rights.
7. **Out of the model:** an attacker who already runs code as the same user (can read the DB and ptrace the agent anyway),
   and physical access.

## 3. Findings

Ranking: CRITICAL / HIGH / MEDIUM / LOW / INFO. "Confirmed" values: **reproduced** (observed running), **traced** (followed in
source, not executed), **suspected** (plausible, not verified).

### CRITICAL

None.

### HIGH

None.

### MEDIUM

#### RZ-001 Release workflow gives a write-scoped token to the jobs that compile all dependencies

- **Where:** `.github/workflows/release.yml:10-12` (workflow-level `contents: write`, `actions: write`), `:37` (`actions/checkout@v4`
  with default `persist-credentials`), `:42-43` (`cargo build`).
- **Description:** The permissions block is at workflow level, so the six `build` matrix jobs also run with a token that can
  write contents and trigger workflows. `actions/checkout` stores that token in `.git/config` by default. `cargo build` then
  executes `build.rs` scripts and proc-macros of about 210 third-party crates (`Cargo.lock`) in the same job.
- **Impact:** Any code that runs during the build (a compromised or malicious crate version that ends up in `Cargo.lock`)
  can read the token and push to the repository, move or create tags, edit or replace release assets (the binaries users
  download), or dispatch workflows including the Pages publisher. For a network-scanning tool distributed as unsigned
  binaries this is the highest-leverage supply-chain path in the repository.
- **Confirmed:** traced.
- **Fix:** Set `permissions: contents: read` at the top of `release.yml`; give `publish` alone `contents: write` and `actions: write`.
  Use `persist-credentials: false` on every `actions/checkout` (also in `pages.yml`, where it is harmless to add). Optionally
  build in a job that has no token at all and publish from a separate job that only downloads artifacts.

#### RZ-002 Auto-merge removes the human gate for every PR authored by the owner account

- **Where:** `.github/workflows/auto-merge.yml:8-23`, `.github/CODEOWNERS:1-3`.
- **Description:** For any non-draft PR whose author is the repository owner, the workflow runs `gh pr merge --auto --squash`.
  The only gate left is "required status checks", which are configured in repository settings, not in the repo.
  CODEOWNERS review is bypassed because the author is the owner. A PR from the owner may itself edit `.github/workflows/*`,
  `Cargo.lock`, `ui/vendor/*` or `site/index.html`; a PR runs the workflows as they are in the PR, so it can weaken the very
  checks that gate it. Anything acting with the owner's credentials (a local script, a coding agent, a stolen token) gets
  the same treatment as the owner's own reviewed work.
- **Impact:** Code or content reaches `main` without a second look. `main` feeds `pages.yml` (site, demo, and the donation
  address on rhizomon.com) and is what release tags are cut from. If the ruleset does not require a status check, `--auto`
  merges at once. Not verifiable from the repo; **the maintainer must check the ruleset**.
- **Confirmed:** traced. Ruleset contents are unknown. The workflow header comment says merging waits for CI.
- **Fix:** Restrict auto-merge to PRs that do not touch sensitive paths (`.github/**`, `Cargo.toml`, `Cargo.lock`, `ui/vendor/**`,
  `site/**`, `scripts/**`, `data/**`, `README.md` donation block): add a step that lists changed files with `gh pr diff --name-only`
  and exits early, so those PRs wait for a manual merge. Require specific named status checks and signed commits in the
  ruleset, and confirm "Require approval for outside collaborators' workflow runs" is on. Pass the PR URL through `env:` rather
  than interpolating it in the script (see RZ-004). Suspected side effect to check: merges completed by auto-merge enabled
  with `GITHUB_TOKEN` may not fire `push` workflows, so `pages.yml` and CI-on-main might not run after such merges.

### LOW

#### RZ-003 Release artifacts are unsigned and unattested; the checksum shares the artifact's trust root; no verification steps are given

- **Where:** `.github/workflows/release.yml:44-63,84` (checksums generated in the same job that builds), `site/index.html:99,116`.
- **Description:** `SHA256SUMS` is published next to the binaries, in the same release, and mirrored on the same site, so it
  detects corruption but not a compromised release. There is no signature (cosign, minisign, GPG) and no build provenance
  attestation. The site links `SHA256SUMS` without saying how to check it, and tells macOS users to run
  `xattr -d com.apple.quarantine` on the binary (line 116), which removes the OS's last check on an unsigned, un-notarised binary.
- **Impact:** A user cannot establish that a downloaded binary matches the CI build of a given commit. Together with RZ-001/RZ-002,
  a tampered release would be indistinguishable from a genuine one.
- **Confirmed:** traced.
- **Fix:** Add `actions/attest-build-provenance` (or cosign keyless signing) to the publish job, and document
  `gh attestation verify` / `shasum -a 256 -c SHA256SUMS` on the site and in the README. Say plainly that the checksum is
  not a signature. Consider Developer ID signing and notarisation for macOS and Authenticode for Windows.

#### RZ-004 Workflow and dependency hygiene gaps

- **Where:** all four workflows; repository root.
- **Description:**
  - Actions are pinned by mutable major tag (`actions/checkout@v4`, `upload-artifact@v4`, `download-artifact@v4`,
    `setup-node@v4`). All are GitHub-owned, which limits the risk, but tags can move. No third-party (non-`actions/`) action is used.
  - `release.yml:85` interpolates `${{ github.ref_name }}` into a shell script that runs with `GH_TOKEN`; `auto-merge.yml:23` interpolates
    the PR URL; `pages.yml:59` feeds the release tag into `sed`. Tag names may contain shell and sed metacharacters (`"`, `$`,
    `|`, `&`, backtick). Exploiting this needs permission to push tags, which already implies write access.
  - `pages.yml:73` puts the token in the push URL (`https://x-access-token:${{ github.token }}@...`). It is masked in logs, but
    it is visible in the process list on the runner. The `gh-pages` branch is force-pushed as one commit each time, so there is
    no history to audit or roll back.
  - `rustup toolchain install stable` is unpinned (no `rust-toolchain.toml`), so release builds are not reproducible.
  - No `.github/dependabot.yml`, no `cargo audit` / `cargo deny` job (PLAN.md section 5 item 10 deferred it), and no
    tag ruleset limiting who may create `v*` tags or requiring the tagged commit to be on `main`. `cargo audit` is not
    installed on the review machine, so **no advisory scan was performed in this review**.
  - Lockfile health: `Cargo.lock` is committed, 212 packages, no git or path sources, all but the root crate carry registry checksums;
    CI uses `--locked`. Bundled SQLite is 3.53.2 (libsqlite3-sys 0.38.2).
- **Impact:** Raises the cost of a supply-chain compromise only slightly; contributes to the blast radius of RZ-001/002.
- **Confirmed:** traced.
- **Fix:** Pin actions to commit SHAs (Dependabot can keep them current). Move expressions into `env:` and quote the variable.
  Use `actions/deploy-pages` or `persist-credentials` instead of a tokenised URL. Pin the toolchain. Add Dependabot for `cargo` and
  `github-actions`, a scheduled `cargo audit` or `cargo deny` job, and a tag ruleset.

#### RZ-005 Donation address integrity depends on a cross-check that is not independent

- **Where:** `site/index.html:147-156,163-179`, `README.md:330-341`, `.github/FUNDING.yml:1`.
- **Description (what was checked):** The address `0xfb41...1481` appears exactly once in `README.md` and once in `site/index.html`,
  byte-identical, pure ASCII (no homoglyphs or zero-width characters), and its mixed-case form passes the EIP-55 checksum
  (recomputed with Keccak-256). It was introduced in a single commit (`081a849`) and has not changed. The page text instructs the reader
  to compare the site with the README character for character, and warns about network and token. The "Copy address" button copies the
  displayed text and nothing else.
- **Weakness:** the README and the site are built from the same repository by the same pipeline, so one change (or one auto-merged PR,
  RZ-002) updates both and the cross-check still passes. The site is plain HTML served from GitHub Pages and cannot set a CSP header, and
  it contains an inline script, so there is no technical barrier to injected script altering the displayed or copied value.
- **Impact:** Substitution of the address by anyone who gains write access would divert donations and would not be caught by
  the guidance as written. Financial impact is limited to donors.
- **Confirmed:** traced; the checksum and uniqueness checks were executed.
- **Fix:** Publish the address through at least one channel that does not share the repo's trust root (ENS name, the maintainer's
  GitHub profile or a signed message) and say which. Add `address in README == address in site == pinned constant` to
  `tests/repo_meta.rs` and put `site/index.html` and the README donation block under a CODEOWNERS rule that RZ-002's
  auto-merge excludes. Add a `<meta http-equiv="Content-Security-Policy">` and `<meta name="referrer" content="no-referrer">` to
  `site/index.html` (the inline script then needs a hash or to move to a file). Advise donors to send a small test amount first.

#### RZ-006 Windows default database is in the Roaming profile; no access-control hardening

- **Where:** `src/config.rs:81-82` (`ProjectDirs::from("", "", "rhizomon")` then `data_dir()`), `src/store/sqlite.rs:80-90`.
- **Description:** On Windows `data_dir()` is `%APPDATA%\rhizomon\data` (Roaming AppData; confirmed in the `directories` 6.0.0 source),
  not `%LOCALAPPDATA%`. In domain environments with roaming profiles this copies the user's LAN inventory (MACs, hostnames,
  names, notes, history) to a profile server and other machines. On Windows `create_private_file` sets no ACL; a `--db` path
  outside the user profile is readable by whoever the parent directory allows. The README is accurate that no mode bits are
  applied, but does not mention roaming.
- **Impact:** A per-machine, per-network inventory leaves the machine on roaming-profile setups, and is exposed on shared directories.
- **Confirmed:** traced (dependency source and code); not run on Windows.
- **Fix:** Use `data_local_dir()`. Document that `--db` on Windows inherits the directory's ACL, or set a protected DACL for the file.

#### RZ-007 `--db` follows symlinks and adjusts the permissions of whatever it points to

- **Where:** `src/store/sqlite.rs:68-77` (`OpenOptions::open` then `set_permissions`), `:93-103`.
- **Description:** `create_private_file` opens without `O_NOFOLLOW` and calls `set_permissions(0o600)` on the path, so through a symlink it
  chmods the target and, if the target is empty or already an SQLite file, turns it into the Rhizomon database. Only a directory that
  Rhizomon creates itself gets mode 0700 (README, Known limitations, already says `--db` does not refuse symlinks).
- **Impact:** Only for someone who passes `--db` into a directory that other users can write to (for example `/tmp`): another user
  can pre-plant a symlink to a file of the victim and cause it to be chmodded and, if empty or SQLite, overwritten with the schema.
  A non-database file is left alone (SQLite refuses it). Low likelihood.
- **Confirmed:** reproduced (appendix A.4): an empty `0644` file reached through a symlink became `0600` and an SQLite 3 database.
- **Fix:** Open with `O_NOFOLLOW`, check with `fstat` on the opened handle that it is a regular file owned by the current user, and set the
  mode with `fchmod` on that handle instead of by path. Consider refusing a `--db` whose parent directory is group- or world-writable.

#### RZ-008 The loopback API has no per-session secret; any local user or process can read it and rename devices

- **Where:** `src/web/guard.rs:87-139`, `src/web/mod.rs:57-78`; `src/main.rs` (bind).
- **Description:** The guards defend against browsers, not against other local principals. A local process can send
  `Host: 127.0.0.1:<port>` and, for the PUT, a matching `Origin` and `X-Rhizomon: 1`, with curl. On a shared machine (Linux
  server, RDS/Terminal Server, macOS fast user switching) another logged-in user can read `/api/devices`, `/api/traffic`, `/api/events` and
  edit names and notes. A second user can also bind the same port first, if Rhizomon is not running, and serve a look-alike UI at the
  URL it prints.
- **Impact:** Disclosure of a user's LAN inventory and notes to other local users; integrity of notes. Not a risk on a single-user
  desktop. The README states "loopback only" but not this multi-user consequence.
- **Confirmed:** traced; the PUT was exercised with curl using the documented headers (appendix A.2).
- **Fix:** Generate a random token per run, print it in the URL fragment or set it as an `HttpOnly; SameSite=Strict` cookie, and require it on
  every route; or serve on a user-private Unix domain socket where supported. At minimum document the limitation under Known limitations.

#### RZ-009 Info-level logs contain network identifiers, contrary to the design note

- **Where:** `src/main.rs:52` (database path), `:99-107` (interface, subnet, gateway IP), `src/scanner.rs:362` (network id, which is the gateway MAC), `src/traffic/mod.rs:427`.
- **Description:** PLAN.md section 5 item 8 says logs "contain no external identifiers". At the default `info` level stderr shows the subnet
  and gateway IP on every start and the gateway MAC when the network changes. The log from the probe instance showed `net=` and `gw=`
  values. No per-device IP, MAC, hostname or name is logged at `info`; `warn` lines carry fixed text or OS error strings; `debug` logs
  announced mDNS service types only after validation.
- **Impact:** Minor: copy-pasted logs in bug reports reveal the user's subnet and gateway. The gateway MAC, which is a stable
  hardware identifier, appears in logs only on a network change.
- **Confirmed:** reproduced (startup line) and traced.
- **Fix:** Log the subnet/gateway at `debug`, or redact the last octets and hash the network id; update PLAN.md/README if kept.

#### RZ-010 The Linux capture advice grants packet capture to every local user

- **Where:** `src/traffic/capture.rs:361` (user-facing message), `README.md:187-188`.
- **Description:** The recommended grant is `sudo setcap cap_net_raw,cap_net_admin=eip $(which tcpdump)`. The capability sits on a
  world-executable binary, so every local user, and any compromised process of any user, can capture promiscuously on every interface
  with `tcpdump`, not just Rhizomon's `-p -s 96` invocation. The alternative given (a capture group) is the safer one. The macOS advice (ChmodBPF
  group) is group-restricted and fine.
- **Impact:** Persistent privilege expansion on shared hosts: cleartext traffic of other users becomes readable by all.
- **Confirmed:** traced.
- **Fix:** Lead with the group method: `chgrp pcap /usr/bin/tcpdump; chmod 750 /usr/bin/tcpdump; setcap ...`, and
  state that the capability applies to every user who can execute the binary. Mention `NoNewPrivileges`-style sandboxing for the service case.

#### RZ-011 A spoofed SSDP source lets a LAN host aim an agent-originated HTTP GET at another in-subnet host

- **Where:** `src/discovery/upnp_parse.rs:188-230` (`validate_location`), `src/discovery/upnp.rs:37-52`, `src/discovery/ssdp.rs` (source from `recv_from`).
- **Description:** The policy requires the LOCATION host to equal the SSDP datagram's source address, which must be an in-subnet
  scan target other than this machine (`eligible_hosts`, `src/discovery/enrich.rs:95-103`). A source address on UDP is not authenticated,
  so a host on the same segment can claim another host's address and give any port and any path of up to 512 characters; the agent then
  sends one `GET <path> HTTP/1.0` to that port (query and fragment are stripped, no headers beyond Host/User-Agent/Accept, no redirects,
  response capped at 256 KB and parsed, not stored). At most 16 fetches per scan and a 30-minute failure TTL limit the rate.
  The WAN counter endpoint is only taken from the gateway's own description (`src/discovery/enrich.rs:144`), so this cannot make an arbitrary
  device the WAN source.
- **Impact:** The attacker already has L2 access and could send the request itself; the gain is that the request comes from the user's machine address,
  which matters only for LAN services that trust that address or expose state-changing GET paths. Low.
- **Confirmed:** traced.
- **Fix:** Optionally restrict the port to 80 and ports at or above 1024, restrict the path to `[A-Za-z0-9._~/%-]`, and add this to the README
  known limitations next to the other "identity data is not authenticated" lines.

#### RZ-012 The history namespace is selected by a spoofable gateway MAC; namespaces and ghost devices are not bounded globally

- **Where:** `src/state/merge.rs:87-99` (`network_id`), `src/scanner.rs:350-363`, `src/store/sqlite.rs` (no pruning).
- **Description:** The network identity is the gateway's MAC as seen in ARP. A LAN host that spoofs or flips that ARP entry makes
  the agent switch to a different history key. Each key can hold up to 2048 devices (`DEFAULT_MAX_DEVICES`), but the number of keys
  is unbounded, and every scan writes the full map of the active key. New MACs are also treated as liveness evidence
  (`merge.rs`, `ip_is_new`), so ARP-level noise creates "online" devices up to the cap. The README documents the per-network cap and the lack of
  pruning; it does not mention the unbounded number of networks.
- **Impact:** Slow database growth and misleading history/names on a hostile LAN; no code execution or disclosure.
- **Confirmed:** traced.
- **Fix:** Cap the number of stored network ids (evict least recently used) and prune devices not seen for N days; document it.

### INFO

#### RZ-013 Capture-mode details: privacy claim wording, no BPF filter, unbounded line read

- **Where:** `src/traffic/mod.rs:514-521`, `:441` and `:465`, `src/traffic/capture.rs:66-125,174-228`.
- **Description and verification:** tcpdump is started with `-i <iface> -nn -e -q -l -p -s 96 -tt` from a fixed absolute path with a
  cleared environment; the interface name is validated by `valid_iface_arg` (first character alphanumeric, `[A-Za-z0-9._-]`, at most 32)
  so it cannot be read as an option; stdin is null; `kill_on_drop` is set. The parser fails closed: any line that is not a recognisable
  Ethernet summary is dropped, IP lines whose endpoints do not parse are dropped, 802.3/LLC frames (no `ethertype`) are dropped. With `-q`
  tcpdump does not print application-layer decodes, so payload text cannot reach the parser. Off-subnet IPs are never stored: a frame with
  a non-LAN endpoint is reduced to a single `other` flow on this machine and only when the frame involves this machine's MAC; unicast flows
  require this machine on one side; flows are keyed by device id and capped (`MAX_FLOWS = 64` per sample; the accumulator is bounded by
  devices squared times protocols). Verified by reading and by the unit tests; not run live.
  - Wording: the comment at `traffic/mod.rs:516` says with `-s 96` payload "is never even copied from the kernel". A 96-byte snap length does
    copy up to about 40 bytes of TCP payload into tcpdump's memory (14 + 20 + 20 header bytes). Nothing of it is printed or stored, so the
    privacy rule holds, but the sentence and the README's "headers only" are slightly off. A snap length of about 68 would match the claim.
  - No BPF filter expression is passed, so all frames the interface delivers are decoded by tcpdump and filtered in userland. This is safe
    given the fail-closed parser, but a filter such as `ether host <self-mac> or ether broadcast or ether multicast` would shrink the data
    that ever reaches the process.
  - `BufReader::lines()` has no line-length cap; tcpdump's output under `-q` is short, so this is theoretical.
  - Spoofed source MACs let a LAN host get its own broadcast chatter attributed to another device's id; this affects display only.
- **Fix:** Reword the comment/README, optionally lower `-s`, add a BPF filter, and cap the line length.

#### RZ-014 Windows and cross-locale parsing notes

- **Where:** `src/platform.rs:42-47`, `src/discovery/arp_parse.rs:94-134`, `src/discovery/ping.rs:363-405`, `src/discovery/dns_ptr.rs:157-196`.
- **Verified:** Executables come only from `SystemRoot\System32` (or fixed Unix paths), arguments are constants or a typed `Ipv4Addr`, the
  environment is cleared to `PATH` (and `SystemRoot` on Windows), and output is capped at 1 MiB with a timeout. `/proc/net/arp`
  and `arp -a` parsers are structural, bounds-safe, drop multicast MACs and other interfaces, and treat the all-zero MAC as incomplete. The ping parser
  needs `ttl=` and `=<n>ms` / `<<n>ms` and does not trust the exit status; the German, French and Spanish samples are covered by tests.
- **Notes (none exploitable):**
  - `system_root()` trusts the process's `SystemRoot` variable (must be absolute; a UNC path is absolute). It is the same user's environment,
    so no boundary is crossed, but `GetSystemDirectoryW` is stronger.
  - Locales whose ping output uses a non-ASCII unit (for example Russian `мс`) will not match `ms`, so the `ping.exe` path would report those hosts as
    silent. Failure is closed, but liveness is lost. **Suspected**, not reproduced.
  - The Windows ARP `static` flag only recognises the English word and the `invalid` type is not filtered; neither affects security.
  - `random_ids` reads `/dev/urandom`; on Windows it always takes the `RandomState`-hasher fallback (still keyed from OS entropy). Transaction IDs are 16 bit; the DNS
    socket is `connect()`ed and NetBIOS checks source address, port and id, so the practical entropy is 16 bits plus the source port.
  - ICMP replies, like all LAN data, can be forged by a LAN peer to fake liveness.

#### RZ-015 Documentation drift in security-relevant text

- `src/discovery/ssdp.rs:5` says "LOCATION URLs are never fetched" (they are, in `upnp.rs`); `src/discovery/dns_ptr.rs:19` calls the PTR query "recursive"
  (RD is 0, test at `:298`); `Cargo.toml:5` still says "for macOS"; `README.md:104` says the ping fallback gives "RTT only, no TTL" (it parses TTL);
  `docs/PLAN.md` section 5 item 3 names `X-Rhizome` and `POST /api/scan` (now `X-Rhizomon`, `PUT .../meta`) and item 8 is untrue (RZ-009);
  and the README's collection table lists only the macOS `arp` path.
  Stale claims in security text erode trust in the accurate ones.

#### RZ-016 Possibly real device identifiers in the repository

- `README.md:139` uses a MAC whose last three octets are non-zero in the sample `curl`, and `src/enrich/oui.rs:140` contains a full six-octet
  MAC in a unit test (the other fixtures are masked as `xx:xx:xx:00:00:nn`). They look like real device identifiers (suspected, not
  confirmed). Also `tests/fixtures/*` use `192.168.0.172/.82/.194`, which are ordinary private addresses. Replace both MACs with masked ones.
  A secret-pattern grep of all history found no credentials; the only hits were `github.token` references in workflows.

#### RZ-017 No vulnerability-reporting policy

- There is no `SECURITY.md` or private reporting instruction; the site says "Reports welcome" and links to public issues. Add `SECURITY.md`
  (GitHub private vulnerability reporting) and link this review.

#### RZ-018 Vendored asset provenance and static-site headers

- `ui/vendor/VERSIONS` records version, SHA-256 and fetch date for `3d-force-graph.min.js` (1.80.1) and both fonts; all recomputed hashes match.
  `scripts/vendor-ui.sh` fetches the JS with `npm pack` and does not compare against the registry's published integrity; no script exists for the fonts
  (fetched by hand from `@fontsource/ibm-plex-mono` 5.3.0). The 1.39 MB bundle includes three.js and other libraries whose versions and licences are not
  recorded (only `LICENSE-3d-force-graph` and the font licence are shipped). The bundle contains six `new Function(` call sites that the CSP (`script-src 'self'`,
  no `unsafe-eval`) blocks; it makes no network, WebSocket or `sendBeacon` calls, and its `innerHTML` uses are the library's own (tooltip HTML from `labelFor`, which escapes).
  `data/oui.csv` matches `OUI_SOURCE` (40 305 lines). Record bundled library versions (for example from the bundle's package-lock), verify the registry
  integrity in `vendor-ui.sh`, add a font fetch script, and ship a third-party-notices file.
- `site/index.html` cannot send headers (GitHub Pages): no CSP, `frame-ancestors` or referrer policy; it has one inline script (platform highlight and a
  clipboard button) and no third-party resources. All external links are plain `https://github.com/...` or `https://rustup.rs`; none uses `target=_blank`.
  The `releases/latest/` mirror link points at a directory without an index page (suspected 404).

#### RZ-019 Local resource limits

- No cap on concurrent SSE connections, no read/header timeout on the HTTP server, and the body limit applies only to the PUT route (other routes read no body).
  Each lagging SSE client triggers a full snapshot. Only local processes can reach the port (RZ-008), so this is a local nuisance, not a remote risk. The traffic
  composer runs once a second whether or not a client is connected (cheap).

## 4. Controls verified as working

Each line: control, implementing file, how it was checked ("probe" = exercised against a live private instance over loopback; "read" = traced in source; "test" = existing test passes).

**Previously fixed items (re-verified)**

- Loopback-only bind, no flag to change it: `src/web/mod.rs` (`loopback_addr`), `src/main.rs`, test `there_is_no_bind_address_flag`; read, test.
- Host guard (exactly `127.0.0.1:<port>` or `localhost:<port>`, one Host header): `src/web/guard.rs:3-6,87-139`; probe: `evil.com`, `[::1]`, no port, duplicate Host, HTTP/1.0 without Host, `Host :` obs-fold all refused (403/400); `localhost:<port>` accepted.
- Origin guard (absent or exactly ours; `null`, other origins, duplicates refused): `guard.rs:78-86`; probe: 403 for evil, `null`, duplicate Origin.
- Sec-Fetch-Site guard (`same-origin`/`none`/absent only) with a page-navigation exemption limited to non-`/api/` GET: `guard.rs:12-29`; probe: cross-site and same-site 403, cross-site navigation to `/` 200, to `/api/status` 403; percent-encoded, `..`, double-slash and upper-case variants of `/api/` do not reach the API (404) and are not exempted.
- One state-changing route with Origin present and exact, `X-Rhizomon: 1`, checked before the body is read, 4 KiB body limit: `guard.rs:41-76`, `web/mod.rs:57-69`, `web/meta.rs`; probe: no Origin 403, no header 403, 8 KB body 413, preflight 403, unknown id 404, unknown key 400, 65-char name 400, valid 200.
- Meta input sanitisation (control, bidi, zero-width stripped; lengths 64/500; strict shape): `web/meta.rs`, `enrich/sanitize.rs:27`; probe: `<img onerror>` payload is stored as inert text with control/bidi characters removed, the UI renders text only (see below).
- PUT race: `meta_lock` held from read to commit, `src/web/api.rs:82-88`; read, test `http_meta`.
- Security headers on every response including 403 and 404 (CSP, nosniff, no-referrer, CORP same-origin, X-Frame-Options DENY, `no-store` on `/api/`): `src/web/headers.rs`; probe (headers captured).
- CSP: `script-src 'self'` (no inline/eval), `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`; `style-src 'unsafe-inline'` is documented; probe + read.
- Static file serving: relative paths only, empty/`.`/`..`/backslash segments refused, `ui/tests/*` and `package.json` excluded: `src/web/assets.rs:13-27`; probe: traversal variants and the excluded files return 404.
- XSS via device strings: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` in `ui/*.js`; panel, labels, banners, device list and traffic strings use `textContent`; the one HTML sink is the library tooltip fed by `labelFor`, which escapes `& < > " '` for every field (`ui/graph-model.js:284-299`); CSS values (`--c`, `--accent`) come from a computed colour, not from strings; read (grep of every file), test.
- SQL: all statements are static text with bound parameters, no `format!` in `src/store/`; migration static SQL in one `IMMEDIATE` transaction with a too-new schema refusal: `src/store/sqlite.rs`; read, test.
- Subprocess hygiene: fixed absolute paths, no shell, `env_clear` plus minimal env, null stdin, 1 MiB stdout / 64 KiB stderr caps, timeout, `kill_on_drop`: `src/platform.rs`, `src/discovery/cmd.rs:38-95`, `traffic/mod.rs:514-531`; read, test. Arguments are constants, a typed `Ipv4Addr`, or the interface name validated by `valid_iface_arg` (`capture.rs:333`; also applied before `ifconfig` and `/sys/class/net/<name>` in `link.rs:242`).
- PTR queries to the gateway only, RD=0, strict bounded parser, question and id matched, compression loop-limited: `src/discovery/dns_ptr.rs`; read, test (`:298`).
- NetBIOS: unicast to eligible hosts, reply must match address, port and id; parser bounds-checked: `src/discovery/netbios.rs:100-130`; read, test.
- SSDP/mDNS caps (512 total, 32 per source; 64 browsed types, 1024 cache entries, validated service-type names; TXT keys/values clipped), results filtered to the subnet: `ssdp.rs`, `mdns.rs`, `mdns_map.rs`; read, test.
- mDNS TXT identity not persisted and not used for classification: `src/state/merge.rs:380-388` and `src/scanner.rs:270-285` (fields cleared before `upsert_many`), `Device.txt_sourced` is `serde(skip)`; read, test.
- All probe destinations pass `is_scan_target` (private, in-subnet unicast, not network/broadcast/self-excluded): ICMP (`ping.rs`, both paths), TCP probe (`tcp_probe.rs`), UPnP (`validate_location`), NetBIOS and PTR targets (`enrich.rs:95-112`, which also excludes this machine), DNS server (`enrich.rs:106`). The only other destinations are multicast groups (SSDP with TTL 1 and loopback off; mDNS pinned to one interface address by `mdns-sd`). No other `send`/`connect` path exists in `src/`; read.
- UPnP fetch: `http://` to the datagram's own IPv4 literal only, no userinfo/names/schemes, control characters and spaces refused, query/fragment dropped, no redirects, 2 s/3 s timeouts, `take(256 KiB + 20 KiB)` read cap, 16 KiB header cap, chunked decoder bounded: `upnp_parse.rs:128-300`, `upnp.rs:37-52`; read, test.
- UPnP/IGD XML: `quick_xml` with DOCTYPE rejected, entities never expanded (only the five predefined and numeric references), depth 32, 20 000-event budget, unmatched end tags rejected: `upnp_parse.rs`, `wan.rs:44-82`; read, test.
- SOAP request construction: fixed action names; the service type is validated to `[A-Za-z0-9:._-]` and at most 100 chars and must start with the `WANCommonInterfaceConfig:` URN; the path has no control characters or spaces and no `..`; no user-controlled header or body text can be injected: `upnp_parse.rs:128-186`, `wan.rs:26-40`; read, test. The endpoint is accepted only from the gateway's own description, and must share its IP: `enrich.rs:140-146`.
- WAN counter handling: unsigned-integer-only parse (at most 20 digits), wrap/reset handling, implausible-rate discard, give-up after 3 failures or repeated zeros, 3 s cadence: `wan.rs`, `rate.rs`; read, test.
- Capture privacy rules (see RZ-013): no off-subnet address stored, fail-closed parsing, flow cap, `-p`, interface argument validation: `traffic/capture.rs`; read, test.
- Traffic route and SSE `traffic` event: same guards and headers as other API routes (test `the_traffic_route_has_the_same_guards_and_headers_as_the_other_api_routes`); the sample contains only host rates and interface name, link kind/rate/signal, WAN rates, per-device loss/jitter/rates keyed by device id, and capture status with flows between device ids. It adds nothing that `/api/devices` does not already show (no SSID, no remote addresses). Rate: one event per second per client (6 in 6 s, probe); broadcast channel capacity 16, lagging receivers skip; all maps are keyed by known devices and bounded.
- Demo-mode activation: `ui/mode.js`: demo is on unless the origin is exactly `http://127.0.0.1[:port]` or `http://localhost[:port]`; `?demo` always wins; `?live` only forces the non-demo path. In non-demo mode the page calls `fetch('/api/...')` and `EventSource('/api/events')`, which are relative to the page's own origin, so on `rhizomon.com` (or `file://`) `?live` can only talk to that origin (404s), never to a local agent. A real agent would also refuse any request whose Host is not loopback. Demo data is synthetic (`d0:0d:00:...` ids, `192.168.50.x`); demo mode makes no `/api/` calls; read, test (`ui/tests/demo.test.js`).
- localStorage use: only the open/closed state of the HUD sections under `rhizomon.hud.<key>`, wrapped in try/catch: `ui/traffic.js:290-306`; read. No names, notes or device data reach any storage.
- Manifest/metadata: no remote URLs, relative `start_url`/`scope`, no sensitive fields: `ui/manifest.webmanifest`, `ui/index.html`; read.
- DB location and modes: directory 0700 only when newly created, file 0600 forced on every open, rollback journal (default) inherits the mode, no WAL pragma, `.gitignore` excludes `*.db*`: `src/store/sqlite.rs`; probe (`drwx------` and `-rw-------`), test. Nothing is written outside the data directory and `--db`; no temp files of its own.
- Supply-chain records: hashes of the vendored JS, fonts and OUI list recomputed and equal to `VERSIONS` and `OUI_SOURCE`; `Cargo.lock` committed with checksums, CI builds with `--locked`; `ci.yml` has `permissions: contents: read`; `auto-merge.yml` uses `pull_request` (not `pull_request_target`), never checks out PR code and only enables auto-merge when the author equals the repository owner; no workflow uses `workflow_run`, `pull_request_target`, or a third-party action; the release job triggers the Pages job with `workflow_dispatch` because a `GITHUB_TOKEN` release does not fire `release` events; read.
- No hardcoded secrets in the tree or the history of any ref; read, grep.
- Quality gates: `cargo test --locked`, `cargo clippy --all-targets --locked -- -D warnings`, `node --test ui/tests/`; run.

## 5. Residual risks and accepted limitations

These are either already documented in the README or are inherent to scanning an untrusted LAN; the maintainer accepts them for now.

- LAN-supplied identity (mDNS names and TXT, SSDP, UPnP, DNS, NetBIOS, ICMP replies, ARP) is unauthenticated and spoofable; names and classification can be forged. README: [Known limitations](../README.md#known-limitations) (mDNS-derived identity, "not authenticated").
- mDNS (`mdns-sd`) holds UDP 5353 sockets that may receive packets from other interfaces; results are filtered to the subnet but the library does not expose the packet source. README: [Security model, Network surface](../README.md#security-model).
- The gateway might recurse a PTR query despite RD=0 and forward LAN addresses to its upstream; `--no-dns` turns it off. README: [Security model](../README.md#security-model).
- No device pruning and a 2048-device cap per network (see RZ-012 for the unbounded number of networks). README: [Known limitations](../README.md#known-limitations).
- `--db` does not validate parent directories or refuse symlinks (RZ-007). README: [Known limitations](../README.md#known-limitations).
- `style-src 'unsafe-inline'` because the vendored bundle injects `<style>`; scripts stay `'self'` only. README: [Security model, Headers](../README.md#security-model).
- Linux and Windows have not been run on a real network by the maintainers; parsers are verified with fixtures only. README: [Platform support](../README.md#platform-support) and [Known limitations](../README.md#known-limitations).
- The vendored-asset and OUI hashes prove no drift, not authenticity. README: [Known limitations](../README.md#known-limitations).
- Capture only sees traffic to or from this machine plus broadcast/multicast, and needs an OS-level grant to `tcpdump`. README: [Traffic and link quality](../README.md#traffic-and-link-quality).
- Unsigned release binaries (RZ-003) and the single-maintainer trust model.

## Appendix A. Reproductions (loopback only)

All commands target a private instance started as
`rhizomon --port 7995 --db /private/tmp/rz-probe/sub/probe.db --no-upnp --no-dns --no-netbios --no-tcp-probe`
(substitute your own port and path). Device ids below are made up; take a real id from `/api/devices`.

**A.1 Guards (expected status in brackets).**

```sh
B=http://127.0.0.1:7995
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example:7995' $B/api/devices          # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: [::1]:7995' $B/api/status                  # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: http://evil.example' $B/api/status       # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: null' $B/api/status                      # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: cross-site' $B/api/status        # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' \
     -H 'Sec-Fetch-Dest: document' $B/api/status                                                # 403
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is $B/%2e%2e/%2e%2e/etc/passwd             # 404
curl -s -o /dev/null -w '%{http_code}\n' $B/tests/index.js                                    # 404
```

**A.2 The one mutating route.**

```sh
ID='aa%3Abb%3Acc%3A00%3A00%3A01'     # made-up id: expect 404; use a real one to see 200
H=(-H 'Origin: http://127.0.0.1:7995' -H 'X-Rhizomon: 1' -H 'Content-Type: application/json')
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d '{}' $B/api/devices/$ID/meta               # 403 (no Origin, no header)
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "${H[@]}" -d '{}' $B/api/devices/$ID/meta     # 404 unknown id
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "${H[@]}" --data-binary @<(head -c 8000 /dev/zero | tr '\0' a) \
     $B/api/devices/$ID/meta                                                                    # 413
# with a real id: body '{"custom_name":"<img src=x onerror=alert(1)>\u202e\u0000evil"}' returns 200 and
# custom_name "<img src=x onerror=alert(1)>evil" (control and bidi characters removed, markup kept as inert text)
```

**A.3 Raw requests.** With Python or `nc`, send `GET /api/status HTTP/1.1` with two `Host:` lines (403), with
`Host: 127.0.0.1:7995` plus `Origin: http://127.0.0.1:7995` and `Origin: http://evil.example` (403), `HTTP/1.0` without Host (403),
and `Host : 127.0.0.1:7995` (400). An absolute-form request target with a different host but a correct `Host` header is
answered 200; the guard keys on `Host`, which is what a browser sets.

**A.4 RZ-007 symlink behaviour.**

```sh
D=/private/tmp/rz-probe/symtest; mkdir -p $D && cd $D
: > victim.dat && chmod 644 victim.dat && ln -sf $D/victim.dat link.db
ls -l victim.dat                                  # -rw-r--r--  0 bytes
rhizomon --port 7995 --db $D/link.db --no-upnp --no-dns --no-netbios --no-tcp-probe &   # stop with Ctrl-C after a few seconds
ls -l victim.dat; file victim.dat                 # -rw-------  20480 bytes, SQLite 3.x database
```

**A.5 Permissions and rate.** `ls -ld <dir> <db>` after the first start showed `drwx------` and `-rw-------`. `curl -sN $B/api/events`
for 6 seconds showed one `snapshot` event and six `traffic` events.
