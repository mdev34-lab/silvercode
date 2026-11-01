import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolCatalog } from "@/tool/catalog"
import { SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolCatalog.node, EventV2Bridge.node])))

const sessionInfo = (id: string) =>
  ({
    id,
    slug: "test-session",
    projectID: "prj_test",
    directory: "/tmp",
    title: "test",
    version: "0.0.0",
    time: { created: 1, updated: 1 },
  }) as unknown as SessionV1.SessionInfo

const entry = (input: Partial<ToolCatalog.Entry> & { id: string }): ToolCatalog.Entry => ({
  description: "",
  parameters: [],
  source: "builtin",
  deferred: true,
  ...input,
})

const entries: ToolCatalog.Entry[] = [
  entry({ id: "read", description: "Read the contents of a file from the filesystem", deferred: false }),
  entry({ id: "glob", description: "Find files by name pattern in a directory", deferred: false }),
  entry({ id: "webfetch", description: "Fetch a URL and return the file contents as markdown" }),
  entry({
    id: "github_list_issues",
    description: "List issues in a GitHub repository",
    source: "mcp",
    server: "github",
    parameters: ["owner", "repo"],
  }),
  entry({
    id: "github_create_issue",
    description: "Create a new issue in a GitHub repository",
    source: "mcp",
    server: "github",
  }),
  entry({ id: "linear_search", description: "Search Linear tickets by keyword", source: "mcp", server: "linear" }),
]

describe("ToolCatalog.options", () => {
  it.effect("defaults to enabled with the default limit", () =>
    Effect.sync(() => {
      const options = ToolCatalog.options(undefined)
      expect(options.enabled).toBe(true)
      expect(options.limit).toBe(ToolCatalog.DEFAULT_LIMIT)
      expect(options.alwaysLoad).toEqual([])
      expect(options.defer).toEqual([])
    }),
  )

  it.effect("reads user overrides", () =>
    Effect.sync(() => {
      const options = ToolCatalog.options({
        enabled: false,
        always_load: ["github_*"],
        defer: ["read"],
        limit: 12,
      })
      expect(options).toEqual({ enabled: false, alwaysLoad: ["github_*"], defer: ["read"], limit: 12 })
    }),
  )
})

describe("ToolCatalog.deferred", () => {
  const options = ToolCatalog.options(undefined)

  // #780: the always-loaded set names the shell tool once, under its
  // canonical id; the stale pre-rename "bash" entry must not come back.
  it.effect("core tools list shell exactly once and never bash", () =>
    Effect.sync(() => {
      expect(ToolCatalog.CORE_TOOLS.filter((id) => id === "shell")).toHaveLength(1)
      expect(ToolCatalog.CORE_TOOLS).not.toContain("bash")
    }),
  )

  it.effect("matches legacy bash tool_search names against the renamed shell tool", () =>
    Effect.sync(() => {
      // #780: configs written before the rename defer/always-load `bash`; the tool is `shell` now.
      expect(
        ToolCatalog.deferred({
          id: "shell",
          source: "builtin",
          options: ToolCatalog.options({ defer: ["bash"] }),
        }),
      ).toBe(true)
      expect(
        ToolCatalog.deferred({
          id: "shell",
          source: "builtin",
          options: ToolCatalog.options({ defer: ["*"], always_load: ["bash"] }),
        }),
      ).toBe(false)
    }),
  )

  it.effect("never defers core builtin tools", () =>
    Effect.sync(() => {
      for (const id of ToolCatalog.CORE_TOOLS) {
        expect(ToolCatalog.deferred({ id, source: "builtin", options })).toBe(false)
      }
    }),
  )

  it.effect("defers non-core builtin tools", () =>
    Effect.sync(() => {
      expect(ToolCatalog.deferred({ id: "websearch", source: "builtin", options })).toBe(true)
      expect(ToolCatalog.deferred({ id: "my_custom_tool", source: "builtin", options })).toBe(true)
    }),
  )

  it.effect("defers mcp tools", () =>
    Effect.sync(() => {
      expect(ToolCatalog.deferred({ id: "github_list_issues", source: "mcp", options })).toBe(true)
    }),
  )

  it.effect("defers nothing when disabled", () =>
    Effect.sync(() => {
      const disabled = ToolCatalog.options({ enabled: false })
      expect(ToolCatalog.deferred({ id: "github_list_issues", source: "mcp", options: disabled })).toBe(false)
      expect(ToolCatalog.deferred({ id: "websearch", source: "builtin", options: disabled })).toBe(false)
    }),
  )

  it.effect("honours always_load wildcard patterns", () =>
    Effect.sync(() => {
      const custom = ToolCatalog.options({ always_load: ["github_*"] })
      expect(ToolCatalog.deferred({ id: "github_list_issues", source: "mcp", options: custom })).toBe(false)
      expect(ToolCatalog.deferred({ id: "linear_search", source: "mcp", options: custom })).toBe(true)
    }),
  )

  it.effect("honours defer patterns for core tools", () =>
    Effect.sync(() => {
      const custom = ToolCatalog.options({ defer: ["read"] })
      expect(ToolCatalog.deferred({ id: "read", source: "builtin", options: custom })).toBe(true)
    }),
  )

  it.effect("always_load wins over defer", () =>
    Effect.sync(() => {
      const custom = ToolCatalog.options({ always_load: ["websearch"], defer: ["web*"] })
      expect(ToolCatalog.deferred({ id: "websearch", source: "builtin", options: custom })).toBe(false)
    }),
  )
})

