// Huawei Cloud CodeArts as an OpenCode provider plugin.
//
// CodeArts serves its models (openpangu, GLM, DeepSeek, …) from Huawei
// Cloud's API at snap-access.cn-north-4.myhuaweicloud.com, in OpenAI's
// Chat Completions shape, but every request must carry Huawei Cloud's
// SDK-HMAC-SHA256 signature, made with an account's Access Key and
// Secret Key (the ones at console.huaweicloud.com/iam — they are not
// CodeArts-specific, they hold the account's whole cloud: treat them as
// such).
//
// The models come two ways, and the two are signed differently:
// - the subscription's own (the "agent" channel), listed by the
//   AgentCenter API;
// - the free daily allowance ("benefit") models, listed by the opengw
//   gateway, which a chat request must name in three signed headers —
//   maas_type, model-id, model-name — or Huawei answers "the model is
//   not registered".
// The models are asked for when the plugin loads and every 5 minutes,
// and the last list is kept at ~/.local/share/codearts/models.json, so
// the models are there before the first sign-in answers, and when the
// cloud is unreachable.
import { createHash, createHmac } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ID = "codearts"
const MESSAGES = "@ai-sdk/openai-compatible"

const BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"
const CHAT = BASE + "/api/v2/chat/completions"
const AGENTS = BASE + "/v1/agent-center/agents/useragents?offset=0&limit=100"
const AGENT_DETAIL = BASE + "/v1/agent-center/agents/detail"
const OPENGW = "https://opengw.developer.huaweicloud.com"
const OPENGW_CONFIG = OPENGW + "/api/v1/gateway/config"
const OPENGW_BALANCE = OPENGW + "/api/v1/user/tokens/balance"
// the subscription's own account: the snap-manager statistics the IDE reads
const STATS = BASE + "/snap-manager/v1/statistics/plugin"

// the models when the cloud hasn't been asked: the IDE's own list (the
// agent channel's are the subscription's, the benefit channel's the
// free allowance's)
const AGENT_FALLBACK = ["openpangu-2.0-pro", "openpangu-2.0-flash", "GLM-5.2"]
const BENEFIT_FALLBACK = ["glm-5.3-flash", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731"]
const CACHE = join(homedir(), ".local", "share", "codearts", "models.json")
const LIST_AGAIN = 5 * 60 * 1000
const TIMEOUT = 30_000
// a chat may take a while: the reference gave it 600s
const CHAT_TIMEOUT = 600_000

// ---- Huawei Cloud's SDK-HMAC-SHA256 signing --------------------------------------
//
// What Huawei Cloud signs (their Signature algorithm, as the IDE and the
// Python SDK make it): the method, the URI with its trailing slash, the
// query in order, the headers that are signed (lowercase, sorted, their
// values trimmed), the names of those headers, and the body's SHA-256.
// The signature is the HMAC-SHA256 of "\n"-joined algorithm name, the
// time, and that request's SHA-256.

const utc = (now = Date.now()) => {
  // 20260101T000000Z, UTC: x-sdk-date's shape
  const p = (n) => String(n).padStart(2, "0")
  const d = new Date(now)
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex")

// signedHeaders is the headers for a request to Huawei Cloud, signed.
// extra is the headers beyond host, content-type and x-sdk-date — all
// of them are signed, as they must be.
function signedHeaders(method, url, ak, sk, body = "", extra = {}, now = Date.now()) {
  const u = new URL(url)
  const path = u.pathname
  const uri = path.endsWith("/") ? path : path + "/"
  const q = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  const quote = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  const query = q.map(([k, v]) => `${quote(k)}=${quote(v)}`).join("&")
  const date = utc(now)
  const headers = { host: u.host, "content-type": "application/json", "x-sdk-date": date }
  for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = String(v)
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("")
  const signed = names.join(";")
  const canonicalRequest = [method.toUpperCase(), uri, query, canonicalHeaders, signed, sha256(body)].join("\n")
  const stringToSign = ["SDK-HMAC-SHA256", date, sha256(canonicalRequest)].join("\n")
  const signature = createHmac("sha256", sk).update(stringToSign).digest("hex")
  return {
    ...headers,
    Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}

// send is a request to Huawei Cloud, signed, as the IDE sends one.
async function send(ak, sk, method, url, body = "", extra = {}, signal) {
  return fetch(url, {
    method,
    headers: signedHeaders(method, url, ak, sk, body, extra),
    body: method === "GET" ? undefined : body,
    signal: signal ?? AbortSignal.timeout(TIMEOUT),
  })
}

// ---- the models -------------------------------------------------------------------

// a model as the plugin holds it
const model = (id, o = {}) => ({
  id,
  name: o.name ?? id,
  channel: o.channel ?? (AGENT_FALLBACK.includes(id) ? "agent" : "benefit"),
  context: o.context ?? 0,
  output: o.output ?? 0,
  images: !!o.images,
})

// fallbackModels is the IDE's own list, the agent channel's first.
const fallbackModels = () => [...AGENT_FALLBACK, ...BENEFIT_FALLBACK].map((id) => model(id))

let listed = null // { at, list } of the last good read
let reading = null // a read under way, so two callers share one

function cacheRead() {
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"))
    if (Array.isArray(c?.list) && c.list.length) return { at: c.at ?? 0, list: c.list }
  } catch {}
  return null
}

function cacheWrite(list) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true })
    const tmp = CACHE + ".tmp"
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), list }, null, 2))
    renameSync(tmp, CACHE)
  } catch {}
}

