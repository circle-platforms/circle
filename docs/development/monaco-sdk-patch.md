---
parent: Development
---

# Monaco SDK cancellation patch

The workbench pins Monaco Editor 0.57.0. Its upstream MIT-licensed
`esm/vs/base/browser/ui/tree/abstractTree.js` schedules active-node changes with
`Delayer.trigger()` but does not consume the returned promise. Closing references
while this update is pending cancels the delayer and rejects that promise.

`apps/workbench/scripts/prepare-monaco.mjs` adds a catch to that one call using
Monaco's own `onUnexpectedError`. Monaco ignores its cancellation errors there;
other errors still reach its normal unexpected-error handler. Circle does not
filter renderer errors by message or hide other rejected promises.

The script checks the exact package version and complete input/output SHA-256
fingerprints. An already patched copy is accepted; any other SDK version or file
content stops preparation for review. The script runs after dependency install,
before development and builds, and before the component/editor test commands.
Both development prebundling and packaged renderer bundling therefore read the
same patched installed source. No generated SDK files are committed. Its existing
copyright and MIT license remain intact.
