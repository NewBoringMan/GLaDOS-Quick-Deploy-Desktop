# Third-party software

This application is independent of GLaDOS, GitHub and the upstream project.

## Included software

- Electron 44.6.0: MIT. Its Chromium, Node.js and other third-party notices are included in the Electron distribution.
- Puppeteer Core 25.12.0: Apache-2.0. Dependency license files are retained in the packaged dependencies.
- GitHub CLI 2.102.0: MIT. The unmodified official binary is included with its original LICENSE and is verified against the SHA-256 digest from the official GitHub release.

GitHub CLI uses its standard GitHub authorization and operating-system credential store. This application does not log out of, remove, or silently switch existing GitHub CLI accounts. It does not promise an independent keychain namespace.

## Runtime upstream

The deployment uses `lankerr/2026-glados-checkin` at commit
`b4ed1f9abeba4ef6244c0e7fd99333970b81d341`.

Upstream: https://github.com/lankerr/2026-glados-checkin

The upstream source is not bundled in this desktop application. The user's GitHub Actions runner retrieves the specified version at deployment runtime. Upstream's README mentions MIT; no standalone LICENSE file was present in the inspected tree. Attribution does not replace any rights required by the upstream authors.

The application preserves the real user-agent and session received during a manual login. It does not solve CAPTCHA, automate email verification, change browser fingerprints, or retry rejected authentication with alternate identities.
