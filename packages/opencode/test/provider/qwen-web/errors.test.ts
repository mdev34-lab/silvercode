import { describe, expect, test } from "bun:test"
import {
  abortedError,
  CHALLENGE_WINDOW_OPEN_DETAIL,
  challengeError,
  classifyHttpResponse,
  classifyJsonError,
  classifyStatus,
  classifyStreamError,
  classifyTransportFailure,
  classifyTruncatedJson,
  emptyResponseError,
  isAbortLike,
  isChallengeMessage,
  isChatMissingMessage,
  isHtmlBody,
  isNoDisplayError,
  isQuotaMessage,
  isStaleAnchorCode,
  isStaleAnchorError,
  isStaleAnchorMessage,
  isStaleBindingError,
  isStaleChatCode,
  isStaleChatError,
  isWafMessage,
  loginRequiredError,
  nonStreamResponseError,
  normalizeUpstreamCode,
  QwenWebError,
  sanitizeQwenErrorText,
  sessionExpiredError,
  staleAnchorError,
  withQwenWebErrorPhase,
  staleChatError,
  STALE_ANCHOR_UPSTREAM_CODE,
  STALE_CHAT_UPSTREAM_CODE,
} from "@opencode-ai/webchat/adapters/qwen/errors"

describe("QwenWebError", () => {
  test("carries code, retryability and status", () => {
    const error = new QwenWebError({ code: "rate_limited", message: "slow down", retryable: true, status: 429 })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("rate_limited")
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(429)
    expect(QwenWebError.isInstance(error)).toBe(true)
    expect(QwenWebError.isInstance(new Error("x"))).toBe(false)
  })

  test("login helpers point at /auth", () => {
    expect(loginRequiredError().code).toBe("login_required")
    expect(loginRequiredError().message).toContain("/auth")
    expect(loginRequiredError().retryable).toBe(false)
    expect(sessionExpiredError().code).toBe("session_expired")
    expect(sessionExpiredError().status).toBe(401)
    expect(challengeError().code).toBe("challenge")
    expect(challengeError().message).toMatch(/never solves challenges/i)
    // The default never promises a window that was never opened.
    expect(challengeError().message).toContain("No browser window could be opened")
    expect(challengeError(CHALLENGE_WINDOW_OPEN_DETAIL).message).toContain("visible browser window")
    // Status parameter pinned: default 403, caller-supplied value preserved
    // (a challenge can arrive with HTTP 200 and must not be re-labeled).
    expect(challengeError().status).toBe(403)
    expect(challengeError(undefined, 200).status).toBe(200)
    expect(classifyStatus(403, "Forbidden")?.status).toBe(403)
    expect(classifyStatus(401)?.code).toBe("session_expired")
  })

  test("abortedError is AbortError-shaped", () => {
    const error = abortedError()
    expect(error.code).toBe("aborted")
    expect(error.name).toBe("AbortError")
    expect(isAbortLike(error)).toBe(true)
    expect(isAbortLike(new DOMException("x", "AbortError"))).toBe(true)
    expect(isAbortLike({ name: "AbortError" })).toBe(true)
    expect(isAbortLike(new Error("boom"))).toBe(false)
  })
})

describe("message classifiers", () => {
  test("quota detection", () => {
    expect(isQuotaMessage("Rate limit exceeded, retry later")).toBe(true)
    expect(isQuotaMessage("HTTP 429 Too Many Requests")).toBe(true)
    expect(isQuotaMessage("insufficient_quota")).toBe(true)
    expect(isQuotaMessage("all good")).toBe(false)
  })

  test("chat-missing detection", () => {
    expect(isChatMissingMessage("chat is not exist")).toBe(true)
    expect(isChatMissingMessage("no such chat")).toBe(true)
    expect(isChatMissingMessage("chat created")).toBe(false)
  })

  test("WAF / challenge detection", () => {
    expect(isWafMessage("FAIL_SYS_USER_VALIDATE")).toBe(true)
    expect(isWafMessage("rgv587_error happened")).toBe(true)
    // The browser-probe consolidation must not lose this marker: it was in
    // the deleted CHALLENGE_BODY_MARKERS and matches nothing else in the list
    // ("verification required" does not cover it).
    expect(isWafMessage("Please complete the security verification")).toBe(true)
    expect(isChallengeMessage("Please complete the security verification")).toBe(true)
    expect(isChallengeMessage("please complete the captcha")).toBe(true)
    expect(isChallengeMessage("human verification required")).toBe(true)
    expect(isChallengeMessage("normal response")).toBe(false)
  })

  test("html detection", () => {
    expect(isHtmlBody("<!DOCTYPE html><html>")).toBe(true)
    expect(isHtmlBody('  <html lang="en">')).toBe(true)
    expect(isHtmlBody('{"success":true}')).toBe(false)
  })

  test("no-display detection", () => {
    expect(isNoDisplayError(new Error("Missing X server (did you mean --headless?)"))).toBe(true)
    expect(isNoDisplayError(new Error("Unable to open X display"))).toBe(true)
    expect(isNoDisplayError(new Error("browser has not been found"))).toBe(false)
  })
})

