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

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
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

describe("tool.shell signal death", () => {
  it.live("completes with the collected output when the command dies by a signal", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      // The shell itself dies by the signal, so the child's exit code is null
      // and the runtime reports the signal death instead of an exit code.
      const command = `echo before && kill -TERM $$`
      const info = yield* ShellTool
      const bash = yield* info.init()
      const result = yield* bash.execute({ command } as Tool.InferParameters<typeof ShellTool>, ctx)

      expect(result.metadata.exit).toBe(null)
      expect(result.output).toContain("before")
      expect(result.output).toContain("terminated by signal SIGTERM")
    }).pipe(provideInstance(projectRoot)),
  )
})
