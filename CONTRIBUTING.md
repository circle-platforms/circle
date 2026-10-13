# Contributing to Circle

Thanks for helping. This page is what you need to make a change that can be merged. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs.** Open an issue with the bug report form. Say the version, your terminal and what you did.
- **Ideas and larger changes.** Open an issue first and describe the problem you want solved. A change that reshapes how Circle looks or behaves is easier to agree on before the code exists than after.
- **Small fixes.** A small fix can go straight to a pull request.

## Set up

Circle needs Node.js 24 or newer. The TypeScript compiler and every tool are installed into the checkout.

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
npm ci
```

Run it from source with `npm run dev -- <folder>`, or build it with `npm run build` and run `node dist/cli.js <folder>`. To keep your real settings safe, point it at a scratch data folder:

```bash
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/some/project
```

Up to 0.5.0 Circle was written in Python; that code is at the tag `v0.5.0`.

## Test

```bash
npm run check          # type check, tests and build
npm run format:check   # formatting, as CI checks it
```

The suite runs in well under a minute and needs no network or model. Tests drive a scripted model or a local HTTP gateway and check real effects: the next model request, stored history, files and processes. Add a test with every behaviour change. Look at a neighbouring test for the pattern.

Some tests guard the interface and will fail if a change breaks its rules:

| Tests | Guard |
|---|---|
| `tests/render-colors.test.ts` | No colour outside the palette. |
| `tests/interface.test.ts` | Contrast on dark and light terminals, and how rows are laid out. |

## Change the interface

Read [The TUI contract](docs/development/tui-contract.md) first. In short:

- Each piece of information belongs to one zone. Do not add a new way to show something that an existing zone already covers.
- Take colours only from `palette()` in `src/ink/theme.ts`. Never write a colour code or a hex value in a component.
- Interface words are English, short and lowercase. Content (what you and the model wrote) is never translated.
- Key hints appear only where something is folded. Do not add hints for obvious keys.
- Check your change on a dark and a light background.

## Releases

Add a line under `## Unreleased` in `CHANGELOG.md` with every change a user would notice. The version is in `package.json`, `package-lock.json` and `src/version.ts`; maintainers change all three and push a tag. See [Releasing](docs/development/releasing.md).

## Change the docs

Files in `docs/` describe what the code does today. If you change behaviour, change the page that mentions it in the same pull request. State limits plainly. Do not document what does not work as if it did; put it in [Known issues](docs/known-issues.md).

## Commit messages

One short imperative sentence in English, capitalised, with no prefix and no full stop, for example `Replace subagents by name when extensions register duplicates`. Put the why in the pull request.

## Pull requests

- Keep a pull request to one change.
- Run the tests and say so in the description.
- Sign off every commit (`git commit -s`); see [Contributor terms](#contributor-terms).
- Fill in the checklist in the template.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Contributor terms

Circle is open source today, and the people behind it may later offer it under commercial terms as well, next to the open-source version. So that this stays possible without asking every contributor again, every contribution (code, tests, documentation, design, translations) is accepted on the terms below. There is no separate form to sign: submitting a contribution means you accept them.

### Sign off your commits

Every commit in a pull request carries a `Signed-off-by` line with your real name and an email address you control. `git commit -s` adds it. The line is your certification of the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

- the contribution was created in whole or in part by you, and you have the right to submit it under the licenses of this repository; or
- it is based on previous work that, to the best of your knowledge, is under a compatible open-source license, and you have the right to submit that work, with or without your changes, under the same licenses; or
- it was given to you by someone who certified one of the above, and you have not changed it;
- and you understand that the contribution, with your sign-off, is public and is kept with the project.

A pull request whose commits are not signed off is not merged.

### License to the project

You keep the copyright in your contribution. By submitting it you grant qingshanfeihu, the Circle project and any person or organization that later takes over the maintenance of Circle (together, the project owner) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright license, with the right to sublicense through several tiers, to reproduce, prepare derivative works of, publicly display, publicly perform, distribute and otherwise use your contribution and derivative works of it, under the Apache License 2.0, under CC BY 4.0, or under any other terms the project owner chooses, including commercial, proprietary and dual-license terms.

You also grant the project owner and every recipient of Circle a patent license on the terms of section 3 of the Apache License 2.0 for the patent claims you can license that your contribution infringes by itself or combined with Circle.

You confirm that you may grant these rights: if your employer or anyone else holds rights in your work, you have their permission or they have waived those rights. If the contribution includes work by others, say so in the pull request and name the license it comes under. These terms do not transfer your copyright, and they do not oblige the project owner to use your contribution.

If you cannot agree to these terms, do not submit the contribution.

## License

Circle's code and documentation are released under the [Apache License 2.0](LICENSE). The [NOTICE](NOTICE) file names the copyright holder and reserves the Circle and Circle Hub names, logos and icons, which no license here covers. The architecture and design specifications listed in [docs/design/README.md](docs/design/README.md) are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). A contribution is released under the license of the part it changes, in addition to the terms above. Versions up to 1.2.1 were released under the MIT License.