describe("classifyJsonError", () => {
  test("returns undefined for non-JSON and success payloads", () => {
    expect(classifyJsonError("not json", 200)).toBeUndefined()
    expect(classifyJsonError('{"success":true,"data":{}}', 200)).toBeUndefined()
    expect(classifyJsonError("[]", 200)).toBeUndefined()
  })

  test("WAF ret codes and SSE challenge events become manual challenges", () => {
    const error = classifyJsonError('{"ret":["FAIL_SYS_USER_VALIDATE"]}', 200)
    expect(error?.code).toBe("challenge")
    expect(error?.retryable).toBe(false)
    expect(classifyStreamError("waf_challenge", "verification required").code).toBe("challenge")
  })

  test("status and body are classified together, with challenge markers taking precedence", () => {
    expect(classifyHttpResponse('{"success":false,"message":"login required"}', 403)?.code).toBe("session_expired")
    expect(classifyHttpResponse('{"message":"CAPTCHA verification required"}', 403)?.code).toBe("challenge")
    expect(classifyHttpResponse('{"success":true,"data":{"message":"human verification required"}}', 200)?.code).toBe(
      "challenge",
    )
    expect(classifyHttpResponse('<html>login required</html>', 401)?.code).toBe("session_expired")
  })

  test("success:false with 401 becomes session_expired", () => {
    const error = classifyJsonError('{"success":false,"message":"login required"}', 401)
    expect(error?.code).toBe("session_expired")
  })

  test("rate limit payloads carry the wait hint", () => {
    const error = classifyJsonError('{"success":false,"code":"RateLimited","message":"slow","data":{"num":2}}', 429)
    expect(error?.code).toBe("rate_limited")
    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain("2 hour")
  })

  test("{error} shapes map quota vs generic", () => {
    expect(classifyJsonError('{"error":"rate limit hit"}', 200)?.code).toBe("rate_limited")
    const generic = classifyJsonError('{"error":{"message":"kaput"}}', 500)
    expect(generic?.code).toBe("upstream_error")
    expect(generic?.retryable).toBe(true)
  })
})

describe("classifyStatus", () => {
  test("2xx is undefined", () => {
    expect(classifyStatus(200)).toBeUndefined()
  })
  test("401/403/429/503 mapping", () => {
    expect(classifyStatus(401)?.code).toBe("session_expired")
    expect(classifyStatus(403)?.code).toBe("session_expired")
    expect(classifyStatus(429)?.code).toBe("rate_limited")
    expect(classifyStatus(503)?.code).toBe("upstream_unavailable")
    expect(classifyStatus(503)?.retryable).toBe(true)
    expect(classifyStatus(400)?.retryable).toBe(false)
  })
})

describe("classifyTransportFailure", () => {
  test("network failures are retryable, aborts are not", () => {
    expect(classifyTransportFailure(new Error("fetch failed")).code).toBe("network_error")
    expect(classifyTransportFailure(new Error("fetch failed")).retryable).toBe(true)
    expect(classifyTransportFailure(abortedError()).code).toBe("aborted")
    expect(classifyTransportFailure(new Error("weird")).code).toBe("browser_error")
  })
})

