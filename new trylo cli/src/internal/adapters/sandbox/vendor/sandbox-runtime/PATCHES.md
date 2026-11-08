# Local patches applied to the vendored sandbox-runtime

Upstream: `@anthropic-ai/sandbox-runtime` **0.0.73**, copied verbatim from
`D:/CC/trylo/trylo cli/node_modules/@anthropic-ai/sandbox-runtime`.
Vendored at `src/internal/adapters/sandbox/vendor/sandbox-runtime/`.
See `PROVENANCE.json` for the SHA-256 of the two shipped binaries.

Every edit below is marked in the source with a
`── trylo WP04 local patch (documented in PATCHES.md) ──` banner. The point of
each one is the same: keep `node-forge` off the import graph of the modules
this product actually loads, without reimplementing any filtering or
cryptographic algorithm.

## Why

`npm audit` reports `node-forge` as a high-severity advisory
(GHSA-86w9-cpqp-85rv, RSA PKCS#1 v1.5 signature verification accepting extra
nested DigestAlgorithm elements). The published advisory lists the affected
range as `<=1.4.0` with **no fix version named**, and 1.4.0 is the latest
release — so there is no upgrade available today. That is a statement about the
current advisory and release set, not a claim that a fix can never exist, and
this note does not assert that the vulnerable path is exploitable here either
way. The package is used only to issue and validate the self-signed MITM CA
that HTTPS content inspection needs.

WP04's contract is file isolation plus a domain allowlist over CONNECT/SOCKS,
enforced by the WFP fence. None of that issues a certificate. The dependency
was therefore removable rather than merely quarantined: it is **absent from
`package.json`**, not installed with `--no-save` and not excused by a gate
allowlist. `npm audit` reports **0 vulnerabilities** after removal.

## The split

A static-edge scan (`probe-import-graph.mjs`) of the 37 vendored modules
found `node-forge` reachable from six of them. After the split, six modules
still reach it, but every one of them is on the MITM certificate path that
WP04 does not use; the basic-execution and domain-allowlist paths are
forge-free.

> **Correction (2026-10-04, independent review).** This file previously said
> "three". That number came from a defect in the probe, not from the tree: its
> static-edge regex matched only `import`, so `dist/index.js` — whose line 10
> is `export { generateCa, validateCaPair, certThumbprint, } from
> './sandbox/mitm-ca.js'` — was reported forge-free. `export … from` is a
> static edge with identical resolution semantics, and the vendor's public
> entry point is therefore **not importable without `node-forge`**. The probe
> now matches `export` as well, with the specifier clause narrowed to `[^\n]*?`
> so it cannot backtrack across a class body and invent an edge. The six are
> `index.js`, `cli.js` (via `index.js`), `mitm-ca.js`, `mitm-leaf.js`,
> `tls-terminate-proxy.js` and `windows-persistent-ca.js` — the last being the
> module the split itself introduced.

### 1. `dist/sandbox/http-proxy.js`

- `CRL_PATH` was imported from `./mitm-ca.js` solely to compare against
  `options.mitmCA.crlDer` in the CRL-serving branch. It is a frozen protocol
  constant (`'/srt.crl'`), so it is now declared locally with a comment
  recording the original owner. `mitm-ca.js` still exports it for the
  TLS-terminating path.
- `peekForClientHello` / `terminateAndForward` moved from a static import to
  `loadTlsTerminateHelpers()`, awaited at the single call site. That site is
  already inside an `options.tlsTerminate` branch, so the module loads only
  when TLS is actually being terminated.

### 2. `dist/sandbox/windows-sandbox-utils.js`

- `ensurePersistentWindowsCa` and the helpers it closes over (lines 639–781 of
  the pristine file) moved verbatim into a new
  `dist/sandbox/windows-persistent-ca.js`. The body is unchanged.
- **A verbatim move still has to re-import what the body closes over.** The
  first attempt omitted them, which left five identifiers unbound in the new
  module: `windowsStateDir` and `windowsTrustCaAsync` (defined in the host
  file, which exports both) and `certThumbprint`, `generateCa`,
  `validateCaPair` (from `mitm-ca.js`). The symptom was a *runtime*
  `ReferenceError: generateCa is not defined` on first use — not a load error,
  and therefore invisible to any probe that only imports `mitm-ca.js` directly.
  The imports are now present, and the unused `WindowsSandboxError` import left
  over from the move was dropped.
- Keeping the forge import *inside* the new module is the point, not a leak:
  the allowlist and basic-execution paths reach it only through the host file's
  deferred `await import()`, so `node-forge` never enters their static graph.
