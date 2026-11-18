import { CommandV2 } from "@opencode-ai/core/command"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () =>
    response(
      Effect.gen(function* () {
        yield* PluginInternal.Service.use((internal) => internal.ready)
        return yield* CommandV2.Service.use((command) => command.list())
      }),
    ),
  ),
)