describe("ToolCatalog.deferred precedence", () => {
  const cases: {
    name: string
    config: Parameters<typeof ToolCatalog.options>[0]
    id: string
    source: ToolCatalog.Source
    deferred: boolean
  }[] = [
    { name: "core builtin, no config", config: undefined, id: "read", source: "builtin", deferred: false },
    { name: "other builtin, no config", config: undefined, id: "websearch", source: "builtin", deferred: true },
    { name: "mcp, no config", config: undefined, id: "github_x", source: "mcp", deferred: true },
    {
      name: "disabled beats everything",
      config: { enabled: false, defer: ["*"] },
      id: "github_x",
      source: "mcp",
      deferred: false,
    },
    {
      name: "always_load beats mcp default",
      config: { always_load: ["github_*"] },
      id: "github_x",
      source: "mcp",
      deferred: false,
    },
    {
      name: "always_load beats defer",
      config: { always_load: ["websearch"], defer: ["web*"] },
      id: "websearch",
      source: "builtin",
      deferred: false,
    },
    { name: "defer beats core", config: { defer: ["read"] }, id: "read", source: "builtin", deferred: true },
    {
      name: "defer beats core via wildcard",
      config: { defer: ["re*"] },
      id: "read",
      source: "builtin",
      deferred: true,
    },
    {
      name: "unmatched pattern leaves core alone",
      config: { defer: ["nope*"] },
      id: "read",
      source: "builtin",
      deferred: false,
    },
    {
      name: "always_load on an unrelated tool",
      config: { always_load: ["nope*"] },
      id: "websearch",
      source: "builtin",
      deferred: true,
    },
  ]

  for (const item of cases) {
    it.effect(`${item.name}: ${item.id} -> ${item.deferred ? "deferred" : "loaded"}`, () =>
      Effect.sync(() => {
        expect(
          ToolCatalog.deferred({ id: item.id, source: item.source, options: ToolCatalog.options(item.config) }),
        ).toBe(item.deferred)
      }),
    )
  }
})