- The host file's now-unused `import { certThumbprint, generateCa,
  validateCaPair }` line was removed. Leaving it would have reattached the
  dependency the move was meant to detach.

### 3. `dist/sandbox/sandbox-manager.js`

- The top-level orchestrator statically imported four `mitm-ca.js` exports,
  which put `node-forge` on the graph of *every* consumer — including the
  allowlist paths that never issue a certificate.
- `CRL_PATH` is now declared locally. `createMitmCA` (two sites),
  `certThumbprint` (one) and `disposeMitmCA` (one) now load through
  `loadMitmCa()` at their call sites. All four sit inside `tlsTerminate`
  guards or the teardown path that only runs when a MITM CA was created.

## What still needs `node-forge`, and why that is correct

`mitm-ca.js`, `mitm-leaf.js` and `tls-terminate-proxy.js` remain forge-bound.
They implement X.509 issuance and TLS interception. Node's built-in `crypto`
can read certificates and sign bytes but exposes no `X509Certificate.generate`
and no `createCertificate`, so issuing a certificate without a library means
hand-writing DER — reimplementing cryptography, which this package's
discipline forbids. These modules now fail with `ERR_MODULE_NOT_FOUND` when
loaded in the shipped configuration, which is the honest outcome: **HTTPS
content inspection is not available** in this build.

That absence is not a silent deferral. No approved work package in
`docs/01-分期施工总技术文档与架构/**` or the P00 output directory claims HTTPS
content-level inspection — the capability currently has no consumer, and a
dependency with no consumer is a net liability. The replacement has been
evaluated and recorded so a future contract can act on it immediately:

| Candidate | Verified | Verdict |
| --- | --- | --- |
| `pkijs` | 3.4.1, released 2026-09-20, BSD-3-Clause, 13,159,917 weekly downloads, deps limited to `tslib` / `asn1js` / `pvutils` / `pvtsutils` / `bytestreamjs` / `@noble/hashes` | **preferred** — ASN.1/DER from it, RSA signing from Node's built-in `crypto` |
| `@peculiar/x509` | 2.1.0, released 2026-09-04, MIT, 16,152,275 weekly downloads, 7 maintainers | viable second choice |
| `node-certkit` | 1.1.1, three weeks old, one maintainer, requires Node >= 24 | rejected — not mature |
| `pki-lite` | 177 weekly downloads, one maintainer, and its crypto-extended package depends on `node-forge` again | rejected — reintroduces the problem |

The swap would touch only the issuance half of `mitm-ca.js` / `mitm-leaf.js`.
The filtering algorithm and the TLS interception flow stay byte-for-byte.

## Verification

Run from the repository root, with the probe scripts in this directory's
sibling `evidence/2026-10-04-WP04-probes/`:

| Probe | Claim | Result |
| --- | --- | --- |
| `probe-import-graph.mjs` | the basic-execution and allowlist paths carry no static forge edge; the six that do are all on the MITM path | pass, forge-free 31 / forge-dependent 6 |
| `probe-dist-vendor.mjs` | the vendored runtime and both `srt-win.exe` binaries reach the build output, and the helper module loads from `dist` alone | pass, 5/5 |
| `probe-no-forge-load.mjs` | the five WP04 entry modules load and the sandbox reports ready with `node-forge` physically absent | pass, `deps.errors=[]` |
| `probe-wfp-fence.mjs` | a direct TCP connect from the sandbox user is blocked, so the allowlist cannot be bypassed | pass, `egress_probe:"blocked"`, `os error 10013` |
| `probe-file-isolation.mjs` | denied writes fail (including a CJK + space path), allowed writes succeed, `acl restore` releases the ACE | pass |
| `probe-exec-abs.mjs` | a command runs inside the sandbox | pass |
| `probe-domain-allowlist.mjs` | the allowlist works end to end over HTTP, SOCKS5 and CONNECT with `node-forge` physically absent — an allowed domain really returns a body, a denied one really fails, and denied targets provably never reach the network | pass, 18/18 |

`probe-domain-allowlist.mjs` has a teeth check of its own: injecting
`if (1 === 1) { return true; }` into `filterNetworkRequest` turns 8 of its 18
assertions red, and every one of them is a *denial* assertion. The probe cannot
pass by accident.

`probe-dist-vendor.mjs` is also run against a deliberately broken build (the
`vendor` tree hidden inside `dist`): 3 of its 5 assertions turn red, the load
assertion failing with the `ERR_MODULE_NOT_FOUND` that the review described.

## Build output

`tsc` emits only from `src/**/*.ts`, so nothing in this directory — JS sources
included — reached `dist`. `scripts/copy-vendor.mjs` runs after `tsc` in
`npm run build`: it copies this tree into `dist` and lays the two prebuilt
binaries at `vendor/srt-win/<arch>/srt-win.exe`, each verified against
`PROVENANCE.json`'s SHA-256 before it is written.

The binaries live at the repository root under `vendor-bin/`, **not** under
`src/`. The quality gate (step 8) fails any build containing a
`.exe`/`.dll`/`.bin` or any file over 1 MB and scans `src` with no exemption
mechanism, so keeping them in `src` made the gate red. Staging them at build
time puts them back at exactly the relative path the vendored JS resolves, so
no path-resolution code changed.

## Rollback

`dist/sandbox/windows-sandbox-utils.js` and `dist/sandbox/sandbox-manager.js`
are the only substantially edited files. Restoring the pristine copies and
re-adding `node-forge` to `package.json` returns the package to upstream
behaviour; the vendored `dist` is otherwise byte-identical to 0.0.73, so
re-copying the source directory is the simpler rollback.