describe("stale-chat classification (issue 232)", () => {
  // The exact shape reported in the field: a deleted chat answering with a
  // CHAT_NOT_FOUND code and a "start a new chat" message.
  const DELETED_BODY = JSON.stringify({
    success: false,
    code: "CHAT_NOT_FOUND",
    message: "This chat has been deleted. Please start a new chat to continue.",
  })

  test("code detection is code-first, case-insensitive and chat-specific", () => {
    expect(normalizeUpstreamCode("CHAT_NOT_FOUND")).toBe("chat not found")
    expect(isStaleChatCode("CHAT_NOT_FOUND")).toBe(true)
    expect(isStaleChatCode("chat_not_exist")).toBe(true)
    expect(isStaleChatCode("Chat Has Been Deleted")).toBe(true)
    expect(isStaleChatCode("no-such-chat")).toBe(true)
    // A bare Not_Found is a retired *model* id, not a stale chat.
    expect(isStaleChatCode("Not_Found")).toBe(false)
    expect(isStaleChatCode("RateLimited")).toBe(false)
    expect(isStaleChatCode("Unauthorized")).toBe(false)
  })

  test("message detection is case-insensitive, chat-specific, and covers deletions", () => {
    expect(isChatMissingMessage("This chat has been deleted. Please start a new chat to continue.")).toBe(true)
    expect(isChatMissingMessage("CHAT NOT FOUND")).toBe(true)
    expect(isChatMissingMessage("Chat is NOT exist")).toBe(true)
    expect(isChatMissingMessage("chat created")).toBe(false)
    expect(isChatMissingMessage("model not found")).toBe(false)
    expect(isChatMissingMessage("Model does not exist")).toBe(false)
    expect(isChatMissingMessage("Attachment file does not exist")).toBe(false)
  })

  test("the deleted-chat payload is a retryable stale-chat error, not a dead end", () => {
    for (const status of [200, 400, 404]) {
      const error = classifyJsonError(DELETED_BODY, status)
      expect(error).toBeDefined()
      expect(error?.code).toBe("upstream_error")
      expect(error?.retryable).toBe(true)
      expect(error?.upstreamCode).toBe(STALE_CHAT_UPSTREAM_CODE)
      expect(error?.message).toContain("CHAT_NOT_FOUND")
      expect(error?.message).toContain("deleted")
      expect(isStaleChatError(error)).toBe(true)
    }
  })

  test("OpenAI-style error shapes carry the code too", () => {
    const error = classifyJsonError('{"error":{"code":"CHAT_NOT_FOUND","message":"gone"}}', 200)
    expect(isStaleChatError(error)).toBe(true)
    expect(error?.retryable).toBe(true)
  })

  test("mid-stream error events classify the same way", () => {
    const byCode = classifyStreamError("CHAT_NOT_FOUND", "This chat has been deleted.")
    expect(isStaleChatError(byCode)).toBe(true)
    expect(byCode.retryable).toBe(true)
    const byMessage = classifyStreamError("E_UPSTREAM", "Sorry, the chat does not exist anymore")
    expect(isStaleChatError(byMessage)).toBe(true)
    // Unrelated stream errors keep their generic retryable classification.
    const generic = classifyStreamError("E1", "kaput")
    expect(isStaleChatError(generic)).toBe(false)
    expect(generic.code).toBe("upstream_error")
  })

  test("message fallback cannot turn model or file errors into stale-chat errors", () => {
    const modelMessage = classifyStreamError("Not_Found", "Model does not exist")
    const fileMessage = classifyStreamError("File_Not_Found", "Attachment file does not exist")
    expect(isStaleChatError(modelMessage)).toBe(false)
    expect(isStaleChatError(fileMessage)).toBe(false)

    const modelBody = classifyJsonError('{"success":false,"code":"Not_Found","message":"Model does not exist"}', 200)
    const fileBody = classifyJsonError('{"success":false,"message":"Attachment file does not exist"}', 200)
    expect(isStaleChatError(modelBody)).toBe(false)
    expect(isStaleChatError(fileBody)).toBe(false)

    // Explicit chat-specific upstream codes still win over generic message text.
    expect(isStaleChatError(classifyStreamError("CHAT_NOT_FOUND", "Model does not exist"))).toBe(true)
    expect(
      isStaleChatError(classifyJsonError('{"success":false,"code":"CHAT_NOT_FOUND","message":"Model does not exist"}', 200)),
    ).toBe(true)
  })

  test("stale errors never masquerade as quota or challenge", () => {
    const error = classifyJsonError(DELETED_BODY, 200)
    expect(error?.code).not.toBe("rate_limited")
    expect(error?.code).not.toBe("challenge")
    expect(isStaleChatError(classifyJsonError('{"success":false,"code":"RateLimited","message":"slow"}', 429))).toBe(
      false,
    )
  })

  test("staleChatError stamps the canonical recovery marker", () => {
    const error = staleChatError({ status: 200, upstreamCode: "CHAT_NOT_FOUND", detail: "deleted" })
    expect(error.upstreamCode).toBe(STALE_CHAT_UPSTREAM_CODE)
    expect(error.retryable).toBe(true)
    expect(isStaleChatError(error)).toBe(true)
    expect(isStaleChatError(loginRequiredError())).toBe(false)
    expect(isStaleChatError(new Error("chat not found"))).toBe(false)
  })
})

