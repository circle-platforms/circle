---
name: frontend-design
description: Design and implement web or desktop frontends using the project's visual language. Use for UI creation, redesign or interaction improvements.
---

# Design a frontend

Understand the user's task, audience, content and target devices. Inspect the current screen, components, styles, assets and design rules before proposing a layout. In an existing application preserve its visual language and reuse its components and tokens. For a new design, choose a coherent hierarchy, typography, spacing and color system suited to the content; avoid filling the page with interchangeable cards or decorative effects.

Build around the main task and real content. Make the primary action and information hierarchy clear. Include the loading, empty, error and success states the task can actually encounter. Fit the layout to narrow and wide viewports without hiding essential actions or losing entered data.

Use semantic elements, accessible labels, keyboard navigation, visible focus and readable contrast. Support the themes and reduced-motion preferences the application already implements. Use images and icons that serve the content; reuse existing assets or obtain appropriate ones when available rather than inserting unrelated placeholders.

Implement within the project's framework and component structure. Do not introduce a design system, dependency or generic component layer for a single screen. Keep implementation details out of user-facing copy unless they help the user make a decision. Match the product's language conventions.

Run the application and inspect the changed flow, not only the source. Exercise representative narrow and wide layouts, supported themes, keyboard operation and the states touched by the change. Use `browser-test` for browser interactions when available; use the native app for native behavior. If visual inspection is unavailable, report that limit.

When editing Circle itself, read `docs/development/tui-contract.md` for terminal changes and `docs/development/workbench-unification.md` for desktop layout changes. Use Circle's existing theme and translation mechanisms; those are Circle-specific rules, not requirements for other projects.

Deliver the implementation with a concise account of the user-visible change and the checks performed. Keep existing behaviors outside the requested change intact.
