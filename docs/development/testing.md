---
parent: Development
nav_order: 3
---

# Writing reliable tests

Circle's test suite (`npm test`) runs across Linux, macOS and Windows on shared virtualized CI runners where multiple test files execute concurrently. A test that passes in 50 ms on an idle developer machine can still fail on CI if it confuses wall-clock time with program state or spawns heavyweight OS process trees without bounds.

This document summarizes the five recurring CI test anti-patterns observed in Circle (`#185`, `#365`, `#391`, `#413`, `#427`, `#440`) and the rules for writing deterministic unit and integration tests.

---

## 1. Five recurring CI test anti-patterns (五类常见 CI 测试构建反模式)

| Anti-pattern (反模式类别) | Examples (典型案例) | Why it passes locally but fails on CI (本地全绿、CI 偶发失败的原因) |
| --- | --- | --- |
| **1. Treating deferred cold initialization as steady-state interaction**<br>把“懒加载/进程冷启动开销”当成“稳态交互耗时” | `#185` / `#413` (`drawer-shell.test.ts`)<br>`#440` (`browser-pipe-close.test.ts`) | Tightening timeouts (`setDefaultTimeout(10000)` or `startTimeout: 2000`, `closeTimeout: 300`) before a deferred subsystem has booted. In `drawer-shell`, clicking the first file triggers a 129-module (~22 MB) lazy load of `FileViewer` and Monaco plus its worker. In `browser-pipe-close`, the fake script sequentially booted a second full Node.js V8 runtime before opening the CDP pipe. |
| **2. Measuring algorithmic complexity with wall-clock bounds and massive heap allocations**<br>用“绝对墙钟时间 + 海量对象分配”测算法复杂度 | `#427` (`knowledge-markdown-parser.test.ts`) | Feeding 300,000 separate paragraphs (`'p\n\n'.repeat(300_000)`, 600,001 lines, ~1.8M heap objects) into the full parser and asserting `< 1500 ms` to verify a 3 ms $O(N)$ NUL-offset loop. On a busy runner, 99% of the elapsed time measures V8 garbage collection and hypervisor CPU steal rather than the target loop. |
| **3. Using raw `pause(N)` sleeps to mask unawaited async side effects, or timer animations near the deadline**<br>用 `pause(N)` 掩盖异步未收敛，或模拟定时器逼近硬上限 | `#391` (`browser-chrome-dialogs.test.ts`, `browser-chrome-snapshot-clicks.test.ts`) | Sleeping `await pause(1000)` assuming a kept download file has moved to `downloads/` (when `decideHold` returned before completion), or running a `7 × 120 ms = 840 ms` `setInterval` animation inside `settlePage`'s `1500 ms` wall-clock cap (leaving less than a 2× margin under CPU contention). |
| **4. Unbounded concurrency of heavyweight OS process trees**<br>重量级外部进程树（如真实 Chrome）跨文件无并发配额 | `#365` & `#391` (`browser-chrome-*.test.ts`) | Running 10+ `browser-chrome-*.test.ts` files in parallel spawns 60–80 Chrome subprocesses and concurrent `taskkill /PID <pid> /T /F` calls on Windows. Process-table enumeration exceeds 3 s and initial loopback (`127.0.0.1`) connections stall for 14–30 s. |
| **5. Verifying fixes only on unthrottled developer hardware**<br>缺乏本地“慢速 CI 确定性压测”验收手段 | All of the above | A 16–22 thread workstation has 10–20× more single-core headroom than a contended 2-vCPU CI VM. A test with a 2× timing margin will pass 100 times locally and still fail in the merge queue unless verified under kernel CPU throttling. |

---

## 2. Five rules for writing unit and integration tests (单元测试与集成测试编写准则)

### Rule 1: Never shrink timeouts unless the test is testing timeout expiration (非超时测试严禁人为缩窄 Timeout)

- **Use default timeouts for functional tests.** If a test verifies pipe closure, state persistence or UI layout, keep the component's standard timeouts (`START_TIMEOUT`, `CLOSE_TIMEOUT`). Do not pass `startTimeout: 2000` or `closeTimeout: 300` "because the fixture is small".
- **Test timeout handling with hanging streams, not slow processes.** When testing that a timeout triggers and cleans up properly, use an in-process stream or fake process that never answers alongside a small deadline (such as `20–50 ms`), never a race against a real process cold start.
- **Account for lazy-loaded chunks.** In browser/workbench tests, the first action that mounts a heavy lazy boundary (such as `FileViewer` / Monaco) is cold setup on par with `page.goto(..., { timeout: 0 })`. Either prewarm the chunk when the container opens or give the initial mount an uncapped setup wait before enforcing steady-state interaction timeouts.

