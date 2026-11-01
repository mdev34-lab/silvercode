/**
 * #243 initial-context benchmark fixture — research only, no product code.
 *
 * Captures the first outbound provider request of a pinned build by pointing it at a local
 * recording mock provider, then accounts for every token in the captured request with a pinned
 * tokenizer. No credentials, no live provider, no accounts: the mock is local, the API key is a
 * fixture string, and update/telemetry/models fetches are disabled.
 *
 * Pinned command (see README.md):
 *   bun run docs/research/243-initial-context/measure.ts \
 *     --tokenizer <path-to>/gpt-tokenizer/esm/main.js \
 *     --upstream-bin <path-to>/opencode
 *
 * Engines:
 *   silvercode  this repository, run from source with bun          (default)
 *   upstream    a pinned upstream build, binary path via --upstream-bin
 *
 * The tokenizer is deliberately injectable: the repository ships none, and a count is only
 * meaningful next to the encoding that produced it. Without --tokenizer the script refuses to
 * account rather than silently falling back to a character estimate.
 */
import { spawn } from "bun"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type Recorded = {
  seq: number
  at: string
  method: string
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// recording mock provider (chat-completions surface, the one both build families speak here)
// ---------------------------------------------------------------------------------------------

const isTokenizer = (value: unknown): value is { encode: (text: string) => number[] } =>
  isRecord(value) && typeof value.encode === "function"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const recordList = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter(isRecord) : []

const asText = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)

const sse = (lines: string[]) =>
  new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })

