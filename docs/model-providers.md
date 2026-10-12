# Schema-only model boundary

Creama uses Vercel AI SDK `generateText` with `Output.object` and application-side
Zod validation. There is no JSON-mode fallback, text parsing fallback, tool-based
schema emulation, or automatic provider/model switching. Native schema output
guarantees a shape, **not correct business meaning**; evidence checks and human
certification are still required.

Set `CREAMA_PROVIDER`, `CREAMA_MODEL` and the matching key in your untracked local
environment. Google remains the default (`gemini-3.8-flash`). Other providers
require an explicit model. Supported model families are deliberately restricted
in `core/model.ts`; arbitrary names and modalities are rejected before a call.

| Provider | Key | Example approved model | Wire format |
| --- | --- | --- | --- |
| google | GEMINI_API_KEY or GOOGLE_API_KEY | gemini-3.8-flash | JSON MIME type + response schema |
| openai | OPENAI_API_KEY | gpt-4.1 | json_schema, strict=true |
| xai | XAI_API_KEY | grok-4.3 | json_schema, strict=true |
| anthropic | ANTHROPIC_API_KEY | claude-sonnet-4-5 | output_config.format=json_schema |

Availability and account access remain provider-dependent. Offline contract tests
inspect the actual adapter request bodies; they do **not** prove live access or
support for every model in every account. Provider errors fail the run without
silently downgrading output. Unsupported-schema warnings are rejected even if the
returned JSON happens to validate. No remote capability probe or paid model call
runs automatically at startup.

DeepSeek and arbitrary OpenAI-compatible endpoints are currently **disabled**.
This is a limitation of this integration's verified support, not a statement that
all endpoints from those providers lack structured outputs. Enable a future
integration only after verifying the exact endpoint/model's native schema format
and adding its wire contract test; an API key or JSON mode alone is insufficient.

Invalid schema output may retry once with the **same** model and schema. Transport
retries are separately limited to one by the SDK. Each attempt has a 90-second
timeout and an 8192-token output limit. Usage from failed schema attempts is counted;
reasoning tokens are not counted twice. Provider payloads are not included in
user-facing errors. Keys never become client-side variables.

OpenAI may remain unconfigured until its key is supplied. Creama never borrows a
different provider's credentials to make a missing configuration appear valid.
