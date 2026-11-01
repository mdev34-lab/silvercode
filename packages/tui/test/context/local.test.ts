import { expect, test } from "bun:test"
import { effortSelection, effortUpdateFor, parseModel, recentModels, selectionUpdate } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("pushes a model update while a session is busy and the model differs", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-b", variant: undefined },
  })
})

test("pushes an update when only the thinking effort changed", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      variant: "high",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-a", variant: "high" },
  })
})

test("treats the default variant as no variant everywhere", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toBeUndefined()
  // Selecting "default" while the row also stores "default" is not a
  // change, and the wire format never carries the string "default".
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      variant: "default",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      variant: "default",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "high" } },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-b", variant: undefined },
  })
})

test("never pushes a selection that belongs to another agent", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      agent: "plan",
      busy: true,
      session: {
        id: "session",
        agent: "work",
        model: { providerID: "provider", id: "model-a", variant: "default" },
      },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      agent: "work",
      busy: true,
      session: {
        id: "session",
        agent: "work",
        model: { providerID: "provider", id: "model-a", variant: "default" },
      },
    }),
  ).toEqual({
    sessionID: "session",
    model: { providerID: "provider", id: "model-b", variant: undefined },
  })
})

test("does not push while the session is idle or the selection already matches", () => {
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-b",
      busy: false,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "default" } },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      variant: "high",
      busy: true,
      session: { id: "session", model: { providerID: "provider", id: "model-a", variant: "high" } },
    }),
  ).toBeUndefined()
  expect(
    selectionUpdate({
      providerID: "provider",
      modelID: "model-a",
      busy: true,
    }),
  ).toBeUndefined()
})

test("effort selection prefers the pending write, then session metadata, then config", () => {
  const config = { agent: { effort: "thorough" } }
  expect(effortSelection({ override: { agentEffort: "fast" }, metadata: { agentEffort: "thorough" }, config })).toBe(
    "fast",
  )
  expect(effortSelection({ metadata: { agentEffort: "thorough" }, config })).toBe("thorough")
  // Untrusted session metadata falls through to the configured default
  // instead of masking it.
  expect(effortSelection({ metadata: { agentEffort: "turbo" }, config })).toBe("thorough")
  expect(effortSelection({ config: { agent: { effort: "fast" } } })).toBe("fast")
  expect(effortSelection({})).toBe("medium")
})

test("a session without a persisted selection starts from config, not a leaked value", () => {
  // Switching sessions only passes that session's own metadata and pending
  // overlay: the previous session's selection is looked up by its session ID
  // and can never bleed into this lookup.
  expect(effortSelection({ metadata: {}, config: { agent: { effort: "fast" } } })).toBe("fast")
  expect(effortSelection({ metadata: {} })).toBe("medium")
  expect(effortSelection({ override: {}, metadata: { agentEffort: "thorough" } })).toBe("thorough")
})

test("effort updates merge over pending and synced metadata for one session", () => {
  const merged = effortUpdateFor({
    sessionID: "ses_a",
    metadata: { agentEffort: "medium", task: "keep-me" },
    level: "fast",
  })
  expect(merged).toEqual({
    sessionID: "ses_a",
    metadata: { agentEffort: "fast", task: "keep-me" },
  })

  // A second rapid selection unions the pending record over the still-stale
  // row, so the first write's keys and any newly synced keys both survive.
  expect(
    effortUpdateFor({
      sessionID: "ses_a",
      override: { agentEffort: "fast", task: "keep-me" },
      metadata: { agentEffort: "medium", task: "keep-me", synced: "new" },
      level: "thorough",
    }),
  ).toEqual({
    sessionID: "ses_a",
    metadata: { agentEffort: "thorough", task: "keep-me", synced: "new" },
  })
})

test("repeating the current effort is idempotent and targets only its session", () => {
  expect(
    effortUpdateFor({ sessionID: "ses_a", metadata: { agentEffort: "fast", other: 1 }, level: "fast" }),
  ).toBeUndefined()
  expect(
    effortUpdateFor({
      sessionID: "ses_a",
      override: { agentEffort: "fast" },
      metadata: { agentEffort: "medium" },
      level: "fast",
    }),
  ).toBeUndefined()
  expect(effortUpdateFor({ sessionID: "ses_b", metadata: { agentEffort: "fast" }, level: "thorough" })).toEqual({
    sessionID: "ses_b",
    metadata: { agentEffort: "thorough" },
  })
})


test("ultra selection survives pending, synced, and configured sources and metadata writes", () => {
  expect(effortSelection({ override: { agentEffort: "ultra" }, metadata: { agentEffort: "fast" } })).toBe("ultra")
  expect(effortSelection({ metadata: { agentEffort: "ultra" } })).toBe("ultra")
  expect(effortSelection({ config: { agent: { effort: "ultra" } } })).toBe("ultra")
  expect(effortUpdateFor({ sessionID: "ses_ultra", metadata: { keep: true }, level: "ultra" })).toEqual({
    sessionID: "ses_ultra", metadata: { keep: true, agentEffort: "ultra" },
  })
  expect(effortUpdateFor({ sessionID: "ses_ultra", metadata: { agentEffort: "ultra" }, level: "ultra" })).toBeUndefined()
})
