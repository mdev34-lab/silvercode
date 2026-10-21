#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

// Patch #435: the generated SSE parser yields parsed JSON cast to the event
// type unchecked, so a syntactically valid frame with missing or changed
// fields reached subscribers as a real event. Two parts: the parser reports
// a rejected frame through onSseError and skips it (a throw through the
// existing call path would be caught as a connection error and reconnect-
// replay the same bad frame forever), and both v2 event subscriptions pass
// an envelope validator that rejects frames whose payload is not a shaped
// event. The patches run on the raw generator output, so they match with
// flexible whitespace and let the prettier pass below normalize the result;
// keep them in sync with the committed generated files.
const sseParserPath = "./src/v2/gen/core/serverSentEvents.gen.ts"
const sseParserSource = await Bun.file(sseParserPath).text()
const sseParserPatched = sseParserSource.replace(
  /if \(responseValidator\) \{\s*await responseValidator\(data\);?\s*\}/,
  `if (responseValidator) {
                  // HAND-EDIT (#435, reapplied by script/build.ts): a
                  // malformed event is a bad frame, not a dead connection.
                  // Report it through onSseError and skip the frame; throwing
                  // here would be caught below as a connection error and
                  // trigger a reconnect that replays the same bad frame
                  // forever.
                  try {
                    await responseValidator(data)
                  } catch (error) {
                    onSseError?.(error)
                    continue
                  }
                }`,
)
if (sseParserPatched === sseParserSource) {
  throw new Error(`SSE frame-validation patch did not apply; @hey-api/openapi-ts output may have changed (${sseParserPath})`)
}
await Bun.write(sseParserPath, sseParserPatched)

const sseSdkPath = "./src/v2/gen/sdk.gen.ts"
const sseSdkSource = await Bun.file(sseSdkPath).text()
const wireValidator = (match: string, quote: string, gap: string, comma: string) =>
  match.replace(/\.\.\.options,?/, `responseValidator: validateSseEvent,${gap}...options${comma}`)
const sseSdkPatched = sseSdkSource
  .replace(
    /export class Global extends HeyApiClient \{/,
    `// HAND-EDIT (#435, reapplied by script/build.ts): runtime envelope check
// for SSE events. The generated SSE parser casts parsed JSON to the event
// type unchecked, so both event subscriptions reject frames whose payload is
// not a shaped event (the bad frame is reported through onSseError and
// skipped, the stream continues).
const validateSseEvent = async (data: unknown) => {
  const payload = (data as { payload?: { type?: unknown } } | null)?.payload
  if (typeof data !== "object" || data === null || typeof payload?.type !== "string") {
    const preview = JSON.stringify(data)?.slice(0, 200)
    throw new Error(\`Malformed SSE event frame: \${preview}\`)
  }
}

export class Global extends HeyApiClient {`,
  )
  .replace(/url: (["'])\/global\/event\1,(\s*)\.\.\.options(,?)/, wireValidator)
  .replace(/url: (["'])\/event\1,(\s*)\.\.\.options(,?)/, wireValidator)
if (
  !sseSdkPatched.includes("const validateSseEvent") ||
  (sseSdkPatched.match(/responseValidator: validateSseEvent/g) ?? []).length !== 2
) {
  throw new Error(`SSE event-validator SDK patch did not apply; @hey-api/openapi-ts output may have changed (${sseSdkPath})`)
}
await Bun.write(sseSdkPath, sseSdkPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
