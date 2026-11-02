Install a pack's local tools, which a connected MCP server publishes under its `/local-tools` contract, into the shared Agent Skills root (`~/.agents/skills/<pack>/`), verifying the pack digest and every file byte-for-byte.

Use it after a server's answer names the pack and its digest: pass that server's entry name as `server`, and the `<id>@<version>` and the digest exactly as the answer gives them. There is no token argument; Circle uses that MCP server entry's URL and saved token.

- The whole pack tree is written (`tools/`, `functions/`, `tables/`, `SKILL.md`, `pack.json`) because tools import their package files. Other agents that read this root see the same install.
- Installing the same digest again is a no-op. A different installed version is refused; pass `replace: true` only after the user agrees, and the old tree is backed up outside the skills root.
- The returned `directory` is the skill's Base directory: run `tools/...` scripts relative to it, or use `skill_run`.

What runs from this pack is the publisher's Node code; a server-side scan is not a sandbox. Ask the user before installing or running a pack you did not review.