describe("ToolCatalog service", () => {
  it.instance("returns nothing before any sync", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      expect(yield* catalog.list()).toEqual([])
      expect(yield* catalog.search("file")).toEqual([])
      expect(yield* catalog.get("read")).toBeUndefined()
    }),
  )

  it.instance("ranks tools by relevance to the query", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const results = yield* catalog.search("github issues")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe("github_list_issues")
      expect(results.map((r) => r.id)).toContain("github_create_issue")
      expect(results.map((r) => r.id)).not.toContain("read")
    }),
  )

  it.instance("limits results and filters by source", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      expect(yield* catalog.search("issue repository", { limit: 1 })).toHaveLength(1)

      const builtin = yield* catalog.search("file", { source: "builtin" })
      expect(builtin.map((item) => item.id)).toEqual(["webfetch"])

      expect(yield* catalog.search("file", { source: "mcp" })).toEqual([])
    }),
  )

  it.instance("searches by regex over id and description", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const results = yield* catalog.searchRegex("github.*issue")
      expect(results.map((r) => r.id).sort()).toEqual(["github_create_issue", "github_list_issues"])

      expect((yield* catalog.searchRegex("^linear")).map((r) => r.id)).toEqual(["linear_search"])
      expect(yield* catalog.searchRegex("ISSUES")).not.toHaveLength(0)
    }),
  )

  it.instance("fails on an invalid regex", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const result = yield* catalog.searchRegex("(unclosed").pipe(Effect.result)
      expect(result._tag).toBe("Failure")
    }),
  )

  it.instance("only surfaces deferred tools, since loaded ones are already in the request", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const ids = (yield* catalog.search("file contents pattern directory")).map((item) => item.id)
      expect(ids).not.toContain("read")
      expect(ids).not.toContain("glob")
      expect(ids).toContain("webfetch")

      expect((yield* catalog.searchRegex("^(read|glob|webfetch)$")).map((item) => item.id)).toEqual(["webfetch"])
    }),
  )

  it.instance("does not return tools this session already discovered", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const session = SessionID.make("ses_repeat")
      const other = SessionID.make("ses_other")

      const first = (yield* catalog.search("github issue repository", { session })).map((item) => item.id)
      expect(first).toContain("github_list_issues")
      yield* catalog.discover(session, first)

      // second search: what the session already holds must not burn a result slot
      const second = (yield* catalog.search("github issue repository", { session })).map((item) => item.id)
      expect(second).not.toContain("github_list_issues")
      for (const id of first) expect(second).not.toContain(id)

      // another session is unaffected
      expect((yield* catalog.search("github issue repository", { session: other })).map((item) => item.id)).toContain(
        "github_list_issues",
      )
      // and includeLoaded still shows everything
      expect(
        (yield* catalog.search("github issue repository", { session, includeLoaded: true })).map((item) => item.id),
      ).toContain("github_list_issues")
    }),
  )

  it.instance("regex search is session aware too", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const session = SessionID.make("ses_repeat_regex")
      yield* catalog.discover(session, ["github_list_issues"])

      const ids = (yield* catalog.searchRegex("^github_", { session })).map((item) => item.id)
      expect(ids).not.toContain("github_list_issues")
      expect(ids).toContain("github_create_issue")
    }),
  )

  it.instance("can include loaded tools when the caller asks for them", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const ids = (yield* catalog.search("file contents", { includeLoaded: true })).map((item) => item.id)
      expect(ids).toContain("read")

      const regex = yield* catalog.searchRegex("^(read|glob)$", { includeLoaded: true })
      expect(regex.map((item) => item.id).sort()).toEqual(["glob", "read"])
    }),
  )

  it.instance("indexes parameter names", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      expect((yield* catalog.search("owner repo")).map((item) => item.id)).toContain("github_list_issues")
    }),
  )

  it.instance("never records a loaded tool as discovered", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const session = SessionID.make("ses_boundary")
      yield* catalog.discover(session, ["read", "github_list_issues", "unknown_tool"])

      expect([...(yield* catalog.discovered(session))]).toEqual(["github_list_issues"])
    }),
  )

  it.instance("tracks discovered tools per session", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      const one = SessionID.make("ses_one")
      const two = SessionID.make("ses_two")

      expect([...(yield* catalog.discovered(one))]).toEqual([])

      yield* catalog.discover(one, ["github_list_issues"])
      yield* catalog.discover(one, ["github_list_issues", "linear_search"])
      expect([...(yield* catalog.discovered(one))].sort()).toEqual(["github_list_issues", "linear_search"])
      expect([...(yield* catalog.discovered(two))]).toEqual([])

      yield* catalog.forget(one)
      expect([...(yield* catalog.discovered(one))]).toEqual([])
    }),
  )

  it.instance("uses the configured limit as the default for both searches", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries, ToolCatalog.options({ limit: 2 }))

      expect(yield* catalog.search("issue repository github file")).toHaveLength(2)
      expect(yield* catalog.searchRegex("e")).toHaveLength(2)
      expect(yield* catalog.search("issue repository github file", { limit: 1 })).toHaveLength(1)
    }),
  )

  it.instance("keyword and regex search see exactly the same corpus", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      const filler = "lorem ipsum ".repeat(400)
      yield* catalog.sync([
        entry({ id: "verbose_tool", description: `${filler} zzzbeyond` }),
        entry({ id: "short_tool", description: "zzznear the start" }),
      ])

      // A term past the truncation point is invisible to both, never to just one of them
      const keyword = (yield* catalog.search("zzzbeyond")).map((item) => item.id)
      const regex = (yield* catalog.searchRegex("zzzbeyond")).map((item) => item.id)
      expect(keyword).toEqual(regex)

      expect((yield* catalog.search("zzznear")).map((item) => item.id)).toEqual(["short_tool"])
      expect((yield* catalog.searchRegex("zzznear")).map((item) => item.id)).toEqual(["short_tool"])
    }),
  )

  it.instance("regex search reads parameter names too, like the keyword search", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync([
        entry({
          id: "postgres_query",
          description: "Run a read-only query against the connected database",
          parameters: ["sql", "params"],
        }),
        entry({ id: "notion_search", description: "Search Notion pages", parameters: ["query"] }),
      ])

      expect((yield* catalog.search("sql")).map((item) => item.id)).toEqual(["postgres_query"])
      expect((yield* catalog.searchRegex("sql")).map((item) => item.id)).toEqual(["postgres_query"])
    }),
  )

  it.instance("anchored patterns still apply per field", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync([
        entry({ id: "postgres_query", description: "Run a query", parameters: ["sql"] }),
        entry({ id: "notion_search", description: "mentions postgres in the middle", parameters: ["query"] }),
      ])

      expect((yield* catalog.searchRegex("^postgres")).map((item) => item.id)).toEqual(["postgres_query"])
      expect((yield* catalog.searchRegex("^sql$")).map((item) => item.id)).toEqual(["postgres_query"])
    }),
  )

  it.instance("rejects patterns that can blow up the regex engine", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      for (const pattern of [
        "(a+)+$",
        "(a|a)*b",
        "(a|aa)+",
        "(x*)*y",
        "((a+))+",
        "(\\w+\\s?)*$",
        "(x)\\1+",
        "a{1,50000}",
        "(ab){2000,}",
        "a".repeat(300),
      ]) {
        const result = yield* catalog.searchRegex(pattern).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }
    }),
  )

  it.instance("still accepts ordinary patterns", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)

      expect((yield* catalog.searchRegex("(github|linear)_")).length).toBeGreaterThan(0)
      expect((yield* catalog.searchRegex("^github_[a-z_]+$")).length).toBeGreaterThan(0)
      expect((yield* catalog.searchRegex("issues?")).length).toBeGreaterThan(0)
    }),
  )

  it.instance("reindexes when a description changes without changing length", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync([entry({ id: "tool_a", description: "Search GitHub issues" })])
      yield* catalog.sync([entry({ id: "tool_a", description: "Create GitHub ticket" })])

      expect((yield* catalog.search("ticket")).map((r) => r.id)).toEqual(["tool_a"])
      expect(yield* catalog.search("issues")).toEqual([])
    }),
  )

  it.instance("forgets a session's discoveries when the session is deleted", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      const events = yield* EventV2Bridge.Service
      yield* catalog.sync(entries)

      const session = SessionID.make("ses_deleted")
      const other = SessionID.make("ses_kept")
      yield* catalog.discover(session, ["github_list_issues"])
      yield* catalog.discover(other, ["github_list_issues"])

      yield* events.publish(SessionV1.Event.Deleted, { sessionID: session, info: sessionInfo(session) })

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const discovered = yield* catalog.discovered(session)
          return discovered.size === 0 ? true : undefined
        }),
        "discovered tools were not forgotten after session.deleted",
        "3 seconds",
      )
      expect([...(yield* catalog.discovered(other))]).toEqual(["github_list_issues"])
    }),
  )

  it.instance("replaces the index when the catalog is re-synced", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(entries)
      yield* catalog.sync([entry({ id: "notion_page", description: "Read a Notion page", source: "mcp" })])

      expect(yield* catalog.get("github_list_issues")).toBeUndefined()
      expect((yield* catalog.search("notion")).map((r) => r.id)).toEqual(["notion_page"])
      expect(yield* catalog.list()).toHaveLength(1)
    }),
  )
})