describe("stale anchor vs stale chat (issue 232 binding contract)", () => {
  // A chat id and a continuation anchor are a validated pair, but they fail
  // differently: a dead chat needs a fresh chat, a dead `parent_id` only needs
  // the anchor dropped. Neither may be inferred from generic not-found text.
  const PARENT_BODY = JSON.stringify({
    success: false,
    code: "PARENT_NOT_FOUND",
    message: "parent id not found",
  })

  test("code detection separates the chat from the anchor", () => {
    expect(isStaleAnchorCode("PARENT_NOT_FOUND")).toBe(true)
    expect(isStaleAnchorCode("parent_not_exist")).toBe(true)
    expect(isStaleAnchorCode("Response_Does_Not_Exist")).toBe(true)
    expect(isStaleAnchorCode("response_id_not_exist")).toBe(true)
    expect(isStaleAnchorCode("invalid_parent")).toBe(true)
    // Anchor codes are not chat codes and the other way round.
    expect(isStaleChatCode("PARENT_NOT_FOUND")).toBe(false)
    expect(isStaleAnchorCode("CHAT_NOT_FOUND")).toBe(false)
    // Still no broad not-found matching: a retired model id is neither.
    expect(isStaleAnchorCode("Not_Found")).toBe(false)
    expect(isStaleAnchorCode("Model_Not_Found")).toBe(false)
    expect(isStaleAnchorCode("RateLimited")).toBe(false)
    // A malformed upstream payload is not a stale anchor either.
    expect(isStaleAnchorCode("invalid_response")).toBe(false)
    expect(isStaleAnchorCode("InvalidParameter")).toBe(false)
  })

  test("message detection names the anchor explicitly", () => {
    expect(isStaleAnchorMessage("parent id not found")).toBe(true)
    expect(isStaleAnchorMessage("The response does not exist")).toBe(true)
    expect(isStaleAnchorMessage("parent_id is invalid")).toBe(true)
    expect(isStaleAnchorMessage("no such response")).toBe(true)
    expect(isStaleAnchorMessage("stale parent id")).toBe(true)
    // Generic missing-item wording stays out of both buckets.
    expect(isStaleAnchorMessage("Model does not exist")).toBe(false)
    expect(isStaleAnchorMessage("Attachment file does not exist")).toBe(false)
    expect(isStaleAnchorMessage("invalid response format")).toBe(false)
    expect(isStaleAnchorMessage("chat created")).toBe(false)
    expect(isChatMissingMessage("parent id not found")).toBe(false)
  })

  test("a parent/response payload is an anchor error, not a dead chat", () => {
    const error = classifyJsonError(PARENT_BODY, 200)
    expect(error).toBeDefined()
    expect(isStaleAnchorError(error)).toBe(true)
    expect(isStaleChatError(error)).toBe(false)
    expect(isStaleBindingError(error)).toBe(true)
    expect(error?.retryable).toBe(true)
    expect(error?.upstreamCode).toBe(STALE_ANCHOR_UPSTREAM_CODE)
    expect(error?.message).toContain("PARENT_NOT_FOUND")
  })

  test("anchor detection covers stream, OpenAI and truncated shapes", () => {
    expect(isStaleAnchorError(classifyStreamError("E_UPSTREAM", "parent id not found"))).toBe(true)
    expect(isStaleAnchorError(classifyStreamError("Parent_Not_Exist", "gone"))).toBe(true)
    expect(isStaleAnchorError(classifyJsonError('{"error":{"code":"Parent_Not_Exist","message":"gone"}}', 200))).toBe(
      true,
    )
    const truncated = `{"success":false,"code":"PARENT_NOT_FOUND","message":"parent id not found ${"x".repeat(9000)}`
    expect(() => JSON.parse(truncated)).toThrow()
    expect(isStaleAnchorError(classifyTruncatedJson(truncated, 200))).toBe(true)
  })

  test("anchor classification never wins over quota, challenge or chat wording", () => {
    expect(isStaleAnchorError(classifyStreamError("RateLimited", "quota exceeded"))).toBe(false)
    expect(isStaleAnchorError(classifyJsonError('{"ret":["FAIL_SYS_USER_VALIDATE"]}', 200))).toBe(false)
    // Chat wording outranks an anchor-ish code on the same payload.
    const both = classifyJsonError(
      JSON.stringify({ success: false, code: "CHAT_NOT_FOUND", message: "parent id not found" }),
      200,
    )
    expect(isStaleChatError(both)).toBe(true)
    expect(isStaleAnchorError(both)).toBe(false)
  })

  test("the two markers stay distinguishable for the session layer", () => {
    const anchor = staleAnchorError({ status: 200, upstreamCode: "PARENT_NOT_FOUND", detail: "gone" })
    const chat = staleChatError({ status: 200, upstreamCode: "CHAT_NOT_FOUND", detail: "gone" })
    expect(isStaleAnchorError(anchor)).toBe(true)
    expect(isStaleChatError(anchor)).toBe(false)
    expect(isStaleAnchorError(chat)).toBe(false)
    expect(isStaleChatError(chat)).toBe(true)
    expect(isStaleBindingError(anchor)).toBe(true)
    expect(isStaleBindingError(chat)).toBe(true)
    expect(isStaleBindingError(loginRequiredError())).toBe(false)
    expect(isStaleBindingError(new Error("parent id not found"))).toBe(false)
  })
})