function chatStream() {
  const chunk = (delta: Record<string, unknown>, finish?: string) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(finish ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}),
    })}\n\n`
  return sse([chunk({ role: "assistant" }), chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n"])
}

function startMock() {
  const records: Recorded[] = []
  let seq = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const parsed: unknown = (() => {
        try {
          return JSON.parse(text)
        } catch {
          return { raw: text }
        }
      })()
      const body = isRecord(parsed) ? parsed : { raw: text }
      const headers: Record<string, string> = {}
      req.headers.forEach((value, key) => {
        // Never persist credential-bearing headers; only the protocol shape is recorded.
        if (["content-type", "accept", "anthropic-version"].includes(key.toLowerCase()))
          headers[key.toLowerCase()] = value
      })
      records.push({ seq: seq++, at: new Date().toISOString(), method: req.method, path: url.pathname, headers, body })
      if (!url.pathname.endsWith("/chat/completions"))
        return new Response(`mock: unexpected path ${url.pathname}`, { status: 404 })
      if (body.stream !== true)
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 0,
          model: "mock",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      return chatStream()
    },
  })
  return { port: server.port, records, stop: () => void server.stop(true) }
}

// ---------------------------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------------------------

export type Scenario = {
  id: string
  engine: "silvercode" | "upstream"
  model: string
  prompt: string
  effort?: "fast" | "medium" | "thorough"
  toolSearch?: "default" | "disabled"
  steLite?: "default" | "off"
  instructions?: "empty" | "repo-instructions" | "context-md-only" | "claude-md-only"
  /** keep every captured request in the evidence, not just the first conversation request */
  fullEvidence?: boolean
  repeat?: number
}

export const PROMPT = "Say hello in one word."

export const MATRIX: Scenario[] = [
  {
    id: "alpha-empty-gpt52-medium",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "medium",
    repeat: 3,
    fullEvidence: true,
  },
  { id: "alpha-empty-gpt52-fast", engine: "silvercode", model: "probe/gpt-5.2", prompt: PROMPT, effort: "fast" },
  {
    id: "alpha-empty-gpt52-thorough",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "thorough",
  },
  {
    id: "alpha-empty-gpt52-medium-no-toolsearch",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "medium",
    toolSearch: "disabled",
  },
  {
    id: "alpha-empty-gpt52-medium-no-ste",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "medium",
    steLite: "off",
  },
  {
    id: "alpha-instructions-gpt52-medium",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "medium",
    instructions: "repo-instructions",
    fullEvidence: true,
  },
  {
    id: "alpha-contextmd-only-gpt52-medium",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "medium",
    instructions: "context-md-only",
  },
  {
    id: "alpha-claudemd-only-gpt52-medium",
    engine: "silvercode",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    effort: "medium",
    instructions: "claude-md-only",
  },
  {
    id: "alpha-empty-claude45-medium",
    engine: "silvercode",
    model: "probe/claude-sonnet-4-5",
    prompt: PROMPT,
    effort: "medium",
  },
  { id: "upstream-empty-gpt52", engine: "upstream", model: "probe/gpt-5.2", prompt: PROMPT, fullEvidence: true },
  { id: "upstream-empty-claude45", engine: "upstream", model: "probe/claude-sonnet-4-5", prompt: PROMPT },
  {
    id: "upstream-contextmd-only-gpt52",
    engine: "upstream",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    instructions: "context-md-only",
  },
  {
    id: "upstream-instructions-gpt52",
    engine: "upstream",
    model: "probe/gpt-5.2",
    prompt: PROMPT,
    instructions: "repo-instructions",
    fullEvidence: true,
  },
]

function pinnedConfig(input: { port: number; model: string; scenario: Scenario }) {
  const models = {
    "gpt-5.2": { name: "gpt-5.2", tool_call: true, limit: { context: 400_000, output: 32_000 } },
    "claude-sonnet-4-5": { name: "claude-sonnet-4-5", tool_call: true, limit: { context: 200_000, output: 32_000 } },
  }
  const common = {
    $schema: "https://opencode.ai/config.json",
    model: input.model,
    plugin: [],
    mcp: {},
    lsp: false,
    share: "disabled",
    provider: {
      probe: {
        npm: "@ai-sdk/openai-compatible",
        name: "Probe",
        options: { baseURL: `http://127.0.0.1:${input.port}/v1`, apiKey: "fixture-key-not-a-secret" },
        models,
      },
    },
  }
  // Product-specific knobs are only added for the engine that defines them, so both configs validate.
  if (input.scenario.engine !== "silvercode") return common
  return {
    ...common,
    agent: { effort: input.scenario.effort ?? "medium" },
    ...(input.scenario.toolSearch === "disabled" ? { tool_search: { enabled: false } } : {}),
    ...(input.scenario.steLite === "off" ? { ste_lite: false } : {}),
    ...(input.scenario.instructions === undefined ||
    input.scenario.instructions === "empty" ||
    input.scenario.instructions === "context-md-only" ||
    input.scenario.instructions === "claude-md-only"
      ? { instructions: [] }
      : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------------------------

async function runCapture(input: { scenario: Scenario; repo: string; upstreamBin: string; work: string; out: string }) {
  const scenario = input.scenario
  const mock = startMock()
  const root = path.join(input.work, scenario.id)
  await rm(root, { recursive: true, force: true })
  const project = path.join(root, "project")
  const home = path.join(root, "home")
  const xdg = path.join(root, "xdg")
  await mkdir(project, { recursive: true })
  await mkdir(home, { recursive: true })
  for (const dir of ["config", "data", "cache", "state"]) await mkdir(path.join(xdg, dir), { recursive: true })
  if (scenario.instructions === "repo-instructions") {
    await cp(path.join(input.repo, "AGENTS.md"), path.join(project, "AGENTS.md"))
    await cp(path.join(input.repo, "CONTEXT.md"), path.join(project, "CONTEXT.md"))
  }
  if (scenario.instructions === "context-md-only")
    await cp(path.join(input.repo, "CONTEXT.md"), path.join(project, "CONTEXT.md"))
  if (scenario.instructions === "claude-md-only")
    await cp(path.join(input.repo, "AGENTS.md"), path.join(project, "CLAUDE.md"))
  const config = pinnedConfig({ port: mock.port, model: scenario.model, scenario })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(xdg, "config"),
    XDG_DATA_HOME: path.join(xdg, "data"),
    XDG_CACHE_HOME: path.join(xdg, "cache"),
    XDG_STATE_HOME: path.join(xdg, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    SHELL: "/bin/sh",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
  }
  const cmd =
    scenario.engine === "upstream"
      ? [input.upstreamBin, "run", "--model", scenario.model, scenario.prompt]
      : [
          "bun",
          "run",
          path.join(input.repo, "packages/opencode/src/index.ts"),
          "run",
          "--model",
          scenario.model,
          scenario.prompt,
        ]
  const started = Date.now()
  const proc = spawn({ cmd, cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 180_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  clearTimeout(timer)
  mock.stop()
  const dir = path.join(input.out, "evidence", scenario.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "config.json"), JSON.stringify(config, null, 2))
  await writeFile(
    path.join(dir, "run.json"),
    JSON.stringify(
      {
        scenario,
        exitCode,
        elapsedMs: Date.now() - started,
        project,
        stdout: stdout.slice(0, 4_000),
        stderr: stderr.slice(0, 4_000),
      },
      null,
      2,
    ),
  )
  return { scenario, dir, requests: mock.records, exitCode }
}

// ---------------------------------------------------------------------------------------------
// token accounting
// ---------------------------------------------------------------------------------------------

type Encode = (text: string) => number

async function loadTokenizer(modulePath: string | undefined): Promise<{ encode: Encode; name: string }> {
  if (!modulePath) throw new Error("--tokenizer <path to a gpt-tokenizer entrypoint> is required for a token count")
  const mod: unknown = await import(modulePath)
  if (!isTokenizer(mod)) throw new Error(`not a tokenizer entrypoint: ${modulePath}`)
  return { encode: (text: string) => mod.encode(text).length, name: `gpt-tokenizer(o200k_base) @ ${modulePath}` }
}

const isTitle = (record: Recorded) =>
  JSON.stringify(record.body.messages ?? []).includes("Generate a title for this conversation")

function conversationRequest(records: Recorded[], prompt: string) {
  return records.find((record) => !isTitle(record) && JSON.stringify(record.body.messages ?? []).includes(prompt))
}

function systemText(body: Record<string, unknown>) {
  if (typeof body.system === "string") return body.system
  if (typeof body.instructions === "string") return body.instructions
  const messages = recordList(body.messages)
  return messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
}

function userText(body: Record<string, unknown>) {
  const messages = recordList(body.messages)
  return messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
}

function toolList(body: Record<string, unknown>) {
  return recordList(body.tools).map((entry) => {
    const fn = isRecord(entry.function) ? entry.function : entry
    return {
      name: asText(fn.name, "?"),
      description: asText(fn.description),
      parameters: fn.parameters ?? fn.input_schema ?? {},
      raw: entry,
    }
  })
}

async function sourceFragments(repo: string) {
  const dirs = [
    path.join(repo, "packages/opencode/src/session/prompt"),
    path.join(repo, "packages/opencode/src/agent/prompt"),
  ]
  const out: Array<{ file: string; text: string }> = []
  for (const dir of dirs) {
    for (const file of await readdir(dir)) {
      if (file.endsWith(".txt")) out.push({ file, text: await readFile(path.join(dir, file), "utf8") })
    }
  }
  return out
}

async function account(input: {
  scenario: Scenario
  records: Recorded[]
  encode: Encode
  fragments: Array<{ file: string; text: string }>
}) {
  const encode = input.encode
  const conversation = conversationRequest(input.records, input.scenario.prompt)
  const title = input.records.find(isTitle)
  if (!conversation)
    return {
      id: input.scenario.id,
      engine: input.scenario.engine,
      error: "no conversation request captured",
      requests: input.records.length,
    }
  const body = conversation.body
  const system = systemText(body)
  const list = toolList(body)
  const user = userText(body)

  // Attribute the captured system text to the pinned source files. Exact full-text matches only,
  // so a repeated fragment can never be double counted; whatever is left over is reported as such.
  const matched = input.fragments
    .filter((fragment) => system.includes(fragment.text.trim()))
    .map((fragment) => ({ file: fragment.file, tokens: encode(fragment.text) }))
  const envBlock = /<env>[\s\S]*?<\/env>/.exec(system)?.[0] ?? ""
  const skillsBlock = /Skills provide specialized instructions[\s\S]*?<\/available_skills>/.exec(system)?.[0] ?? ""
  const toolOverview = /<available_tools>[\s\S]*?<\/available_tools>/.exec(system)?.[0] ?? ""
  const effortBlock = /## Agent effort: [\s\S]*/.exec(system)?.[0] ?? ""
  // Instruction files are identified by their loader header only; their token cost is measured as
  // the scenario delta against the empty-project run, which needs no fragile section boundary.
  const instructionFiles = [...system.matchAll(/Instructions from: ([^\n]*)/g)].map((match) => match[1] ?? "")
  const attributed =
    matched.reduce((sum, item) => sum + item.tokens, 0) + encode(envBlock) + encode(skillsBlock) + encode(toolOverview)
  const perTool = list
    .map((tool) => ({
      name: tool.name,
      descriptionTokens: encode(tool.description),
      schemaTokens: encode(JSON.stringify(tool.parameters)),
      rawTokens: encode(JSON.stringify(tool.raw)),
    }))
    .toSorted((a, b) => b.rawTokens - a.rawTokens)

  return {
    id: input.scenario.id,
    engine: input.scenario.engine,
    model: input.scenario.model,
    effort: input.scenario.effort ?? null,
    requests: input.records.length,
    titleRequest: title ? { seq: title.seq, path: title.path, systemTokens: encode(systemText(title.body)) } : null,
    conversationSeq: conversation.seq,
    conversationSystemChars: system.length,
    protocol: { path: conversation.path, keys: Object.keys(body).sort() },
    system: {
      tokens: encode(system),
      sections: {
        promptFiles: matched,
        envBlock: encode(envBlock),
        skillsBlock: encode(skillsBlock),
        toolOverview: encode(toolOverview),
        effortBlock: encode(effortBlock),
        instructionFiles,
        attributed,
        unattributed: encode(system) - attributed,
      },
    },
    tools: {
      count: list.length,
      names: list.map((tool) => tool.name),
      descriptionTokens: perTool.reduce((sum, tool) => sum + tool.descriptionTokens, 0),
      schemaTokens: perTool.reduce((sum, tool) => sum + tool.schemaTokens, 0),
      jsonTokens: encode(JSON.stringify(body.tools ?? [])),
      perTool,
    },
    messages: { userTokens: encode(user), userChars: user.length },
    total: encode(system) + encode(JSON.stringify(body.tools ?? [])) + encode(user),
  }
}

// ---------------------------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------------------------

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (import.meta.main) {
  const repo = arg("repo") ?? path.resolve(import.meta.dir, "../../..")
  const out = arg("out") ?? path.join(import.meta.dir, "results")
  const upstreamBin = arg("upstream-bin") ?? ""
  // The scratch project must live outside the product checkout: both builds walk up from the
  // working directory looking for project config and instruction files, so a project nested inside
  // this repository silently inherits its AGENTS.md and .opencode/opencode.jsonc.
  const work = arg("work-dir") ?? path.join(os.tmpdir(), "opencode-243-initial-context")
  await mkdir(work, { recursive: true })
  const tokenizer = await loadTokenizer(arg("tokenizer"))
  const fragments = await sourceFragments(repo)
  const only = arg("scenario")

  const rows: Array<Awaited<ReturnType<typeof account>>> = []
  for (const scenario of MATRIX.filter((item) => !only || item.id === only)) {
    const repeats = scenario.repeat ?? 1
    for (let index = 0; index < repeats; index++) {
      const id = repeats > 1 ? `${scenario.id}-run${index + 1}` : scenario.id
      const current = { ...scenario, id }
      const result = await runCapture({ scenario: current, repo, upstreamBin, work, out })
      const row = await account({ scenario: current, records: result.requests, encode: tokenizer.encode, fragments })
      rows.push(row)
      const first = result.requests[0]
      const conversation = conversationRequest(result.requests, current.prompt)
      await writeFile(
        path.join(result.dir, "first-request.json"),
        JSON.stringify(
          {
            note: "first conversation request as received by the provider, recorded by the local mock",
            captured: conversation?.at ?? null,
            headers: conversation?.headers ?? null,
            body: conversation?.body ?? null,
          },
          null,
          2,
        ),
      )
      if (current.fullEvidence && index === 0)
        await writeFile(path.join(result.dir, "requests.json"), JSON.stringify(result.requests, null, 2))
      console.log(
        `${id}: exit=${result.exitCode} requests=${result.requests.length} first=${first?.path ?? "none"} ` +
          ("error" in row
            ? `ERROR ${row.error}`
            : `system=${row.system.tokens} tools=${row.tools.jsonTokens} user=${row.messages.userTokens} total=${row.total}`),
      )
    }
  }
  await mkdir(out, { recursive: true })
  await writeFile(
    path.join(out, "accounting.json"),
    JSON.stringify({ capturedAt: new Date().toISOString(), tokenizer: tokenizer.name, rows }, null, 2),
  )
  const comparison = compare(rows, "alpha-empty-gpt52-medium-run1", "upstream-empty-gpt52")
  if (comparison) await writeFile(path.join(out, "comparison.json"), JSON.stringify(comparison, null, 2))
  console.log("wrote", path.join(out, "accounting.json"))
}

/** Matched-delta view of the two primary scenarios, over the captured requests only. */
function compare(rows: Array<Awaited<ReturnType<typeof account>>>, alphaID: string, upstreamID: string) {
  const alpha = rows.find((row) => row.id === alphaID)
  const upstream = rows.find((row) => row.id === upstreamID)
  if (!alpha || !upstream || "error" in alpha || "error" in upstream) return null
  const perTool = (row: typeof alpha) =>
    new Map(row.tools.perTool.map((tool: { name: string; rawTokens: number }) => [tool.name, tool.rawTokens]))
  const alphaTools = perTool(alpha)
  const upstreamTools = perTool(upstream)
  const names = [...new Set([...alphaTools.keys(), ...upstreamTools.keys()])].sort()
  return {
    alpha: alphaID,
    upstream: upstreamID,
    totals: {
      system: { alpha: alpha.system.tokens, upstream: upstream.system.tokens },
      tools: { alpha: alpha.tools.jsonTokens, upstream: upstream.tools.jsonTokens },
      user: { alpha: alpha.messages.userTokens, upstream: upstream.messages.userTokens },
      total: { alpha: alpha.total, upstream: upstream.total, delta: alpha.total - upstream.total },
    },
    tools: {
      onlyAlpha: names.filter((name) => alphaTools.has(name) && !upstreamTools.has(name)),
      onlyUpstream: names.filter((name) => !alphaTools.has(name) && upstreamTools.has(name)),
      perTool: names.map((name) => ({
        name,
        alpha: alphaTools.get(name) ?? 0,
        upstream: upstreamTools.get(name) ?? 0,
        delta: (alphaTools.get(name) ?? 0) - (upstreamTools.get(name) ?? 0),
      })),
    },
    systemSections: {
      envBlock: { alpha: alpha.system.sections.envBlock, upstream: upstream.system.sections.envBlock },
      skillsBlock: { alpha: alpha.system.sections.skillsBlock, upstream: upstream.system.sections.skillsBlock },
      toolOverview: { alpha: alpha.system.sections.toolOverview, upstream: upstream.system.sections.toolOverview },
    },
  }
}