describe("ToolCatalog.collapseToolNames", () => {
  test("returns no lines for an empty list", () => {
    expect(ToolCatalog.collapseToolNames([])).toEqual([])
  })

  test("lists a single tool by name", () => {
    expect(ToolCatalog.collapseToolNames(["read"])).toEqual(["read"])
  })

  test("lists tools without an underscore nominally", () => {
    expect(ToolCatalog.collapseToolNames(["read", "write", "edit"])).toEqual(["edit, read, write"])
  })

  test("collapses a family of three or more into a prefix wildcard", () => {
    expect(ToolCatalog.collapseToolNames(["playwright_click", "playwright_fill", "playwright_screenshot"])).toEqual([
      "playwright_* (3)",
    ])
  })

  test("collapses each family with its member count", () => {
    const playwright = Array.from({ length: 12 }, (_, i) => `playwright_${i}`)
    const github = Array.from({ length: 7 }, (_, i) => `github_${i}`)
    expect(ToolCatalog.collapseToolNames([...playwright, ...github])).toEqual(["playwright_* (12)", "github_* (7)"])
  })

  test("uses the longest common segment prefix, not just the first segment", () => {
    expect(ToolCatalog.collapseToolNames(["github_create_issue", "github_create_pr", "github_create_branch"])).toEqual([
      "github_create_* (3)",
    ])
  })

  test("falls back to the family prefix when siblings diverge at the second segment", () => {
    expect(ToolCatalog.collapseToolNames(["github_pr_get", "github_actions_run", "github_create_issue"])).toEqual([
      "github_* (3)",
    ])
  })

  test("lists pairs nominally even when they share a prefix", () => {
    expect(ToolCatalog.collapseToolNames(["sentry_create_issue", "sentry_list_projects"])).toEqual([
      "sentry_create_issue, sentry_list_projects",
    ])
    expect(ToolCatalog.collapseToolNames(["github_create_issue", "github_create_pr"])).toEqual([
      "github_create_issue, github_create_pr",
    ])
  })

  test("orders collapsed families by count descending, then label ascending", () => {
    expect(ToolCatalog.collapseToolNames(["b_one", "b_two", "b_three", "a_one", "a_two", "a_three"])).toEqual([
      "a_* (3)",
      "b_* (3)",
    ])
  })

  test("puts collapsed families before the nominal line", () => {
    expect(
      ToolCatalog.collapseToolNames(["github_pr_get", "github_actions_run", "github_create_issue", "z_solo", "read"]),
    ).toEqual(["github_* (3)", "read, z_solo"])
  })

  test("renders the user-facing example exactly", () => {
    const playwright = Array.from({ length: 12 }, (_, i) => `playwright_${i}`)
    const github = [
      "github_create_issue",
      "github_list_projects",
      "github_get_issue",
      "github_actions_run",
      "github_pr_get",
      "github_pr_merge",
      "github_repo",
    ]
    expect(
      ToolCatalog.collapseToolNames([...playwright, ...github, "sentry_create_issue", "sentry_list_projects"]),
    ).toEqual(["playwright_* (12)", "github_* (7)", "sentry_create_issue, sentry_list_projects"])
  })
})