// agentModels asks the AgentCenter for the subscription's models: the
// account's agents, the primary one's detail (or the first that
// answers), which holds them.
async function agentModels(ak, sk, signal) {
  const res = await send(ak, sk, "GET", AGENTS, "", { "agent-type": "AgentCenter", "x-language": "zh-cn", accept: "application/json" }, signal)
  const text = await res.text()
  if (!res.ok) throw new Error(`CodeArts agent list: ${res.status} ${res.statusText} ${text.slice(0, 200)}`.trim())
  let agents = []
  try {
    agents = JSON.parse(text)?.agents ?? []
  } catch {}
  if (!agents.length) throw new Error("CodeArts listed no agents")
  // the primary agent first, then the agents' own order
  const sorted = [...agents].sort((x, y) =>
    Number(!!y.is_primary_agent) - Number(!!x.is_primary_agent) ||
    (x.agent_order ?? Number.MAX_SAFE_INTEGER) - (y.agent_order ?? Number.MAX_SAFE_INTEGER))
  const out = []
  for (const a of sorted) {
    if (!a.agent_id) continue
    let detail = null
    try {
      const r = await send(ak, sk, "GET", AGENT_DETAIL + "?agent_id=" + encodeURIComponent(a.agent_id), "",
        { "agent-type": "AgentCenter", "x-language": "zh-cn", accept: "application/json" }, signal)
      if (r.status === 200) detail = await r.json().catch(() => null)
    } catch {}
    for (const m of detail?.gpts?.models ?? []) {
      const id = m.model_id || m.model_alias
      if (!id || out.some((x) => x.id === id)) continue
      const p = m.model_parameters ?? {}
      out.push(model(id, { channel: "agent", name: m.model_alias || m.model_name || id, context: p.context_window,
        output: p.max_tokens, images: p.supports_images }))
    }
    if (out.length) break // the primary agent has the list
  }
  return out
}

// benefitModels asks the opengw gateway for the free allowance's models.
async function benefitModels(ak, sk, signal) {
  const res = await send(ak, sk, "GET", OPENGW_CONFIG, "", {}, signal)
  const text = await res.text()
  if (!res.ok) throw new Error(`CodeArts free models: ${res.status} ${text.slice(0, 200)}`.trim())
  const out = []
  try {
    for (const m of JSON.parse(text)?.result?.models ?? []) {
      if (!m?.model_id || out.some((x) => x.id === m.model_id)) continue
      out.push(model(m.model_id, { channel: "benefit", name: m.model_name || m.model_id, context: m.context_window, output: m.max_tokens }))
    }
  } catch {}
  return out
}

