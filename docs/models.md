---
nav_order: 7
---

# Choose a model

Circle talks to a model endpoint that you provide. It does not include one. You need a base URL and an API key for any service or gateway that speaks the OpenAI chat completions API or the Anthropic messages API.

## Connect an endpoint

The first time you run `circle`, setup first asks you to choose a provider (or a custom endpoint), then asks three questions:

1. The API base URL. The chosen provider fills its SDK base URL and protocol; the URL remains editable. Keep vendor prefixes and versions, such as `/v2` or `/v1beta/openai`. DeepSeek uses `https://api.deepseek.com`. Anthropic bases accept a trailing `/v1`, which Circle removes.
2. The key. It shows as dots.
3. The model.

When Circle was set up before, an empty `enter` keeps the saved URL. It keeps the saved key only while the URL stays on the saved endpoint's host and port, such as another path on the same gateway; a URL on another host needs its key typed, so a key is never sent to a provider it was not given for.

For providers with online discovery and custom endpoints, between the key and the model Circle asks the endpoint for its model list, with a two-and-a-half-second timeout per request. OpenAI discovery tries `<base>/models` with a bearer token, then `<base>/v1/models` if the base has no version segment. Both `data[].id` and a bare array of model objects (Together) are accepted. Anthropic discovery uses `<base>/v1/models` with `x-api-key`, without doubling an existing `/v1`, with `anthropic-version: 2023-06-01`. It follows `has_more` with `after_id=last_id`, including models after the default first 20. A failed later page or repeated cursor fails discovery rather than returning a partial list. For custom endpoints, a URL containing `anthropic` makes Anthropic the first protocol tried; otherwise OpenAI is first. The URL that answered is the one saved. When the endpoint lists its models, the model question is that list: type to search it, and a model it does not list can still be used, from the row `use "…"`. When it cannot be asked, Circle asks whether the API is OpenAI-style or Anthropic-style, and you type the model id your provider documents. A typed id is not checked, and discovery failure never substitutes a preset list.

Providers without a compatible model list use an explicitly labelled list of released preset ids, selected before discovery. They do not send a model-list request. Pick an id or enter your own; the URL, protocol and chosen model are saved only after selection. The key and model are unverified until used. The preset source and date are documented in [Provider presets](development/provider-presets.md); they do not claim to be the account's online list. Azure OpenAI and Foundry require your resource URL and deployment name, so their preset lists are empty. Vertex needs a dedicated adapter and is not offered as a generic Anthropic provider.

