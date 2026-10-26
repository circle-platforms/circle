# Circle renderer

The shared React/TypeScript interface for the Circle desktop application. Start the app through [the desktop package](../desktop/README.md).

The renderer covers conversations, tool inputs and outputs, thinking, session trees, branches, on-screen undo/redo, plans, approvals, jobs and subagents, model selection, skills, custom commands, MCP, runtime extensions and settings. It reads Circle's current slash-command definitions and palette directly, so changes can be checked against the core source.

## Composition

`CircleWorkbench` receives a session `RuntimePort`, bundled `WorkbenchPlugin` modules and a `ServiceRegistry`. Plugins register pages, drawer modes and composer actions. A native host is supplied through the isolated preload bridge.

`LiveRuntime` connects native commands and authoritative snapshots to the Circle core. Local storage holds presentation preferences and drafts; it cannot replace core-owned history or execution state. `PreviewRuntime` remains browser/layout tooling. The application registers Circle components only.

## Development

```sh
npm ci
npm run build
npm test
```

`npm run dev` is an optional browser layout tool. It does not replace the desktop entry point or native tests.

The UI uses Circle's palette and short English controls. User and model content is rendered as provided. UI components derive shared color and type tokens; raw HTML in Markdown is not executed.
