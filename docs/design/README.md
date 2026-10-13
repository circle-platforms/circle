# Design specifications

Circle's architecture and design are written down in a few documents. This page lists them and states their license, which differs from the code's. The documents live next to the code they describe; this folder holds the index.

| Specification | Where | What it fixes |
|---|---|---|
| Architecture | [docs/development/architecture.md](../development/architecture.md) | The module map: which part owns what, and how the agent loop, the interface, the middleware, the model guard and the safety policy fit together. |
| The TUI contract | [docs/development/tui-contract.md](../development/tui-contract.md) | The zones of the screen, what belongs in each, when it appears and who removes it, and the terms for everything on screen. Written in Chinese. |
| Desktop workbench architecture | [docs/workbench/architecture.md](../workbench/architecture.md) | The ownership between Electron main, preload and renderer, the capability bridge and the boundaries of the native runtime. |
| How Circle works | [docs/how-circle-works.md](../how-circle-works.md) | The design of the agent loop, approvals, context assembly and session storage, as the user meets it. |

Each of these documents ends with a line that names this license. The rest of `docs/`, the guides and the reference, and the code are under the [Apache License 2.0](../../LICENSE).

## License

The architecture standards, design diagrams and terminology in the documents listed above are licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Copyright (c) 2026 qingshanfeihu. Anyone who quotes, reuses, adapts or builds on these specifications, in a document, a product or another project, must keep a clear attribution to Circle and qingshanfeihu, a link to the original at <https://github.com/circle-platforms/circle/tree/main/docs/design>, a link to the CC BY 4.0 license, and a note of any changes made, as the license requires. A suitable attribution:

> Based on the Circle design specifications by qingshanfeihu, <https://github.com/circle-platforms/circle/tree/main/docs/design>, licensed under CC BY 4.0.

The license covers the specifications as texts and drawings. It grants no right to the Circle or Circle Hub names, the Circle logo or the application icons; see [NOTICE](../../NOTICE).
