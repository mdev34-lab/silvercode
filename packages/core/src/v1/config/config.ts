export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { AgentEffort } from "@opencode-ai/schema/agent-effort"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigContext } from "../../config/context"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

// The longest permission countdown that can actually be waited out: the timer behind
// `Effect.sleep` takes a 32-bit millisecond timeout, so past 2^31 - 1 ms it never resumes
// and an unanswered prompt would hang its session forever instead of being denied.
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000)

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for silvercode serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'work' if not set or if the specified agent is invalid. The legacy id 'build' is still accepted and resolves to 'work'.",
  }),
  subagent_depth: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents.",
  }),
  review_loop: Schema.optional(
    Schema.Struct({
      max_iterations: Schema.optional(PositiveInt).annotate({
        description: "Maximum review/fix iterations before allowing capped completion. Defaults to 5.",
      }),
    }),
  ).annotate({
    description:
      "Work → Review loop configuration. Finish requires an Approved review of file-writing work until max_iterations completed reviews are reached.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        work: Schema.optional(ConfigAgentV1.Info),
        /** @deprecated legacy id for `work`, still accepted. */
        build: Schema.optional(ConfigAgentV1.Info),
        plan: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        work: Schema.optional(ConfigAgentV1.Info),
        /** @deprecated legacy id for `work`, still accepted and applied to it. */
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
        // The reserved effort policy: a scalar level, or — for legacy
        // compatibility — a named agent literally called `effort` defined as an
        // object. The two are distinguished by shape at every consumer; the
        // scalar form is never enumerated as a named agent.
        effort: Schema.optional(Schema.Union([AgentEffort.Level, ConfigAgentV1.Info])),
      }),
      // StructWithRest intersects declared properties with the rest record for
      // every key, so the rest value type must admit the scalar effort policy
      // as well. Declared agent keys still require ConfigAgentV1.Info via their
      // property signature, so only undeclared keys can resolve to a level and
      // agent enumeration filters scalar values out.
      [Schema.Record(Schema.String, Schema.Union([ConfigAgentV1.Info, AgentEffort.Level]))],
    ),
  ).annotate({
    description:
      "Agent configuration, see https://opencode.ai/docs/agents. The reserved scalar `effort` entry selects the agent effort policy (fast | medium | thorough) and is not a named agent.",
  }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  ste_lite: Schema.optional(Schema.Boolean).annotate({
    description:
      "Inject STE-lite reply style into agent system prompts. Applies to chat only, not deliverables. Enabled by default; set to false to disable.",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  permission_timeout: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Automatically deny permission prompts nobody answers. Enabled by default.",
      }),
      seconds: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))).annotate({
        description: `Countdown in seconds before an unanswered permission prompt is denied (default: 45, maximum: ${MAX_TIMEOUT_SECONDS})`,
      }),
    }),
  ).annotate({
    description:
      "Auto-deny unanswered permission prompts after a countdown so unattended runs never hang. Set enabled to false to wait for a human indefinitely.",
  }),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  tool_search: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description:
          "Defer non-core tools until the model finds them with tool_search. Enabled by default; set to false to always send every tool definition.",
      }),
      always_load: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: 'Tool ID patterns that are never deferred, e.g. "github_*"',
      }),
      defer: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Additional tool ID patterns that are always deferred, even if they are core tools",
      }),
      limit: Schema.optional(PositiveInt).annotate({
        description: "Maximum number of tools returned by a single tool_search call. Defaults to 5.",
      }),
    }),
  ).annotate({
    description:
      "Deferred tool loading: keep non-core tools out of the request until the model finds them with tool_search",
  }),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  context: Schema.optional(ConfigContext.Info).annotate({
    description: "Dynamic context reduction behavior for provider requests",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Maximum number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction. By default retention is limited only by the preserved token budget.",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
