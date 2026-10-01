# @magpie-community/opencode-codearts-auth

Makes [Huawei Cloud CodeArts](https://codearts.huaweicloud.com) models
(openpangu, GLM, DeepSeek, Qwen VL …) usable in OpenCode and in magpie.
Provider id: `codearts`.

## Signing in

**Huawei Cloud Access Key and Secret Key.** CodeArts has no sign-in of
its own here: the keys every Huawei Cloud service takes, made at
[console.huaweicloud.com/iam → Access Keys](https://console.huaweicloud.com/#/iam),
are asked for by the plugin's sign-in.

> [!WARNING]
> The keys hold the account's whole Huawei Cloud, not CodeArts alone.
> Treat them as you would any cloud root credential.

The keys are kept where OpenCode keeps sign-ins (`auth.json`; in
magpie, `plugin-auth.json`) as an `api` entry: the AK as the key, the
SK as metadata.

## The two model channels

CodeArts serves its models two ways, and the plugin signs each
differently:

- **The subscription's models** (the "agent" channel: openpangu-2.0,
  GLM-5.2, Qwen3-VL …), listed by the AgentCenter API. A chat request
  to them carries the base SDK-HMAC-SHA256 signature.
- **The free daily allowance's models** (the "benefit" channel:
  glm-5.3-flash, deepseek-v4 …), listed by the opengw gateway
  (`opengw.developer.huaweicloud.com`). A chat request to them must
  also name the model in three *signed* headers — `maas_type:
  benefit`, `model-id`, `model-name` — or Huawei answers "The model
  is not registered".

A model not in the subscription's list is taken to be a benefit model,
so new free models need no change here.

The models are read when the plugin loads and every 5 minutes, and the
last good list is kept at `~/.local/share/codearts/models.json`, so
the models are there before the first sign-in answers, and when the
cloud is unreachable. The free allowance needs its daily claim (the
IDE's "签到"); claim it in the CodeArts IDE or at opengw.

## Requests

The models speak OpenAI's Chat Completions (`@ai-sdk/openai-compatible`),
and the plugin's `fetch` handles each request:

- It signs the request with the account's keys, as the CodeArts IDE
  does (SDK-HMAC-SHA256 over the method, URI, query, signed headers
  and body).
- It sends it to `snap-access.cn-north-4.myhuaweicloud.com
  /api/v2/chat/completions`.
- Huawei may answer SSE whatever `stream` said, and a benefit stream
  may name no finish reason: a plain request gets one JSON answer
  aggregated, a streamed one gets its chunks passed through with the
  missing finish and `[DONE]` added, `content: null` made the empty
  string, and `finish_reason: "other"` read as `stop`.
- Huawei's errors — HTTP or wrapped in a 200 — come back as OpenAI's
  error shape; one that reads as a quota or rate limit is a 429, so
  magpie's gateway moves on to the next account.

## Usage

The account's free allowance (opengw's balance): the tokens left of
the day's, as a window. The subscription's own allowance has no
number Huawei tells.

```sh
# magpie
magpie plugin add @magpie-community/opencode-codearts-auth
magpie plugin login codearts
```

In OpenCode, `opencode.json`:

```json
{ "plugin": ["@magpie-community/opencode-codearts-auth"] }
```
