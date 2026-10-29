import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~opencode/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~opencode/WorkspaceRef", {
  defaultValue: () => undefined,
})

export interface HeadlessRunContext {
  readonly maxDelayMs?: number
}

export const HEADLESS_RUN_HEADER = "x-opencode-headless"
export const HEADLESS_RETRY_MAX_DELAY_HEADER = "x-opencode-retry-max-delay"

export const HeadlessRunRef = Context.Reference<HeadlessRunContext | undefined>("~opencode/HeadlessRunRef", {
  defaultValue: () => undefined,
})
