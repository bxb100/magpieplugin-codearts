// A request is answered as the reference Python proxy answered it: the
// channel each model goes by, a plain answer as JSON or as one SSE
// chunk, a stream passed through with its holes filled, and Huawei's
// errors as OpenAI's shape.
import { test, expect, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin, _internal
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real cache is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ CodeartsAuthPlugin: plugin, _internal } = await import("./index.mjs"))
})

// nothing leaves the machine
const offline = async () => { throw new Error("no network in tests") }
globalThis.fetch = offline
afterEach(() => (globalThis.fetch = offline))

const AK = "AK", SK = "SK"
const auth = { type: "api", key: AK, metadata: { sk: SK } }

// loader is the plugin's loader with a fixed auth and no models read
async function loader() {
  const hooks = await plugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.loader(async () => auth)
}

test("the channel each model goes by", () => {
  const list = [{ id: "openpangu-2.0-pro", channel: "agent" }, { id: "glm-5.3-flash", channel: "benefit" }]
  expect(_internal.channelOf("openpangu-2.0-pro", list)).toBe("agent")
  expect(_internal.channelOf("glm-5.3-flash", list)).toBe("benefit")
  // a model the list doesn't know: the IDE's own agent models are agent,
  // everything else benefit, as the reference put it
  expect(_internal.channelOf("GLM-5.2", [])).toBe("agent")
  expect(_internal.channelOf("some-new-model", [])).toBe("benefit")
})

test("a streamed request to a benefit model carries the three headers, an agent one doesn't", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers })
    // the models are asked for first (agents, then a detail), then chat
    if (String(url).includes("useragents"))
      return new Response(JSON.stringify({ agents: [{ agent_id: "a1", is_primary_agent: true, agent_order: 1 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("agents/detail"))
      return new Response(JSON.stringify({ gpts: { models: [{ model_id: "openpangu-2.0-pro", model_parameters: {} }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("gateway/config"))
      return new Response(JSON.stringify({ result: { models: [{ model_id: "glm-5.3-flash" }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } })
    return new Response("data: " + JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }
  const l = await loader() // the models are read here

  await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3-flash", messages: [], stream: true }) })
  const chat = seen.find((c) => c.url.includes("/api/v2/chat/completions"))
  expect(chat.headers["maas_type"]).toBe("benefit")
  expect(chat.headers["model-id"]).toBe("glm-5.3-flash")

  await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "openpangu-2.0-pro", messages: [], stream: true }) })
  const chat2 = seen.filter((c) => c.url.includes("/api/v2/chat/completions")).at(-1)
  expect(chat2.headers["maas_type"]).toBeUndefined()
})

test("a plain answer goes back as JSON", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  expect(res.status).toBe(200)
  const b = await res.json()
  expect(b.choices[0].message.content).toBe("你好")
  expect(b.choices[0].finish_reason).toBe("stop")
})

test("SSE to a plain request is aggregated into one JSON", async () => {
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({ id: "1", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "other" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n` +
    "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  const b = await res.json()
  expect(b.object).toBe("chat.completion")
  expect(b.choices[0].message.content).toBe("Hello")
  expect(b.choices[0].finish_reason).toBe("stop") // "other" is OpenAI's "stop"
  expect(b.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 })
})

test("a stream goes through with a missing finish filled in and null content made empty", async () => {
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { reasoning_content: "think", content: null }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }) // no finish, no [DONE]
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [], stream: true }) })
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const text = await res.text()
  expect(text).toContain('"content":""') // null became empty, not dropped
  expect(text).toContain("hi")
  expect(text).toContain('"finish_reason":"stop"') // the missing finish, added
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true) // and the [DONE]
})

test("a JSON answer to a streamed request becomes one chunk and [DONE]", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [], stream: true }) })
  const text = await res.text()
  const chunks = text.split("\n\n").filter((l) => l.startsWith("data: "))
  expect(chunks.length).toBe(2)
  expect(JSON.parse(chunks[0].slice(6)).object).toBe("chat.completion.chunk")
  expect(JSON.parse(chunks[0].slice(6)).choices[0].delta.content).toBe("hi")
  expect(chunks[1].slice(6)).toBe("[DONE]")
})

test("an HTTP error is OpenAI's error shape, Huawei's words in it", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error_code: "MaaS.0004", error_msg: "The model is not registered" }), { status: 404 })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  expect(res.status).toBe(404)
  const b = await res.json()
  expect(b.error.message).toContain("not registered")
})

test("an error wrapped in a 200 body is seen", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error_code: "MaaS.1111", error_msg: "您的问题包含敏感信息，无法处理" }), { status: 200 })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toContain("敏感信息")
})

test("a quota word is a 429, so magpie's gateway moves on", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error_msg: "usage limit reached for today" }), { status: 429 })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  expect(res.status).toBe(429)
})

test("not a chat request is a 404", async () => {
  const l = await loader()
  const res = await l.fetch("https://x/v1/models", { method: "GET" })
  expect(res.status).toBe(404)
})

test("a body that isn't JSON is a 400", async () => {
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: "not json" })
  expect(res.status).toBe(400)
})

// the sign-in's shape: the AK as the key, the SK as metadata
test("the keys an api sign-in holds", () => {
  expect(_internal.credsOf(auth)).toEqual({ ak: AK, sk: SK })
  expect(_internal.credsOf({ type: "api", key: AK })).toBeNull() // no SK
  expect(_internal.credsOf(null)).toBeNull()
})


test("an agent stream goes through as it came, only [DONE] added if missing", async () => {
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }) // no finish, no [DONE]
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "openpangu-2.0-pro", messages: [], stream: true }) })
  const text = await res.text()
  expect(text).toContain("hi")
  expect(text).not.toContain('"finish_reason":"stop"') // an agent stream is not fixed up
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true) // only the [DONE] is added
})

test("a benefit stream with no finish gets one", async () => {
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } })
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3-flash", messages: [], stream: true }) })
  const text = await res.text()
  expect(text).toContain('"finish_reason":"stop"')
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
})

test("the content-type may lie: SSE-labelled JSON is still read whole", async () => {
  // Huawei answers JSON on a streamed request and names it wrong: the
  // reference read the body as JSON first, whatever the type said
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }) // lies: it's JSON
  const l = await loader()
  const res = await l.fetch("https://x/api/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [], stream: true }) })
  const text = await res.text()
  const chunks = text.split("\n\n").filter((x) => x.startsWith("data: "))
  expect(JSON.parse(chunks[0].slice(6)).choices[0].delta.content).toBe("ok") // wrapped as one chunk
  expect(chunks[1].slice(6)).toBe("[DONE]")
})

// usage: the free allowance as a window
test("the free allowance's balance", () => {
  const u = _internal.usageOf({ total_quota: 1000, total_balance: 250 })
  expect(u.plan).toBe("CodeArts Free")
  expect(u.windows[0]).toEqual({ name: "Free tokens", used: 75, display: "250 / 1000" })
  expect(_internal.usageOf({})).toEqual({}) // no allowance: no windows
})
