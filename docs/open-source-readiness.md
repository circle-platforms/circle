# Open-source readiness

A record of how Circle is licensed and what protects the project's name, design and future options. Circle is open source and research-first today; the people behind it may later run it as an open-core project, with an open-source core and a commercial edition. This page says what is in place for that, where each piece is, and what still needs doing. Change it with the files it describes.

## Licensing

| What | License | Where it is stated |
|---|---|---|
| The code, the guides and the reference | [Apache License 2.0](../LICENSE) | `LICENSE`, `package.json`, the staged desktop `package.json` written by `apps/desktop/scripts/package.mjs`, `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, the site footer (`docs/_includes/nav_footer_custom.html`) |
| The architecture and design specifications | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attribution and a link to the original required | [docs/design/README.md](design/README.md) lists them; each ends with a line naming the license |
| Third-party components | Their own licenses, MIT so far | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md); the desktop build collects its dependencies' notices into `FRONTEND_NOTICES.md` with `apps/desktop/scripts/notices.mjs` |

Versions up to 1.2.1 were released under the MIT License, and the contributions received before 2026-10-13 were submitted under it. Those releases and contributions remain available under the MIT License, as `NOTICE` says. The Apache License 2.0 applies from the version after 1.2.1 on.

Apache-2.0 was chosen over MIT because it carries an express patent license and a patent-retaliation clause, requires derivative works to keep the copyright, patent, trademark and attribution notices and to mark changed files, and grants no trademark rights. It is compatible with the MIT components Circle includes.

## NOTICE

[`NOTICE`](../NOTICE) names the product, the copyright holder and the year, as section 4(d) of the Apache License expects, points at the third-party notices, states the CC BY 4.0 terms of the design specifications, and reserves the trademarks. Redistributors must carry it. It travels with the code:

- `package.json` lists it under `files`.
- `scripts/build-release.ts` copies it into the release package next to `LICENSE` and `THIRD_PARTY_NOTICES.md`.
- `apps/desktop/scripts/package.mjs` copies it into the desktop application's staging folder, so the packaged application carries it.
- `apps/desktop/scripts/msi.ts` shows `LICENSE` as the Windows installer's license page; `apps/desktop/test/msi-package.mjs` checks that the compiled MSI shows the Apache License text with the copyright holder.

## Trademarks

`NOTICE` claims "Circle", "Circle Hub", the Circle logo (`docs/images/logo.svg`) and the application icons (`apps/desktop/assets/`) as trademarks or service marks of qingshanfeihu, and says that the open-source licenses grant rights to the code and the related documentation only: no right to use the names, logos or marks, in particular to name, brand, promote or endorse a fork, a modified version, a product or a service, without express written permission. Section 6 of the Apache License already withholds trademark rights; the notice makes the marks and the rule explicit. Truthful statements that a work is derived from or works with Circle are not restricted. No registration is recorded in this repository.

## Contributor terms

[CONTRIBUTING.md](../CONTRIBUTING.md#contributor-terms) sets two conditions for every contribution:

- **A sign-off on every commit** (`git commit -s`), certifying the Developer Certificate of Origin 1.1: the contributor wrote the change or has the right to submit it, and knows the contribution and the sign-off are public.
- **A license to the project**: the contributor keeps the copyright and grants the project owner (qingshanfeihu, the Circle project, and whoever later takes over its maintenance) a perpetual, irrevocable, sublicensable copyright license to use and relicense the contribution under any terms, commercial, proprietary and dual-license terms included, with a patent license on the terms of section 3 of the Apache License 2.0, and confirms the right to grant all of this.

The pull request template has a checkbox for the sign-off. The terms are accepted by submitting; nothing is signed separately, and no CI check enforces the sign-off yet.

## Checks

Nothing in the test suite reads `LICENSE` or `NOTICE` directly. What does check this page's claims:

| Check | Verifies |
|---|---|
| `npm run check` | The release build script and the root `package.json` still compile and parse; the suite and the build run. |
| `npm run format:check` | `package.json` is formatted. `npm --prefix apps/desktop run format:check` covers the desktop scripts and tests. |
| `npm --prefix apps/desktop run test:msi` (Windows, after `package:msi`) | The compiled installer shows the Apache License text and the copyright holder. |
| `bundle exec jekyll build` in `docs/` | The site builds without the excluded `design/` index and this page. |

### Record

| Date | What was done | What was run |
|---|---|---|
| 2026-10-13 | Replaced the MIT `LICENSE` with the Apache License 2.0 (canonical text, the copyright holder in the appendix); set `license` to `Apache-2.0` in `package.json` and in the staged desktop manifest; added `NOTICE` and shipped it with the release and desktop packages; licensed the design specifications under CC BY 4.0 through `docs/design/README.md` and footers; added the contributor terms to `CONTRIBUTING.md` and the sign-off checkbox to the pull request template; updated the READMEs, the site footer, the desktop README, the MSI check and the changelog. | With Node.js 24.21.0: `npm run typecheck`, `npm test` (419 of 424 passed, 3 skipped; the two failures, in `tests/cli.test.ts` and `tests/trust-cert-files.test.ts`, read the certificate variables the build machine set and passed with those variables removed), `npm run build` and `node dist/cli.js --version`, `npm run format:check`, prettier on the changed desktop files, `bundle exec jekyll build` for the site, and `licensee detect`, which reads Apache-2.0 from `LICENSE` and from `package.json`. The MSI check runs on Windows CI only, and the desktop package was not built. |

## Open items

- **Consent of earlier contributors.** Two contributions by people other than the copyright holder (`git shortlog -s`) were made under MIT before the change. MIT work may be redistributed under Apache-2.0 with its notice kept, which `NOTICE` does; asking each of them to confirm the new terms removes any doubt.
- **Enforcement.** Add a DCO check to CI, or a CLA service, so the sign-off and the terms are confirmed by tooling rather than by review.
- **File headers.** Source files carry no SPDX or copyright header. Adding `SPDX-License-Identifier: Apache-2.0` to each would make the license survive copies of single files.
- **Trademark registration and policy.** Register the marks that matter and publish a short trademark policy (what forks may and may not call themselves). The notice reserves the marks; it does not register them.
- **Legal review.** The contributor terms, the trademark notice and the dual licensing of the specifications were written by the project, not by counsel. Have them reviewed before relying on them commercially.
- **Sibling projects.** This page covers this repository. Since 2026-10-13 [circle-hub](https://github.com/circle-platforms/circle-hub) and [circle-packs](https://github.com/circle-platforms/circle-packs) carry the same files with the same terms: the Apache-2.0 `LICENSE`, a `NOTICE` that records their MIT history, the contributor terms, the templates and a documentation site of the same shape; circle-hub's design specifications are under CC BY 4.0 as well. Each records this in its own changelog and readiness page.