Without the full-screen interface (`-p` or `--line` in a terminal before Circle is set up), the same questions are asked line by line, and the listed models are numbered to pick from. The desktop application asks them in its connection form; see [The desktop application](desktop.md#first-start).

The key is saved in `credentials.json` and the rest in `settings.json`. See [Settings](settings.md). `circle -m <id>` tries a model for one run without saving it.

The protocol is set by setup, never guessed from a model name: a model called `claude-…` behind an OpenAI-style gateway is sent OpenAI-style requests.

`responses` is OpenAI's Responses API. Discovery cannot tell it from an OpenAI-style endpoint, since both list models at the same path, so choose it: the `OpenAI · Responses` provider, the third kind of API when a custom endpoint cannot be asked, or `"protocol": "responses"` in `settings.json`. It uses the same key, base URL and model list as the OpenAI protocol. Requests go to `<base>/responses` with `store: false`: the endpoint keeps nothing, Circle sends the whole conversation each time, and mid-conversation system messages go as `developer` messages. Circle asks for the reasoning back encrypted (`include: ["reasoning.encrypted_content"]`) and keeps it in the session, so a reasoning model keeps its chain across tool calls. It is sent back only to the same API URL, key and model that wrote it, and only for a turn that went on to text or a tool call. An endpoint that answers HTTP 400 because it cannot read that encrypted reasoning gets the request once more without it, and that connection leaves it out from then on. An endpoint that refuses `include` is asked again without it. A tool's pictures go inside its result.

## Switch models

```text
/models                 choose from what the endpoint offers
/models qwen3.8-flash   use this id
```

`/models` (or `alt+l`) lists the models the endpoint offers, asking it with the saved protocol; when it cannot be asked, a red line says why. Type to search. `enter` uses the model for this session; `alt+d` uses it and saves it as the default for new sessions. The row for the model this session is using starts with `●` and says `current`, including when the endpoint lists it with a vendor prefix. The saved default is marked `default`. `ctrl+l` redraws the screen and does not open this list.

`/models <id>` (and `/model <id>`) sets that id for this session. The footer says `model set to <id>` for a few seconds, and the same line stays in the transcript. When the endpoint can be asked and does not list that id, both add `not listed by this endpoint`; the id is still used. To keep it, open `/models` and press `alt+d` on it. An id the endpoint rejects on a turn is shown as a short message that points back at `/models`, not as the raw error body.

`alt+m` switches to the next model for this session. It goes through the models in `enabled_models` in `settings.json`, for example `["step-3.7-flash", "step-5-*"]`, where a pattern is matched against what the endpoint lists. With no `enabled_models` it goes through every listed model. Rows in the scope are marked `in alt+m` in `/models`, and `tab` there adds the marked model to the scope or takes it out; the list is saved as `enabled_models` (for this run only when Circle was started with `--models`).

A model cannot be switched while a turn runs. The footer shows cost and context for the current model.

## Change the endpoint or the key

Type `/login` in a session. It asks the same questions as setup, on its list's own line, starting with the provider choice, then the saved or preset URL to keep or edit. An empty `enter` on the key keeps the saved key while the URL stays on the saved host; for another host it asks for the key. The session switches to the new model at once, and the connection is saved as with setup. `esc` on the key goes back to the URL; anywhere else it leaves `/login`. Nothing is saved before a model is given.

Outside a session, `circle --init` runs the same setup. Both keep your other settings. See [CLI](cli.md#setting-up-again).

`/logout` clears `credentials.json` and marks the settings as not set up, so the next start, or `/login`, asks again. On a ChatGPT plan it also signs out of ChatGPT, as below.

## Use your ChatGPT plan

The `ChatGPT plan` provider, in the terminal and in the desktop application, signs in with ChatGPT and uses your ChatGPT Plus or Pro plan in place of an API key, through OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source). Other subscriptions, such as Claude Pro or Max, cannot be used: their vendors do not allow third-party tools.

- **Signing in.** Choose `ChatGPT plan` in setup, `/login`, `circle --init` or the desktop connection form (**Continue with ChatGPT**). Circle opens your browser at OpenAI's sign-in, with a one-time address on `127.0.0.1` for the browser to come back to, and shows the address in case the browser did not open. The first time, OpenAI registers a client for Circle in your ChatGPT account and asks whether Circle may use your plan. If you decline, or the answer does not include that permission, Circle says so and nothing is sent to a model; sign in again to allow it, or use an API key. If the browser runs on another machine (Circle over SSH), the page it ends on cannot reach Circle: in the full-screen setup, `/login` or the desktop form, paste that page's address and Circle finishes the sign-in. Line setup (`circle -p` without a terminal interface) cannot take a pasted address. Circle checks the returned ID token's signature against OpenAI's published keys, its issuer, audience, expiry and the one-time `nonce`.
- **The model.** Circle lists the models your account offers (those OpenAI marks for a picker). Requests go to `https://api.openai.com/v1/responses` with the [Responses protocol](#connect-an-endpoint), `store: false`, the access token as the bearer, and these rules of the plan route: no `max_output_tokens`, Circle's tools grouped in one `circle` namespace, and the body compressed with zstd. Native web search is not used on this connection.
- **What is saved.** `settings.json` keeps `"protocol": "chatgpt"`, the base URL and the model, and no key; `credentials.json` is left as it was. The account, its issued client ID and its tokens are in `chatgpt-accounts.json` in the data folder, readable only by you (`0600`) and on the [credential list](security.md#credential-files). This machine's opaque host ID, one per machine whatever `CIRCLE_HOME` is, is in `~/.circle/agent-host-id`. History names the account only by an opaque identity, so reasoning replay survives each token renewal.
- **Renewal.** The access token lasts an hour. Circle renews it shortly before it ends, one process at a time, so two Circle processes never use the same rotating refresh token twice. If the renewal is refused because the sign-in ended (revoked, expired after 30 days unused, or used elsewhere), Circle clears the tokens, keeps the registration and asks you to sign in again. If OpenAI cannot be reached, the current token is used while it lasts.
- **Usage.** Nothing on screen marks a ChatGPT plan apart from other connections, and no cost is shown for it: the plan is not billed per token, so its calls carry no price. Usage, and Circle's own weekly limit within the plan, are in [ChatGPT settings → Usage](https://chatgpt.com/settings/usage). Plus plans share a five-hour limit across every app that uses the plan.
- **When it stops.** A usage limit stops the turn with `Usage limit reached` and the Manage usage address; Circle does not retry it or switch to another way of paying. An account or workspace that cannot use its plan in apps, a request the route does not take, and a grant that does not cover it also stop at once and say what to do. A temporary `503` from the plan route is retried like other server errors.
- **Signing out.** `/logout`, or signing out in the desktop, revokes the sign-in at OpenAI, then clears the tokens. The registration and host ID stay, so the next sign-in to that account reuses Circle's client. If OpenAI does not confirm the revocation, Circle still signs out here and says so; you can disconnect Circle in ChatGPT settings.

## Thinking depth

Circle asks models for extended thinking when the protocol supports it. The depth is one of `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.

- `/effort` lists the depths. `enter` uses one for the rest of this run; `alt+d` also saves it as `default_thinking` in `settings.json`.
- `/effort <level>` and `/thinking <level>` set it for the rest of this run.
- `alt+t` switches to the next depth.
- `--thinking <level>` sets it for one run and is never saved.
- `CIRCLE_REASONING_EFFORT` sets it for a run and wins over `default_thinking`.

For documented Claude models that support thinking summaries, Circle requests `display: "summarized"` so progress can include thinking text. That field is Anthropic-only; OpenAI-compatible endpoints are not asked for an equivalent. On both protocols, Circle maps provider reasoning into the same `thinking` field (`reasoning_content` / `reasoning` on OpenAI-compatible streams, thinking blocks on Anthropic) and maps visible progress into ordinary assistant text. The desktop transcript keeps a thinking-only step visible between tool batches when thinking is shown, rather than folding it into the tool summary. The thinking visibility switch only changes the interface; it does not change the model request, effort or output limit. An endpoint that explicitly rejects `thinking.display` is retried once without that field, keeping the remaining thinking settings. Unknown model aliases and older profiles keep their existing request format. Thinking blocks and signatures are retained as returned; ordinary text is shown only when the provider sends it.

A change applies from the next message. When the model has a depth, the header shows it after the model name, such as `step-3.7-flash • high`.

- **Anthropic protocol**: the default is `medium`. For a model whose profile lists the levels it supports, Circle sends the highest one at or below your choice. For older Claude models that take a thinking budget, the budgets are 1,024 for `minimal`, 2,048 for `low`, 8,192 for `medium`, 16,000 for `high` and `xhigh`, and 31,999 for `max`, kept below the answer limit.
- **OpenAI protocol**: nothing is sent unless you choose a depth; then it is sent as `reasoning_effort`.
- **Responses protocol**: nothing is sent unless you choose a depth; then it is sent as `reasoning: {effort, summary: "auto"}`, and the reasoning summary is shown as thinking. An endpoint that rejects `reasoning` is asked again without it.

If an endpoint rejects a parameter Circle sent (thinking, reasoning effort, stream options and a few others), Circle drops that parameter, sends the request again, and does not send it again for the rest of the session. You see one line saying so. A request drops at most four parameters.

## When a request fails

Circle retries transient failures for you. While it does, the busy line says why and which try it is on, such as `Retrying… · timeout 3/10`.

| Failure                                                                                                                                                | Retries | Gives up after |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------- |
| Timeout: no answer within `CIRCLE_LLM_TIMEOUT` (45 seconds), a stream with no content for `CIRCLE_LLM_STALL_TIMEOUT` (180 seconds), or 408, 504 or 524 | 10      | no time limit  |
| Rate limit (429)                                                                                                                                       | 5       | 10 minutes     |
| Server error (409, other 5xx)                                                                                                                          | 6       | 5 minutes      |
| Network error (connection refused, reset or dropped)                                                                                                   | 6       | 5 minutes      |
| Error inside an accepted stream                                                                                                                        | 3       | 2 minutes      |

The wait between tries doubles each time up to a cap (2 minutes for rate limits, 30 seconds otherwise). If the endpoint sends `Retry-After`, `retry-after-ms` or says how long to wait in its error message, Circle uses that. After a timeout the next try also waits twice as long for the answer to start, up to 5 minutes (Node.js's own limit), and twice as long for content in the stream, up to 8 times as long. A timeout or a dropped connection is retried even after part of the answer came: that part is dropped and the answer starts again. Other failures after the answer has started are not retried, and neither are 402, quota or billing errors, other 4xx errors, or certificate and TLS errors. When the retries run out, the error says how many were made. `esc` stops a request and a wait alike.

Additional checks protect a turn:

- A model that repeats itself while thinking is sent again with a reminder, twice at most. One that repeats itself in its answer is stopped.
- A response that ends without a complete finish signal, reaches its output limit, is filtered, pauses, or ends with an unknown reason is kept as incomplete and reported as a failure. Partial text stays in history. Tool calls in that response are not run, even if their arguments parse; matching error results keep the history balanced.
- A normally ended response with neither text nor tool calls is reported as empty. Circle does not automatically continue or resend it. You can continue with another message.
- Provider finish reasons, the actual output limit where one was sent, and client repetition stops are stored with new responses. Older records stay unchanged; a missing field is not inferred from token counts.
- An explicit provider context-window exhaustion is distinguished from an output limit. Summary attempts retain the original finish reason or provider error, request budget and available usage even when the summary cannot be used.

`CIRCLE_LLM_TIMEOUT`, `CIRCLE_LLM_STALL_TIMEOUT` and `CIRCLE_LLM_REPEAT_GUARD` change timeouts and repetition checks. See [Environment variables](environment-variables.md#model-requests).

## Cost and context in the footer

The footer shows tokens used, an estimated cost, the cache hit rate, and how full the context is.

The context window and the price come from [models.dev](https://models.dev), which lists each model once per provider: the same model can have a different window or price at another provider. Circle takes the entry of the provider whose API host is the host of your `base_url`. For providers models.dev lists without an address (Anthropic, OpenAI, Google, xAI, Mistral, Groq, Together, DeepInfra, Cerebras, Perplexity), their usual host counts. A host models.dev does not list (a gateway, a proxy, a server of your own), or one that does not list the model, is matched by the model's name instead (`claude-sonnet-4-5` through a gateway gets Anthropic's window and price).

A snapshot of models.dev ships with Circle. Once a day, when Circle starts, it fetches a newer copy in the background and keeps it in the data folder (`cache/models-dev.json`); without the network the copy or the snapshot is used. `CIRCLE_NO_MODELS_REFRESH=1` turns the fetch off.

**Context window.** `models` in [settings](settings.md#keys) sets it for a model, and `CIRCLE_MODEL_CTX` for every model; otherwise models.dev's figure is used, then a bundled model profile, then an unverified 128,000-token fallback. An unknown window is shown as `N/A`. Input limits and output limits are separate; a large context does not imply a large output allowance. Explicit smaller limits returned by a provider constrain that connection without changing saved settings.

Both protocols reserve generation room during preflight and send that allowance as the main request's output cap. The serialized provider frame is estimated once, including system text and tool definitions; internal tool-call copies are not counted again. Without a reliable count, the initial multiplier is 1.5 and can increase from that connection's usage receipts. The safety margin is 10% of the available input window, bounded to 256–16,384 tokens. These are estimates, not guarantees about an unknown tokenizer or gateway.

Summary requests send an explicit output cap. Their ordinary initial reservation is bounded by 32,000 tokens, a quarter of the context and the model's output limit; an unknown output capability starts at no more than 4,096. Older Claude thinking budgets retain their protocol constraints. Every part, merge and final resumed request is checked. A fixed prompt or tool definition set that cannot fit fails before requesting a summary. The terminal and desktop mark replacement-context estimates with `~`.

**Cost.** Pay-as-you-go prices in US dollars per million tokens: input, cached input, cache writes and output, and the long-context rates for a request over 200,000 input tokens where models.dev lists them. A cache price models.dev gives as 0 is charged as input. When the endpoint is a subscription (a coding plan or token plan, which models.dev prices at 0), the same vendor's pay-as-you-go price is shown as a reference. Each call is priced when its usage arrives and the price is stored with it, so switching models or a newer copy of models.dev does not change earlier calls. The calls a compaction or a subagent makes count in the conversation's total. It is an estimate, not a bill: a model without a price shows `N/A`, and a total that leaves out unpriced calls ends in `+`. A turn stopped with `esc` or `ctrl+c` prices the tokens it estimates when the model has rates, and that total ends with `~`. The cache meter says `cache N/A` when the endpoint omits cache fields, including a stop and a finished call that never reported them. A reported zero still reads `cache 0.0%`. A compaction attempt without a final usage receipt remains unpriced; it can also leave a `+` on a partial total. Estimated interrupted text does not itself add that marker. Prices recorded in RMB by older versions are added up separately.

Endpoints report the usage of a streamed answer in different ways. Circle counts each answer once whichever way it comes. On the Anthropic protocol, input counts ordinary input, cache reads and cache writes together.