// modelsOf is the account's models, the agent channel's first and the
// benefit channel's behind them, read at most once every LIST_AGAIN. A
// read that fails says the models are unknown (the caller falls back to
// what it had); one that succeeds updates the cache.
async function modelsOf(ak, sk, signal) {
  if (listed && Date.now() - listed.at < LIST_AGAIN) return listed.list
  if (reading) return reading
  reading = (async () => {
    try {
      const agents = await agentModels(ak, sk, signal)
      let benefit = []
      try {
        benefit = await benefitModels(ak, sk, signal)
      } catch {}
      if (!benefit.length) benefit = BENEFIT_FALLBACK.map((id) => model(id))
      const have = new Set(agents.map((m) => m.id))
      const list = [...agents, ...benefit.filter((m) => !have.has(m.id))]
      if (!list.length) throw new Error("CodeArts listed no models")
      listed = { at: Date.now(), list }
      cacheWrite(list)
      return list
    } finally {
      reading = null
    }
  })()
  return reading
}

// known is the models to show: the account's if they can be read, else
// the cache's, else the IDE's own list.
async function known(ak, sk, signal) {
  try {
    return await modelsOf(ak, sk, signal)
  } catch {}
  return cacheRead()?.list ?? fallbackModels()
}

// configModel is a model in OpenCode's provider config; runtimeModel
// the same as OpenCode's provider hook hands it back.
function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context, output: m.output },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    tool_call: true,
  }
}

function runtimeModel(m) {
  return {
    id: m.id,
    providerID: ID,
    name: m.name,
    api: { id: m.id, url: BASE, npm: MESSAGES },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context, output: m.output },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

// ---- the request: a chat completion, signed ----------------------------------------

const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message, type: "api_error", code: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })

// QUOTA_WORDS is how a vendor says "out of quota" (magpie's
// internal/gateway/fallback.go), so magpie's gateway moves on.
const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i

// channelOf is a model's channel: agent (the subscription's own, the
// base signature) or benefit (the free allowance, three more headers).
// A model the list doesn't know: the IDE's own agent models are agent,
// everything else benefit.
function channelOf(m, list) {
  const found = (list ?? []).find((x) => x.id === m)
  if (found) return found.channel === "agent" ? "agent" : "benefit"
  return AGENT_FALLBACK.includes(m) ? "agent" : "benefit"
}

// parseAnswer reads a whole answer: JSON as it is (which may still be
// an error), else SSE read as that — Huawei names SSE on a plain
// answer, and JSON on a streamed one, so the body decides.
function parseAnswer(text) {
  try {
    const j = JSON.parse(text)
    if (j?.error_code || j?.error_msg) return { error: `${j.error_msg || "CodeArts error"} (${j.error_code})` }
    if (j?.error?.message) return { error: j.error.message }
    for (const c of j?.choices ?? []) if (c.finish_reason === "other") c.finish_reason = "stop"
    return { body: j }
  } catch {
    return aggregate(text)
  }
}

// complete answers one Chat Completions request through CodeArts.
async function complete(ak, sk, list, req, signal) {
  const m = String(req.model ?? "")
  const channel = channelOf(m, list)
  const body = JSON.stringify(req)
  const extra = channel === "benefit" ? { maas_type: "benefit", "model-id": m, "model-name": m } : {}
  let res
  try {
    res = await send(ak, sk, "POST", CHAT, body, extra, signal ?? AbortSignal.timeout(CHAT_TIMEOUT))
  } catch (e) {
    if (e?.name === "AbortError") throw e
    return errorResponse(502, `CodeArts: ${e.message ?? e}`)
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 2000)
    let msg = text.trim() || `${res.status} ${res.statusText}`.trim()
    try {
      const e = JSON.parse(text)
      msg = e.error_msg || e.error?.message || e.message || e.error_code || msg
    } catch {}
    return errorResponse(QUOTA_WORDS.test(msg) ? 429 : res.status, msg)
  }
  if (req.stream !== true) {
    const out = parseAnswer(await res.text())
    if (out.error) return errorResponse(QUOTA_WORDS.test(out.error) ? 429 : 502, out.error)
    if (!out.body) return errorResponse(502, "CodeArts answered nothing")
    return Response.json(out.body)
  }
  // streamed: an SSE answer goes through, its chunks fixed as OpenAI's
  // shape has them; a JSON answer is wrapped as one chunk — Huawei
  // names SSE on a JSON answer too, so what the body starts with decides
  const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
  const peek = await res.clone().text().catch(() => "")
  if (!peek.trimStart().startsWith("data:")) {
    const out = parseAnswer(peek)
    if (out.error) return errorResponse(QUOTA_WORDS.test(out.error) ? 429 : 502, out.error)
    if (!out.body) return errorResponse(502, "CodeArts answered nothing")
    const chunk = { ...out.body, object: "chat.completion.chunk" }
    chunk.choices = (out.body.choices ?? []).map((c) => ({ ...c, delta: c.message }))
    const enc = new TextEncoder()
    const sse = new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        ctl.close()
      },
    })
    return new Response(sse, { status: 200, headers })
  }
  // the reference filled a missing finish only on a benefit stream —
  // an agent stream goes through exactly as it came
  const sweeper = channel === "benefit" ? sweep(res.body) : passThrough(res.body)
  return new Response(sweeper, { status: 200, headers })
}

