// A usage mistake: the CLI answers it with exit code 2.
//
// Its own module because cli.ts imports the subcommands dynamically while its own top-level
// await runs, and a subcommand that imported cli.js back would wait for cli.js to finish
// evaluating — which waits for the subcommand — and nothing would ever end.
export class UsageError extends Error {}