describe("honest empty/truncated error reporting (issue 232)", () => {
  test("empty responses do not promise a safe retry or trigger an automatic retry", () => {
    const error = emptyResponseError()
    expect(error.code).toBe("invalid_response")
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("empty response")
    expect(error.message).toContain("rolled back from local thread history")
    expect(error.message).not.toContain("Nothing was committed")
    expect(error.message).not.toContain("retrying is safe")
  })

  test("truncated JSON salvages the visible fields instead of claiming login", () => {
    // A >8k error body arrives at the classifier cut mid-string: JSON.parse fails.
    const truncatedStale = `{"success":false,"code":"CHAT_NOT_FOUND","message":"This chat has been deleted. ${"x".repeat(9000)}`
    expect(() => JSON.parse(truncatedStale)).toThrow()
    const stale = classifyTruncatedJson(truncatedStale, 200)
    expect(isStaleChatError(stale)).toBe(true)
    expect(stale.retryable).toBe(true)

    const truncatedRate = `{"success":false,"code":"RateLimited","message":"quota exceeded ${"y".repeat(9000)}`
    const rate = classifyTruncatedJson(truncatedRate, 200)
    expect(rate.code).toBe("rate_limited")
    expect(rate.retryable).toBe(true)
  })

  test("unrecognizable truncated JSON is an honest invalid_response", () => {
    const truncated = `{"success":false,"data":{"details":"something broke badly ${"z".repeat(9000)}`
    const error = classifyTruncatedJson(truncated, 200)
    expect(error.code).toBe("invalid_response")
    expect(error.message).not.toContain("login")
    expect(error.message).toContain("truncated")
    expect(error.message).toContain("something broke badly")
    expect(error.retryable).toBe(false)
    // Server-side statuses stay retryable.
    expect(classifyTruncatedJson(truncated, 503).retryable).toBe(true)
  })

  test("non-stream bodies report what they are, never a bogus login", () => {
    const empty = nonStreamResponseError("", 200)
    expect(empty.code).toBe("invalid_response")
    expect(empty.message).toContain("<empty body>")
    expect(empty.message).not.toContain("login")
    const text = nonStreamResponseError("weird plain text", 200)
    expect(text.message).toContain("weird plain text")
    expect(text.retryable).toBe(false)
    expect(nonStreamResponseError("x", 502).retryable).toBe(true)
  })
})