### Rule 2: Test algorithmic complexity without wall-clock races or unrelated heap churn (性能与复杂度测试去墙钟化、小堆化)

- **Isolate the data shape under test.** To verify that line-offset NUL mapping is $O(N)$ over 300,000 lines, use a single 300,000-line block (`'p\n'.repeat(300_000)`) rather than 300,000 separate paragraph blocks (`'p\n\n'.repeat(300_000)`). Both exercise the exact same 300,000-line offset loop, while avoiding 300,000 unrelated AST block allocations and V8 major GC pauses.
- **Prefer operation counts or wide safety margins.** Where possible, assert exact structural invariants or call counts rather than `Date.now()` / `performance.now()`. When a safety time bound is kept against catastrophic $O(N^2)$ backtracking, the unthrottled baseline runtime must be `< 20 ms` against a `1500 ms` bound (at least a **50–100× margin**).

### Rule 3: Synchronize on events or state, never raw `pause(N)` (禁用裸 `pause(N)`，以事件或状态收敛为准)

- **Fix premature product resolution first.** If a test needs `await pause(1000)` after calling a product method before checking a file or state change, check whether the product method resolved before its own side effect finished (for example, `decideHold` returning before moving a kept download into `downloads/`). Fix the product method to await completion.
- **Poll on observable state when waiting for external processes.** When waiting for an asynchronous browser event (such as a late download or a dialog opening in another tab), poll until the condition holds (`await held(result)` or `until(...)`) bounded by the fixture's deadline.
- **Keep simulated timers under 1/10th of the deadline.** When a test page uses `setInterval` or `setTimeout` to exercise settle/debounce logic (such as `settlePage`'s `1500 ms` window), keep the total animation duration around `100–150 ms` (for example, `4 × 30 ms`) so it still spans multiple observation ticks while leaving >10× headroom for slow CDP round-trips.

### Rule 4: Keep fixtures lightweight and bound real-browser concurrency (轻量化测试桩与重型进程树并发受控)

- **Do not spawn nested Node.js V8 isolates for trivial shell helpers.** If a POSIX test needs a detached child process that inherits `stderr` and stays alive (`tests/browser-pipe-close.test.ts`), spawn `/bin/sh` + `exec sleep 60` (~1 ms startup, 0% CPU while sleeping) rather than a second Node.js V8 process running `setInterval`.
- **Ensure process-tree teardown falls back to the direct process handle on Windows.** On Windows under heavy process-creation load, `taskkill /PID <pid> /T /F` can time out enumerating the system process table (`TASKKILL_TIMEOUT`). When `taskkill` is killed by its timeout (`error.killed === true`), `ChromeBrowser` still terminates the owned root process handle directly (`TerminateProcess`) before verifying exit.
- **Prefer in-process fault injection (`onPhase` hooks, `ScriptedModel`, mock CDP pipes) for unit coverage.** Reserve real headless Chrome launches for true browser-integration behavior, and share browser/server fixtures within a test file where isolation allows.

### Rule 5: Reproduce and verify flaky tests under kernel CPU throttling (用内核级 CPU 限频复现与验收偶发问题)

Never close or merge a fix for a timing-sensitive failure only because it passed on an unthrottled workstation. Reproduce the failure deterministically first, then verify the fix under the same constraint:

- **Windows (Job Object CPU Rate Control):** Assign the test runner process to a Windows Job Object configured with `JobObjectCpuRateControlInformation` (`JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`, `CpuRate` set to `0.5%–6%` of total logical CPU capacity) to simulate a throttled 2-vCPU Windows runner.
- **Linux / WSL2 (cgroup v2 `cpu.max`):** Run the test inside a transient cgroup (`/sys/fs/cgroup/<name>/cpu.max`, e.g. `2500 100000` for 2.5% of one core) to deterministically expose tight startup/close timeouts (`#440`) and algorithmic bottlenecks (`#427`).
