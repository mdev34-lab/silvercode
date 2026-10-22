import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebFetchTool } from "@opencode-ai/core/tool/webfetch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_webfetch_test")
const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
const assertions: PermissionV2.AssertInput[] = []
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push({ url: request.url, headers: request.headers })).pipe(
      Effect.andThen(respond(request)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebFetchTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ...replacements,
  ])
const it = testEffect(toolLayer([[LayerNodePlatform.httpClient, http]]))
const live = testEffect(toolLayer())

const reset = () => {
  requests.length = 0
  assertions.length = 0
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})

const page =
  "<nav><a href='/'>Home</a></nav><header><a href='/login'>Sign in</a></header>" +
  "<div role='navigation'>Menu</div><div class='cookie-consent'>Accept cookies</div>" +
  "<aside>Related</aside><footer>Copyright</footer>" +
  "<main><h1>Title</h1><p>Body</p></main>"

const withChrome = (body: string) => `<div class='cookie-banner'>We use cookies</div>${body}`

describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide**")
  })
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL without rewriting it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["webfetch"])
      expect(yield* settleTool(registry, call({ url, format: "text", timeout: 4 }))).toEqual({
        result: { type: "text", value: "hello" },
        output: {
          structured: { url, contentType: "text/plain", format: "text", output: "hello" },
          content: [{ type: "text", text: "hello" }],
        },
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text", timeout: 4 } },
      ])
      expect(requests).toMatchObject([{ url, headers: { accept: expect.stringContaining("text/plain;q=1.0") } }])
    }),
  )

  it.effect("accepts localhost URLs with the same requested-URL permission check", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://localhost/private"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "text",
        value: "hello",
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text" } },
      ])
      expect(requests.map((request) => request.url)).toEqual([url])
    }),
  )

  live.effect("follows redirects while approving only the requested URL", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname === "/redirect"
              ? new Response("", { status: 302, headers: { location: "/target" } })
              : new Response("redirected", { headers: { "content-type": "text/plain" } }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          reset()
          const registry = yield* ToolRegistry.Service
          const url = new URL("/redirect", server.url).toString()

          expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
            type: "text",
            value: "redirected",
          })
          expect(assertions).toMatchObject([
            { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text" } },
          ])
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch file:///etc/passwd",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to requested markdown and text", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "markdown" }))).toEqual({
        type: "text",
        value: "# Hello\n\nworld",
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: "Helloworld",
      })
    }),
  )

  it.effect("strips site chrome from markdown while keeping the main content", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.succeed(new Response(page, { headers: { "content-type": "text/html" } }))
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/page", format: "markdown" }))).toEqual({
        type: "text",
        value: "# Title\n\nBody",
      })
    }),
  )

  it.effect("strips site chrome from text while keeping the main content", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.succeed(new Response(page, { headers: { "content-type": "text/html" } }))
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/page", format: "text" }))).toEqual({
        type: "text",
        value: "TitleBody",
      })
    }),
  )

  it.effect("returns raw HTML byte for byte without stripping", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.succeed(new Response(page, { headers: { "content-type": "text/html" } }))
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/page", format: "html" }))).toEqual({
        type: "text",
        value: page,
      })
    }),
  )

  it.effect("keeps legitimate cookie and footer content while removing exact chrome tokens", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      respond = () =>
        Effect.succeed(
          new Response("<article class='cookie-recipe'><h2>Cookie Recipe</h2><p>Mix flour.</p></article>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/recipe", format: "markdown" }))).toEqual({
        type: "text",
        value: "## Cookie Recipe\n\nMix flour.",
      })

      respond = () =>
        Effect.succeed(
          new Response("<div class='footer-note'>See appendix</div><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/note", format: "markdown" }))).toEqual({
        type: "text",
        value: "See appendix\n\nBody",
      })

      respond = () =>
        Effect.succeed(
          new Response("<span class='cookies-page'>Fresh cookies daily</span><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/shop", format: "text" }))).toEqual({
        type: "text",
        value: "Fresh cookies dailyBody",
      })

      respond = () =>
        Effect.succeed(
          new Response("<div class='js-cookie-policy-link'>Policy</div><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/policy", format: "text" }))).toEqual({
        type: "text",
        value: "PolicyBody",
      })
    }),
  )

  it.effect("retains non-chrome tokens that contain punctuation or underscores", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      // Single comma-containing token: HTML classes are whitespace-delimited, so this is one
      // unknown token (not cookie/banner chrome) and must be retained.
      respond = () =>
        Effect.succeed(
          new Response("<div class='consent,cookie,banner'>Consent preferences</div><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/comma", format: "text" }))).toEqual({
        type: "text",
        value: "Consent preferencesBody",
      })

      // Punctuation-wrapped token is not an exact chrome token.
      respond = () =>
        Effect.succeed(
          new Response("<span class='!cookie!'>Cookie policy summary</span><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/bang", format: "text" }))).toEqual({
        type: "text",
        value: "Cookie policy summaryBody",
      })

      // Underscore-edge token is not an exact chrome token.
      respond = () =>
        Effect.succeed(
          new Response("<div class='_cookie_'>Sticky note about cookies</div><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/edge", format: "text" }))).toEqual({
        type: "text",
        value: "Sticky note about cookiesBody",
      })

      // Generic consent/gdpr words alone are not chrome tokens anymore.
      respond = () =>
        Effect.succeed(
          new Response("<article class='gdpr-notice consent'>Your data rights</article><main><p>Body</p></main>", {
            headers: { "content-type": "text/html" },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/rights", format: "text" }))).toEqual({
        type: "text",
        value: "Your data rightsBody",
      })

      // Intended cookie-consent / cookie-banner / site-footer chrome removal retained.
      respond = () =>
        Effect.succeed(
          new Response(
            "<div class='cookie-consent'>Accept all</div><div class='cookie-banner'>We use cookies</div>" +
              "<div class='site-footer'>Copyright</div><main><p>Body</p></main>",
            { headers: { "content-type": "text/html" } },
          ),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/chrome", format: "text" }))).toEqual({
        type: "text",
        value: "Body",
      })
    }),
  )

  it.effect("removes nested cookie consent chrome without touching sibling content", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response(
            "<div class='page'><div class='cookie-banner'>We use cookies</div><div class='content'><p>Real content</p></div></div>",
            { headers: { "content-type": "text/html" } },
          ),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/nested", format: "markdown" }))).toEqual({
        type: "text",
        value: "Real content",
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/nested", format: "text" }))).toEqual({
        type: "text",
        value: "Real content",
      })
    }),
  )

  it.effect("preserves markup of non-chrome nodes when stripping", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response(withChrome("<main><h1>Title</h1><p>Body <strong>bold</strong></p></main>"), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/markup", format: "markdown" }))).toEqual({
        type: "text",
        value: "# Title\n\nBody **bold**",
      })
    }),
  )

  it.effect("returns an error result when HTML-to-Markdown conversion throws", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* ToolRegistry.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, format: "markdown" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
    }),
    // Converting 10k nested divs is CPU-bound; a loaded windows runner crosses
    // bun's 5s default (#487).
    30_000,
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/declared",
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/streamed",
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed settlement can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/image",
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/file",
      })
    }),
  )

  it.effect("retries Cloudflare challenges with an honest user agent", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () =>
        Effect.succeed(
          ++count === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: "ok",
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toContain("Mozilla/5.0")
      expect(requests[1]?.headers["user-agent"]).toBe("opencode")
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* ToolRegistry.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", format: "text", timeout: 1 }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({ type: "error", value: "Unable to fetch https://1.1.1.1/slow" })
    }),
  )
})
