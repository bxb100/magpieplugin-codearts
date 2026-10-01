// The signature is Huawei Cloud's own algorithm, byte for byte as the
// reference Python implementation (codearts2api's server.py) makes it.
// The goldens below were produced by that implementation with the test
// keys and x-sdk-date pinned to 20260101T000000Z.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { signedHeaders } = _internal

const AK = "TESTAKTESTAKTESTAKTESTAK"
const SK = "TESTSKTESTSKTESTSKTESTSKTESTSK0123"
// what the reference implementation had as its x-sdk-date
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0)

test("utc makes x-sdk-date's shape", () => {
  expect(_internal.utc()).toMatch(/^\d{8}T\d{6}Z$/)
  expect(_internal.utc(NOW)).toBe("20260101T000000Z")
})

test("the agent list's signature (extra headers, a query, no body)", () => {
  const h = signedHeaders("GET", "https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/useragents?offset=0&limit=100",
    AK, SK, "", { "agent-type": "AgentCenter", "x-language": "zh-cn", accept: "application/json" }, NOW)
  expect(h.Authorization).toBe(`SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=accept;agent-type;content-type;host;x-language;x-sdk-date, Signature=246bf402e1f127c6380acda647087814ce03bb4e2d041d11ab108fce212095dd`)
})

test("a benefit model's chat request (three more signed headers)", () => {
  const body = JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "你好，世界" }] })
  const h = signedHeaders("POST", "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions", AK, SK, body,
    { maas_type: "benefit", "model-id": "glm-5.3-flash", "model-name": "glm-5.3-flash" }, NOW)
  expect(h.Authorization).toBe(`SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=content-type;host;maas_type;model-id;model-name;x-sdk-date, Signature=099f298f0f1ef7f7d094b3e3ca9842bc7e13e554d5002ede14054ace3144f570`)
})

test("an agent model's chat request (the base signature)", () => {
  const body = JSON.stringify({ model: "openpangu-2.0-pro", messages: [] })
  const h = signedHeaders("POST", "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions", AK, SK, body, {}, NOW)
  expect(h.Authorization).toBe(`SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=content-type;host;x-sdk-date, Signature=8908eed75a4a036d824f3f42e70ad7c9b028a9e01ceb36feb6f4dd8e8afdb236`)
})

test("the opengw balance (a different host)", () => {
  const h = signedHeaders("GET", "https://opengw.developer.huaweicloud.com/api/v1/user/tokens/balance", AK, SK, "", {}, NOW)
  expect(h.Authorization).toBe(`SDK-HMAC-SHA256 Access=${AK}, SignedHeaders=content-type;host;x-sdk-date, Signature=26ec39c13bbe9560886dfb89249602f78c28456150c0c2b760631190ebe8ad95`)
})