describe("issue 232 workstream 5: phase, status and sanitized detail", () => {
  const SECRETS = ["COOKIE_FIXTURE", "WAF_UA_FIXTURE", "WAF_UMID_FIXTURE", "AUTH_FIXTURE", "ACCESS_FIXTURE", "PRIVATE_PROMPT_FIXTURE"]
  const FIXTURE = [
    "backend rejected request",
    "cookie=COOKIE_FIXTURE",
    "bx-ua: WAF_UA_FIXTURE",
    "bx-umidtoken=WAF_UMID_FIXTURE",
    "Authorization: Bearer AUTH_FIXTURE",
    "access_token=ACCESS_FIXTURE",
    "full prompt: PRIVATE_PROMPT_FIXTURE",
  ].join("; ")

  test("QwenWebError carries phase/detail and sanitizes message, detail and upstream code", () => {
    const error = new QwenWebError({
      code: "upstream_error",
      phase: "setup",
      retryable: true,
      status: 503,
      upstreamCode: "E_UPSTREAM",
      detail: FIXTURE,
      message: `failed: ${FIXTURE}`,
    })
    expect(error.phase).toBe("setup")
    expect(error.status).toBe(503)
    expect(error.upstreamCode).toBe("E_UPSTREAM")
    expect(error.detail).toContain("backend rejected request")
    expect(error.detail!.length).toBeLessThanOrEqual(240)
    for (const secret of SECRETS) {
      expect(error.message).not.toContain(secret)
      expect(error.detail).not.toContain(secret)
    }
    // A credential-shaped upstream code is not a safe code and must be dropped, not echoed.
    const unsafe = new QwenWebError({ code: "upstream_error", message: "x", upstreamCode: "A".repeat(64) })
    expect(unsafe.upstreamCode).toBeUndefined()
    expect(sanitizeQwenErrorText("x".repeat(500))!.length).toBeLessThanOrEqual(240)
    expect(withQwenWebErrorPhase(error, "stream").phase).toBe("setup")
    expect(withQwenWebErrorPhase(new Error("fetch failed"), "setup").phase).toBe("setup")
  })

  test("table: classifiers preserve phase/status/upstream/retryable without leaking secrets", () => {
    const cases = [
      {
        name: "json chat-create",
        make: () => classifyJsonError(JSON.stringify({ success: false, code: "E_CREATE", message: FIXTURE }), 503, "chat-create"),
        phase: "chat-create", code: "upstream_error", status: 503, upstream: "E_CREATE", retryable: true,
      },
      {
        name: "json rate limit preserves actual status",
        make: () => classifyJsonError('{"success":false,"code":"RateLimited","message":"slow"}', 200, "setup"),
        phase: "setup", code: "rate_limited", status: 200, upstream: "RateLimited", retryable: true,
      },
      {
        name: "status auth",
        make: () => classifyStatus(403, "Cookie: COOKIE_FIXTURE"),
        phase: "auth", code: "session_expired", status: 403, upstream: undefined, retryable: false,
      },
      {
        name: "status setup",
        make: () => classifyStatus(503, "Service Unavailable", "setup"),
        phase: "setup", code: "upstream_unavailable", status: 503, upstream: undefined, retryable: true,
      },
      {
        name: "stream generic",
        make: () => classifyStreamError("E_STREAM", FIXTURE, 200),
        phase: "stream", code: "upstream_error", status: 200, upstream: "E_STREAM", retryable: true,
      },
      {
        name: "stream stale anchor keeps current-tree anchor contract",
        make: () => classifyStreamError("Parent_Not_Exist", "parent id not found", 200),
        phase: "stream", code: "upstream_error", status: 200, upstream: "anchor_not_exist", retryable: true,
      },
      {
        name: "truncated",
        make: () => classifyTruncatedJson('{"success":false,"code":"E_TRUNC","message":"cookie=COOKIE_FIXTURE; backend broke', 502),
        phase: "setup", code: "invalid_response", status: 502, upstream: "E_TRUNC", retryable: true,
      },
      {
        name: "transport",
        make: () => classifyTransportFailure(new Error(`fetch failed cookie=COOKIE_FIXTURE`), "setup"),
        phase: "setup", code: "network_error", status: undefined, upstream: undefined, retryable: true,
      },
    ] as const
    for (const c of cases) {
      const error = c.make()!
      expect(error.phase, c.name).toBe(c.phase)
      expect(error.code, c.name).toBe(c.code)
      expect(error.status, c.name).toBe(c.status)
      expect(error.upstreamCode, c.name).toBe(c.upstream)
      expect(error.retryable, c.name).toBe(c.retryable)
      for (const secret of SECRETS) {
        expect(error.message, c.name).not.toContain(secret)
        expect(error.detail ?? "", c.name).not.toContain(secret)
      }
    }
    expect(isStaleAnchorError(classifyStreamError("Parent_Not_Exist", "gone", 200))).toBe(true)
    expect(sessionExpiredError().phase).toBe("auth")
    expect(challengeError().phase).toBe("auth")
    expect(abortedError("stop").phase).toBe("stop")
    expect(abortedError("stop").status).toBe(499)
  })
})
