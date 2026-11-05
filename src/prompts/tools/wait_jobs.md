Wait for at least one named background job to end, for up to `timeout_s` seconds (maximum 600). Returns ended jobs' outcomes and output tails, and names jobs still running. Cancellation stops waiting.

This tool is for subagents, which receive no automatic completion turns — prefer it to polling or bare sleep. The returned notices are consumed, so the main agent does not receive them again.
