import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

// A Truncate service whose spill file can never be opened: write() "succeeds"
// with a path inside a directory that does not exist, so the shell tool's
// createWriteStream emits 'error' as soon as it tries to spill. Before the
// fix that error had no listener and crashed the process (uncaughtException).
const brokenTruncate = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed(path.join("/definitely-missing-silvercode-spill-dir", "tool_test")),
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 1024 }),
  }),
)

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Config.node, Agent.node, RuntimeFlags.node]),
  ),
  testInstanceStoreLayer,
  brokenTruncate,
)
const it = testEffect(shellLayer)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "work",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const evalarg = (text: string) => (Shell.name(Shell.acceptable()) === "cmd" ? quote(text) : squote(text))
// PowerShell needs the call operator to invoke a quoted executable path,
// same as the fill() helper in shell.test.ts.
const command = (text: string) => {
  const line = `${bin} -e ${evalarg(text)}`
  return ["pwsh", "powershell"].includes(Shell.name(Shell.acceptable())) ? `& ${line}` : line
}

describe("tool.shell output spill failure", () => {
  it.live("survives a failing spill stream and warns instead of crashing", () =>
    Effect.gen(function* () {
      const commandline = command('for(let i=0;i<200;i++)console.log("x".repeat(64))')
      const info = yield* ShellTool
      const bash = yield* info.init()
      const result = yield* bash.execute(
        { command: commandline } as Tool.InferParameters<typeof ShellTool>,
        ctx,
      )

      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.truncated).toBe(true)
      expect((result.metadata as { outputPath?: string }).outputPath).toBeUndefined()
      expect(result.output).toContain("may be incomplete")
      expect(result.output).not.toContain("Full output saved to")
    }).pipe(provideInstance(projectRoot)),
  )
})