describe("ToolCatalog.overview", () => {
  const family = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => entry({ id: `${prefix}_${i}`, source: "mcp", server: prefix }))

  it.instance("returns nothing before any sync", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      expect(yield* catalog.overview(SessionID.make("ses_overview"))).toBeUndefined()
    }),
  )

  it.instance("renders only deferred tools the session has not discovered", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync([
        entry({ id: "read", deferred: false }),
        entry({ id: "webfetch" }),
        ...family("github", 3),
        ...family("playwright", 3),
      ])

      expect(yield* catalog.overview(SessionID.make("ses_overview"))).toBe(
        ["<available_tools>", "github_* (3)", "playwright_* (3)", "webfetch", "</available_tools>"].join("\n"),
      )
    }),
  )

  it.instance("drops discovered tools and re-collapses the remaining family", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync(family("github", 4))
      const session = SessionID.make("ses_overview")

      expect(yield* catalog.overview(session)).toContain("github_* (4)")

      yield* catalog.discover(session, ["github_0", "github_1"])
      expect(yield* catalog.overview(session)).toBe(
        ["<available_tools>", "github_2, github_3", "</available_tools>"].join("\n"),
      )

      yield* catalog.discover(session, ["github_2", "github_3"])
      expect(yield* catalog.overview(session)).toBeUndefined()
    }),
  )

  it.instance("never lists loaded tools", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync([entry({ id: "read", deferred: false }), entry({ id: "webfetch" })])

      const block = yield* catalog.overview(SessionID.make("ses_overview"))
      expect(block).not.toContain("read")
      expect(block).toContain("webfetch")
    }),
  )

  it.instance("returns nothing when every entry is loaded", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      yield* catalog.sync([entry({ id: "read", deferred: false }), entry({ id: "glob", deferred: false })])

      expect(yield* catalog.overview(SessionID.make("ses_overview"))).toBeUndefined()
    }),
  )
})
