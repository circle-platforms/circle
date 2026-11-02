Install a Hub pack's local tools into the shared Agent Skills root (`~/.agents/skills/<pack>/`), verifying the pack digest and every file byte-for-byte against the Hub's `/local-tools` endpoint.

Use it after `list_task_packs` or `start_run` names the pack and its digest: pass the `<id>@<version>` from the answer's `pack` field and the digest from its `pack_digest`/`digest` field. There is no token argument; Circle uses the `circle-hub` MCP server's URL and saved token.

- The whole pack tree is written (`tools/`, `functions/`, `tables/`, `SKILL.md`, `pack.json`) because tools import their package files. Circle and DeepSeek Harness both read this root, so one install serves both.
- Installing the same digest again is a no-op. A different installed version is refused; pass `replace: true` only after the user agrees, and the old tree is backed up outside the skills root.
- The returned `directory` is the skill's Base directory: run `tools/...` scripts relative to it, or use `hub_skill_run`.

What runs from this pack is the publisher's Node code: the Hub's static scan is not a sandbox. Ask the user before installing or running a pack you did not review.
