---
nav_order: 22
---

# Environment variables

Circle reads a small number of environment variables. Most tune retries and guards and never need to be set.

The model endpoint's key is **not** read from the environment. Circle reads it only from `credentials.json`. See [Models](models.md). Only the [side vision model](#side-vision-model)'s key may come from the environment, as `CIRCLE_VISION_KEY`.

## Location and mode

| Variable                 | Effect                                                                                                                                                                               | Default                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `CIRCLE_HOME`            | Where Circle keeps settings, credentials, history and sessions.                                                                                                                      | `~/.circle`                   |
| `CIRCLE_HISTORY_PATH`    | The file your prompt history is kept in.                                                                                                                                             | `history` in the data folder  |
| `CIRCLE_NO_TUI`          | `1`, `true` or `yes` forces [line mode](cli.md#full-screen-and-line-mode).                                                                                                           | unset                         |
| `CIRCLE_NO_UPDATE_CHECK` | `1`, `true`, `yes` or `on` turns off the daily [update reminder](cli.md#the-reminder).                                                                                               | unset                         |
| `OTTY_PANE_ID`           | Set by Otty in its panes. The full-screen interface then reports its state with `otty state:circle` instead of `OSC 9;4`; see [outside the window](interface.md#outside-the-window). | unset                         |
| `VISUAL`, `EDITOR`       | Used by `ctrl+g` and `/editor`, in that order. May include arguments, such as `code --wait`.                                                                                         | `vi`, or `notepad` on Windows |

## Browser

| Variable                  | Effect                                                                                                                                   | Default                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `CIRCLE_BROWSER`          | The Chrome, Edge or other Chromium-based browser the terminal's [browser tools](tools.md#the-browser) start, by the path of its program. | Chrome, then Edge, then Chromium where they are usually installed |
| `CIRCLE_BROWSER_HEADLESS` | `1` starts that browser without a window, for tests.                                                                                     | unset                                                             |

## Web access

The [web tools](tools.md#reading-and-searching), `websearch` and `webfetch`, use the same proxy configuration as Circle's other HTTPS requests. The CLI applies it at startup through `http.setGlobalProxyFromEnv` on Node.js 24.14 and later; the shipped runtime is 24.21. Set the proxy variables before starting Circle:

| Variable                         | Effect                                                                                                                                                                                                        | Default |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `HTTPS_PROXY` (or `https_proxy`) | The proxy the web tools use for their https requests. `NO_PROXY` exempts hosts from it.                                                                                                                       | unset   |
| `NODE_USE_ENV_PROXY`             | Optional for the CLI on Node.js 24.14 and later, because Circle applies the proxy itself. `1` enables Node's startup proxy handling when using `fetch` outside Circle; Node reads it when the process starts. | unset   |

This also applies to `websearch`'s native provider request and DuckDuckGo fallback. Native search uses the current model connection and credentials; there is no search-specific environment variable or API key. A proxy must allow the configured API endpoint and, when fallback is needed, `lite.duckduckgo.com` and `html.duckduckgo.com`.

## Background jobs

| Variable                     | Effect                                                                                                                                                                                                  | Default |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `CIRCLE_JOB_WAIT`            | How many seconds print mode (and RPC mode, when its input ends) waits after its answer for [background jobs](background-jobs.md) the model started. What still runs then is stopped. `0` does not wait. | `1800`  |
| `CIRCLE_JOB_OUTPUT_LIMIT_MB` | A background job that writes more output than this is stopped. Also applies to a command in the foreground.                                                                                             | `1024`  |

## Model requests

| Variable                                | Effect                                                                                                                                                                                                                                                                                                                                                                                      | Default                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `CIRCLE_REASONING_EFFORT`               | Thinking depth: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Wins over `default_thinking`; `--thinking` sets it for one run.                                                                                                                                                                                                                                                         | Anthropic protocol: `medium`; OpenAI protocol: nothing sent |
| `CIRCLE_LLM_TIMEOUT`                    | How many seconds a model request waits for the answer to start. Minimum 5. After a timeout the request is sent again and waits twice as long, up to 5 minutes. See [Reliability](how-circle-works.md#reliability).                                                                                                                                                                          | `45`                                                        |
| `CIRCLE_LLM_STALL_TIMEOUT`              | Cut a stream that has sent no content for this many seconds (keep-alives do not count), and send the request again as after a timeout; each try waits twice as long, up to 8 times as long. `0` turns it off.                                                                                                                                                                               | `180`                                                       |
| `CIRCLE_LLM_REPEAT_GUARD`               | `0`, `false`, `off` or `no` turns off the repetition guard.                                                                                                                                                                                                                                                                                                                                 | on                                                          |
| `CIRCLE_LLM_VERIFY_FINISH`              | Legacy setting; no longer changes response handling. Missing finish reasons are always recorded and reported without automatically resending the request.                                                                                                                                                                                                                                   | ignored                                                     |
| `CIRCLE_MODEL_CTX`                      | The context window in tokens for every model (`1000000` or `1_000_000`): the footer's `ctx` and where the automatic compaction starts. `models` in `settings.json` sets one model's and wins.                                                                                                                                                                                               | from models.dev                                             |
| `CIRCLE_NO_MODELS_REFRESH`              | Set to anything to stop the daily background fetch of models.dev. The snapshot shipped with Circle, or the last copy fetched, is used. See [Models](models.md#cost-and-context-in-the-footer).                                                                                                                                                                                              | fetch once a day                                            |
| `SSL_CERT_FILE`, `SSL_CERT_DIR`         | A PEM file, or folders of PEM files, of certificate authorities to trust as well as Node.js's own, for all of Circle's HTTPS requests: the model, model lists, models.dev, `webfetch`, `websearch`, the update check and `circle update`. Set one when your network inspects HTTPS. `NODE_EXTRA_CA_CERTS` works too. A file that cannot be read is reported in one line when Circle starts. | the certificates that come with Node.js                     |
| `CIRCLE_TRUST_CERTS`                    | PEM files of certificate authorities to trust for this run, separated like `PATH`, on top of [`trust_cert_files`](settings.md) and `SSL_CERT_FILE`. Circle's requests and the tools it starts get them, as with `trust_cert_files`.                                                                                                                                                         | unset                                                       |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | The proxy for those requests, and the hosts that skip it.                                                                                                                                                                                                                                                                                                                                   | no proxy                                                    |

## Side vision model

A model that does not read images can have pictures described by a side vision model: see [Images and screenshots](usage.md#images-and-screenshots). Each of the first three wins over its part of `vision` in [`settings.json`](settings.md), for one run, and none is written there. Nothing is sent unless the address, the model and the key are all set.

| Variable                   | Effect                                                                                                                                                             | Default                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `CIRCLE_VISION_BASE_URL`   | The side vision model's OpenAI-compatible endpoint, with `/v1`; Circle adds `/chat/completions`. `http` or `https`, with no user name, password, query or `#`.     | `vision.base_url`                                           |
| `CIRCLE_VISION_MODEL`      | The model id sent to it.                                                                                                                                           | `vision.model`                                              |
| `CIRCLE_VISION_KEY`        | Its key, sent as `Authorization: Bearer`. Commands Circle runs do not see it (see [What commands see](#what-commands-see)).                                        | the key in `credentials.json` named by `vision.api_key_ref` |
| `CIRCLE_VISION_TIMEOUT_MS` | How long one description may take, from sending the picture to the end of the answer, in whole milliseconds. Less than `1000`, or not a number, means the default. | `60000`                                                     |

## Agent guards

| Variable                      | Effect                                                                                                                                    | Default |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `CIRCLE_LOOP_GUARD`           | `0`, `false`, `no` or `off` turns off the loop guard.                                                                                     | on      |
| `CIRCLE_LOOP_DUP_THRESHOLD`   | The same tool call this many times among the last few triggers a reminder.                                                                | `3`     |
| `CIRCLE_LOOP_EMPTY_THRESHOLD` | This many rounds of tool calls in a row that all come back empty trigger a reminder. Calls made together in one reply count as one round. | `4`     |
| `CIRCLE_LOOP_SOFT_BUDGET`     | Tool calls in one turn before a soft note that says to carry on.                                                                          | `25`    |
| `CIRCLE_LOOP_WINDOW`          | Minimum model replies between reminders, and how many recent calls are compared.                                                          | `8`     |
| `CIRCLE_PRUNE_TOOL_OUTPUTS`   | `0`, `false`, `no` or `off` turns off pruning of old tool output.                                                                         | on      |
| `CIRCLE_PRUNE_PROTECT_TOKENS` | How much recent output stays untouched by pruning.                                                                                        | `40000` |

While background jobs the model started are running, two calls that only wait for them (a bare `sleep`, reading a job's output again, `list_jobs`) are enough for a reminder that names the jobs; the thresholds above do not change that.

## Terminal

| Variable             | Effect                                                                         | Default     |
| -------------------- | ------------------------------------------------------------------------------ | ----------- |
| `CIRCLE_TUI_SHIMMER` | `0` turns off the rainbow animation.                                           | on          |
| `CIRCLE_DEBUG`       | When set, a session-title request logs one line to stderr: `[circle] title:` and whether it was skipped, sent, renamed, discarded or why it failed. | unset       |
| `COLORFGBG`          | Light or dark fallback when the terminal does not answer the colour query.     | unset       |
| `TMUX`               | Selection copy also goes into tmux's buffer, and through tmux to the terminal. | set by tmux |
| `SSH_CONNECTION`     | Selection copy uses OSC 52 only, not a local clipboard tool.                   | set by SSH  |

## What commands see

Commands the model runs, your own `!` commands and MCP servers Circle starts get a filtered copy of the environment: any variable whose name contains a word such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` is removed. Circle never puts the API key it uses in the environment, so it does not reach them either. See [The shell environment](security.md#the-shell-environment).

## Installer and updates

| Variable           | Read by                                          | Effect                                                                                                                                 |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CIRCLE_REPO`      | `install.sh`, `install.ps1`, the update reminder | The GitHub repository to take releases from. Default `circle-platforms/circle`. `circle update` uses the one recorded at install time. |
| `CIRCLE_VERSION`   | `install.sh`, `install.ps1`                      | Install this version instead of the newest, for example `1.0.0`.                                                                       |
| `CIRCLE_PREFIX`    | `install.sh`, `install.ps1`                      | Where versions are kept. Default `~/.local/share/circle`, or `%LOCALAPPDATA%\circle` on Windows.                                       |
| `CIRCLE_BIN_DIR`   | `install.sh`, `install.ps1`                      | Where the `circle` launcher goes. Default `~/.local/bin`, or `bin` under the prefix on Windows.                                        |
| `CIRCLE_NO_PATH`   | `install.sh`, `install.ps1`                      | `1` leaves your `PATH` and shell startup file alone.                                                                                   |
| `CIRCLE_ASSET_DIR` | `install.sh`, `install.ps1`                      | Take the archive and its `.sha256` from this folder instead of GitHub. For testing.                                                    |
| `CURL_CA_BUNDLE`   | `install.sh` (through curl)                      | A PEM file of certificate authorities, for a network that inspects HTTPS.                                                              |
| `HTTPS_PROXY`      | `install.sh` (through curl), `install.ps1`       | A proxy for the download.                                                                                                              |

The launcher sets `CIRCLE_INSTALL_PREFIX` for Circle, which is how `circle update` and `circle uninstall` find their installation. See [Installation and updates](installation.md).
