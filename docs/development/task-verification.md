---
parent: Development
---

# Independent task verification

`apps/desktop/src/workspace/task-verification.ts` exports `createTaskVerifier(options)`. It returns the verification callback accepted by `createAgentTaskExecutor()` and `TaskService`. Construct it when a project is authorized, before dispatching writers. Construction synchronously pins the authorized repository's commit; an agent's later commit cannot replace that policy.

The host provides an absolute workspace and an absolute `dataDir` outside the candidate project. `baseline` can select another existing commit. `runtimeExecutable` identifies the bundled Node executable, and `npmCliPath` can identify an exact npm entry point. The fallback executable is `process.execPath` for Node-hosted tests. Desktop callers must pass the bundled Node path rather than Electron. npm is resolved next to that executable at `tools/node/lib/node_modules/npm/bin/npm-cli.js`; the resolver never searches PATH for Node or npm. Missing tools produce `needs_review` evidence.

## Trusted commands

Host-supplied `checks` or a committed baseline `.circle/verification.json` can associate an exact acceptance criterion with a package script:

```json
{
  "version": 1,
  "checks": [
    {
      "criterion": "the sample produces the required output",
      "script": "test:sample",
      "cwd": "apps/sample",
      "oraclePaths": ["fixtures/sample-output.txt"]
    }
  ]
}
```

`cwd` and `oraclePaths` are workspace-relative. The named package and script must exist at the pinned baseline. Explicit oracle inputs must also be regular tracked baseline files. Host configuration is cloned at construction. The candidate's policy file is never loaded.

Without explicit configuration, the verifier selects the baseline root `check` script, or the available `typecheck`, `lint`, `test` and `build` scripts. Their criterion names are `project script: <name>`. A passing project script does not verify an unrelated natural-language acceptance criterion.

The verifier creates a temporary detached Git worktree, applies the exact hash-checked candidate patch bytes and protects baseline package scripts, workspace definitions and package configuration. It also restores baseline test source/config files, directly referenced JS/TS script files, recursively referenced npm script files and explicit oracle inputs. This prevents replacing `test` or its checked-in implementation with a successful no-op. The original candidate manifests and files remain unchanged. Added tests can be reviewed separately; they do not replace existing oracles.

Installed `node_modules` are linked from the task worktree; no installation is performed. Commands use the exact Node executable with npm's CLI entry point and argument arrays. Baseline scripts retain normal npm shell semantics. A controlled script shell puts the bundled Node directory first for nested scripts, and npm user/global configuration is isolated. These are ordinary project checks, not an operating-system sandbox for arbitrary project code or dependencies.

Pass `withBuildResource(run, signal, context)` to acquire the application's shared build resource. The task context supports `context.withResource('build', run)`, including a task already holding that resource. The verifier does not create a competing resource pool. Each command records its executable, arguments, directory, complete output and exit status, plus a separate baseline/HEAD/patch-hash evidence artifact. A nonzero exit is `failed`; infrastructure errors are `needs_review`.

Commands own a detached POSIX process group or a Windows process tree. Cancellation stops descendants and waits for owned process cleanup before releasing normal temporary worktrees. A cleanup failure is recorded for inspection and retains the verification workspace rather than continuing checks. Platform-specific process behavior still requires packaged platform regression coverage.

## Independent review

`createReviewer(task, context)` can provide a fresh `AgentRuntime` for criteria without a passing exact command oracle. The verifier rejects the worker's session, a busy session or a runtime targeting another workspace. The reviewer receives only file-reading/search tools, cannot write a plan or launch commands/children, and is closed after its judgment. Its transcript is redacted and retained as an artifact.

The reviewer must return structured judgments with exact criterion names, concrete evidence and source references. A positive or negative judgment must cite files successfully read through its actual `read_file` calls inside the task workspace. A free-form completion claim, fabricated source reference or zero-line read cannot produce a passing judgment. This is evidence-backed review, not a deterministic behavioral oracle. If no command or independent review covers a criterion, it remains `needs_review`.

The task executor independently captures changes again after verification. If the candidate changed during review, the prior evidence does not authorize that changed result.
