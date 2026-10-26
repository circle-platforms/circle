import { rmSync } from 'node:fs';
// The build starts from an empty output folder, dist/ or the folder given (a test's): tsc
// never removes what a source that is gone compiled to, and the release build copies all of
// dist/, so a module Circle no longer has would still be shipped from a local build.
rmSync(process.argv[2] || 'dist', { recursive: true, force: true });