// passThrough is an agent stream: byte for byte as it came, only the
// [DONE] Huawei may have left off added at the end.
function passThrough(body) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let ended = false
  return new ReadableStream({
    async pull(ctl) {
      const { value, done } = await reader.read()
      if (done) {
        if (!ended) ctl.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        return ctl.close()
      }
      if (dec.decode(value, { stream: true }).includes("[DONE]")) ended = true
      ctl.enqueue(value)
    },
    cancel() {
      reader.cancel?.()
    },
  })
}

// sweep passes a benefit stream through as OpenAI's: whole lines only,
// the chunks Huawei answers a benefit model with may name no finish
// reason (one is added at the end, with the [DONE] Huawei may have held
// back), and a chunk with content null becomes the empty string.
function sweep(body) {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ""
  let reason = false
  let done = false
  const lines = (text) => {
    const out = []
    for (const line of text.split("\n")) {
      const l = line.replace(/\r$/, "")
      if (!l.startsWith("data:")) continue
      const payload = l.slice(5).trim()
      if (payload === "[DONE]") {
        done = true
        continue
      }
      let chunk
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      for (const c of chunk.choices ?? []) {
        if (c.finish_reason != null) {
          reason = true
          if (c.finish_reason === "other") c.finish_reason = "stop"
        }
        if (c.delta && c.delta.content == null) c.delta.content = ""
      }
      out.push(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    return out
  }
  const reader = body.getReader()
  return new ReadableStream({
    async pull(ctl) {
      for (;;) {
        const { value, done: over } = await reader.read()
        if (over) {
          // the stream ends here: what it never said is said now, and
          // the stream closes with it
          const end = []
          if (!reason) end.push(`data: ${JSON.stringify({ id: "codearts-finish", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
            model: "", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
          if (!done) end.push("data: [DONE]\n\n")
          if (end.length) ctl.enqueue(enc.encode(end.join("")))
          return ctl.close()
        }
        buf += dec.decode(value, { stream: true })
        const cut = buf.lastIndexOf("\n") + 1
        if (!cut) continue // a part that ends mid-line waits for the next
        const text = buf.slice(0, cut)
        buf = buf.slice(cut)
        const out = lines(text)
        if (out.length) {
          ctl.enqueue(enc.encode(out.join("")))
          return
        }
        // a part with no whole line of its own
      }
    },
    cancel() {
      reader.cancel?.()
    },
  })
}

// aggregate reads a whole SSE answer into one chat.completion, the
// message, the tool calls and the usage put together.
function aggregate(text) {
  const out = { id: null, object: "chat.completion", created: null, model: null,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] }
  const texts = []
  const thinks = []
  const calls = new Map()
  let finish = ""
  let usage
  for (const line of text.split("\n")) {
    const l = line.trim()
    if (!l.startsWith("data:")) continue
    const payload = l.slice(5).trim()
    if (payload === "[DONE]") continue
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (chunk.error_code || chunk.error_msg) return { error: `${chunk.error_msg || "CodeArts error"} (${chunk.error_code})` }
    if (chunk.error?.message) return { error: chunk.error.message }
    for (const k of ["id", "created", "model"]) if (chunk[k] != null) out[k] = chunk[k]
    if (chunk.usage) usage = chunk.usage
    for (const c of chunk.choices ?? []) {
      if (c.finish_reason != null) finish = c.finish_reason === "other" ? "stop" : c.finish_reason
      const d = c.delta ?? {}
      if (typeof d.content === "string") texts.push(d.content)
      if (typeof d.reasoning_content === "string") thinks.push(d.reasoning_content)
      for (const call of d.tool_calls ?? []) {
        const i = call.index ?? 0
        const cur = calls.get(i) ?? { id: "", type: "function", function: { name: "", arguments: "" } }
        if (call.id) cur.id = call.id
        if (call.type) cur.type = call.type
        if (call.function?.name) cur.function.name += call.function.name
        if (call.function?.arguments) cur.function.arguments += call.function.arguments
        calls.set(i, cur)
      }
    }
  }
  const message = out.choices[0].message
  message.content = texts.join("")
  if (thinks.length) message.reasoning_content = thinks.join("")
  if (calls.size) message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
  out.choices[0].finish_reason = finish || (calls.size ? "tool_calls" : "stop")
  if (usage) out.usage = usage
  return { body: out }
}

// ---- the account's free allowance ---------------------------------------------------

// balance is the account as the two APIs that tell it read it: the free
// allowance (the opengw gateway's balance, the daily allowance the free
// models draw) and the subscription's credits (the snap-manager statistics
// the IDE's own quota bar reads — it takes the same signature, so the
// account's keys answer it without a sign-in of its own).
// Either half may fail (the gateway down, no subscription yet): one good
// answer keeps its half, and only both failing is an error.
async function balance(ak, sk, signal) {
  const read = async (url, what) => {
    const res = await send(ak, sk, "GET", url, "", {}, signal)
    const text = await res.text()
    if (!res.ok) throw new Error(`CodeArts balance: ${res.status} ${text.slice(0, 200)}`.trim())
    let j
    try {
      j = JSON.parse(text)
    } catch {}
    const b = j?.result ?? j
    if (!b || typeof b !== "object") throw new Error(`CodeArts balance: no ${what} answer`)
    return b
  }
  const [free, sub] = await Promise.allSettled([
    read(OPENGW_BALANCE, "free"),
    read(STATS, "subscription"),
  ])
  if (free.status !== "fulfilled" && sub.status !== "fulfilled")
    throw free.reason ?? sub.reason
  return {
    free: free.status === "fulfilled" ? free.value : null,
    sub: sub.status === "fulfilled" ? sub.value : null,
  }
}

// usageOf is the account as a usage read shows it: a window for the
// free tokens, and one for the subscription's credits — as many as the
// statistics named, each filling as it is spent. The plan is the
// subscription's own name when it tells one.
function usageOf(b) {
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
  const pct = (v) => Math.max(0, Math.min(100, v))
  const windows = []

  const free = b?.free ?? b // the old shape, a bare balance answer
  const total = num(free?.total_quota)
  const left = num(free?.total_balance)
  if (total > 0)
    windows.push({ name: "Free tokens", used: pct((100 * (total - left)) / total), display: `${left} / ${total}` })

  const sub = b?.sub
  if (sub) {
    const metric = (name) => (Array.isArray(sub.metrics) ? sub.metrics.find((m) => m?.name === name) : null)
    const credit = (m) => {
      if (!m) return null
      const amount = num(m.package_credit_amount)
      const used = num(m.package_credit_used)
      const remain = num(m.package_credit_remain)
      if (amount <= 0 && used <= 0) return null
      return { used: pct((100 * used) / (amount > 0 ? amount : used)), display: `${remain} / ${amount}` }
    }
    for (const [name, label] of [
      ["usageTotalPackageCredit", "Total credits"],
      ["usageBasicPackageCredit", "Basic credits"],
      ["usageOnDemandPackageCredit", "On-demand credits"],
      ["usageBonusPackageCredit", "Bonus credits"],
    ]) {
      const c = credit(metric(name))
      if (c) windows.push({ name: label, ...c })
    }
  }

  if (!windows.length) return {}
  const plan = sub?.package?.package_name_en || "CodeArts Free"
  return { plan, windows }
}

// ---- the plugin ---------------------------------------------------------------------

// credsOf is the Huawei Cloud keys an auth entry holds: the Access Key
// as the key, the Secret Key as metadata (OpenCode asks for one key,
// so the sign-in's prompts put it there).
function credsOf(auth) {
  if (auth?.type !== "api") return null
  const ak = String(auth.metadata?.ak ?? "").trim()
  const sk = String(auth.key ?? "").trim()
  if (!ak || !sk) return null
  return { ak, sk }
}

export async function CodeartsAuthPlugin() {
  // the models of the account in use, so the channel each request goes
  // by is the latest list's, without a read per request
  let models = null

  const creds = async (getAuth) => {
    const c = credsOf(await getAuth())
    if (!c) throw new Error("this CodeArts account's keys are gone; add them again")
    return c
  }

  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const c = await creds(getAuth).catch(() => null)
        if (!c) return {}
        try {
          models = await modelsOf(c.ak, c.sk)
        } catch {} // the last good list, or the fallback, stays
        return {
          baseURL: BASE,
          apiKey: "", // the engine's placeholder; the fetch signs each request itself
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? ""
            const { pathname } = new URL(url)
            if (!pathname.endsWith("/chat/completions"))
              return errorResponse(404, `this plugin only answers OpenAI Chat Completions requests, not ${pathname}`)
            let req
            const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
            try {
              req = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b ?? new Uint8Array()))
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            let key
            try {
              key = await creds(getAuth)
            } catch (e) {
              return errorResponse(401, e.message)
            }
            let list = models
            if (!list) {
              try {
                list = models = await known(key.ak, key.sk)
              } catch {}
            }
            return complete(key.ak, key.sk, list, req, init.signal)
          },
        }
      },
      // the free allowance's balance and the subscription's credits,
      // as magpie's own hook
      async usage(getAuth) {
        let c
        try {
          c = await creds(getAuth)
        } catch (e) {
          return { error: e.message, signIn: "kept" }
        }
        try {
          return { ...usageOf(await balance(c.ak, c.sk)), signIn: "kept" }
        } catch (e) {
          return { error: e.message, signIn: "kept" }
        }
      },
      methods: [
        {
          type: "api",
          label: "Secret Access Key (SK)",
          placeholder: "shown once when the key was made",
          prompts: [
            {
              type: "text",
              key: "ak",
              message: "Access Key ID (AK)",
              placeholder: "at console.huaweicloud.com/iam → Access Keys",
              validate: (v) => (v.trim() ? undefined : "the Access Key is empty"),
            },
          ],
          // authorize writes the keys as OpenCode writes an api sign-in:
          // the AK as the key, the SK as metadata
          authorize: async (inputs = {}) => {
            const ak = String(inputs.ak ?? "").trim()
            if (!ak) return { type: "failed" }
            return { type: "success", provider: ID, metadata: { ak } }
          },
        },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "CodeArts",
        npm: MESSAGES,
        api: BASE,
        ...was,
        models: { ...staticModels(), ...(was.models ?? {}) },
      }
    },
    // the account's own list, the agent channel's first
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const c = credsOf(auth)
        if (!c) return provider.models
        try {
          const list = await modelsOf(c.ak, c.sk)
          models = list
          return Object.fromEntries(list.map((m) => [m.id, runtimeModel(m)]))
        } catch {
          return provider.models
        }
      },
    },
  }
}

// staticModels is the models before any sign-in: the cache's, else the
// IDE's own list, so the provider is never empty.
function staticModels() {
  const models = cacheRead()?.list ?? fallbackModels()
  return Object.fromEntries(models.map((m) => [m.id, configModel(m)]))
}

// for tests
export const _internal = { signedHeaders, utc, channelOf, usageOf, credsOf }
