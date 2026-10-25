export * as WorkFlow from "./work-flow"

import type { ReviewHistoryMessage } from "./review-loop"

export const METADATA = "workFlow"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Only runtime-stamped terminal child deliveries in this real request count. */
type History = ReviewHistoryMessage & {
  readonly info?: { readonly role?: unknown; readonly id?: unknown; readonly sessionID?: unknown }
}

export function state(messages: readonly History[], sessionID?: string) {
  const start = messages.findLastIndex(
    (message) =>
      (message.info?.role ?? message.role) === "user" &&
      !(message.parts.length > 0 && message.parts.every((part) => part.synthetic === true)),
  )
  const requestID = messages[start]?.info?.id
  let planned = false
  let implemented = false
  let delegated = false
  for (const message of messages.slice(start + 1)) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "task" || part.state?.status !== "completed") continue
      const metadata = part.state.metadata
      if (!record(metadata) || !record(metadata[METADATA])) continue
      const proof = metadata[METADATA]
      if (
        typeof requestID !== "string" ||
        proof.requestID !== requestID ||
        (sessionID !== undefined && proof.parentID !== sessionID)
      )
        continue
      if (proof.terminal !== "success" || metadata.background !== false || metadata.truncated === true) continue
      if (proof.agent === "general") delegated = true
      if (proof.agent === "think") planned = true
      if (proof.agent === "code" && planned && proof.planned === true) implemented = true
    }
  }
  return { planned, implemented, delegated, requestID }
}

export type Route = {
  requestID: string
  kind: "programming" | "nonprogramming" | "uncertain"
  source: "user-request" | "user-answer"
  reason: string
}

/** Bounded high-precision admission, not a universal semantic intent classifier. */
export function classify(requestID: string, raw: string): Route {
  // The CLI wraps a single spaced argument in quotes. A message that is wholly
  // one quoted span is the user's request, not an example inside one.
  const trimmed = raw.trim()
  const text = /^"(?:[^"\\]|\\.)*"$/.test(trimmed) ? trimmed.slice(1, -1).replace(/\\"/g, '"') : raw
  // Quotes/examples are context, not by themselves the requested action.
  const active = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/"[^"\n]*"|'[^'\n]*'/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  const clauses = active.split(/[;!?\n]+|\bbut\b|\band(?=\s+(?:do not|don't|not asking))|\bmas\b/).filter(Boolean)
  const potentiallyDroppedImplementation =
    /\b(fix|debug|implement|build|refactor|develop|repair|corrig|corrij|consert|desenvolv|refator)\w*/.test(active)
  const positive = clauses.map((clause) => clause.split(/\b(do not|don't|not asking|nao|sem|without)\b/)[0]).join(" ")
  const action =
    /\b(fix|debug|implement|build|refactor|develop|repair|corrig|corrij|consert|implement|desenvolv|refator)\w*/.test(
      positive,
    )
  const software =
    /\b(code|coding|software|function|endpoint|api|bug|repository|repo|codigo|programacao|funcao|aplicativo|application|unit tests?|testes? unitarios?)\b/.test(
      positive,
    )
  const language = /\b(python|typescript|javascript)\b|\b[\w-]+\.(py|ts|tsx|js|jsx)\b/.test(positive)
  const office =
    /\b(list the files|list attachments|save this attachment|save the attachment|list my notes|in my notes|look up note|report|pdf|spreadsheet|slides?|presentation|email|e-mail|research|summari[sz]e|organize|rename|relatorio|planilha|apresentacao|pesquis|resum|renome)\w*/.test(
      positive,
    )
  // Asking for a software artifact is programming only when the verb's direct object is the
  // artifact. Office deliverables ("a report comparing apps") and explanations about how to
  // build something stay out of this rule.
  const primary = positive.split(/\b(?:about|how to|explain\w*|describ\w*|regarding|on how|sobre|como)\b/)[0]
  const modifier =
    "(?!(?:report|email|e-mail|summary|presentation|slides?|pdf|spreadsheet|memo|note|notes|essay|letter|relatorio|resumo|planilha|apresentacao|about|for|of|on|in|with|to|comparing|sobre|para|de)\\b)[a-z0-9+#.-]+"
  const artifactMatch = new RegExp(
    "\\b(?:create|write|make|generate|add|crie|criar|escreva|escrever|faca|fazer|gere|gerar|adicione)\\s+(?:(?:a|an|the|new|my|some|um|uma|novo|nova)\\s+)?(?:" +
      modifier +
      "\\s+){0,3}?(?:scripts?|programs?|apps?|applications?|modules?|librar(?:y|ies)|packages?|clis?|bots?|plugins?|extensions?|websites?|functions?|class(?:es)?|components?|programas?|aplicativos?|modulos?|bibliotecas?|funcoes|funcao|sites?)\\b",
  ).test(primary)
  const artifact = artifactMatch && (language || software || !office)
  if (
    artifact ||
    (action && software) ||
    (action && language && (!office || /\b(fix|debug|repair|corrig|corrij|consert)\w*/.test(positive)))
  )
    return {
      requestID,
      kind: "programming",
      source: "user-request",
      reason: "explicit software implementation or debugging request",
    }
  if (office && !software && !action && !artifactMatch && !potentiallyDroppedImplementation)
    return { requestID, kind: "nonprogramming", source: "user-request", reason: "explicit non-software deliverable" }
  return {
    requestID,
    kind: "uncertain",
    source: "user-request",
    reason: "implementation intent is not explicit; inspect or ask before execution",
  }
}

export function request(messages: readonly History[]) {
  return messages.findLast(
    (message) =>
      (message.info?.role ?? message.role) === "user" &&
      !(message.parts.length > 0 && message.parts.every((part) => part.synthetic === true)),
  )
}

export function admission(messages: readonly History[]): Route | undefined {
  const user = request(messages)
  if (typeof user?.info?.id !== "string") return
  const text = user.parts
    .flatMap((part) => {
      const value = part as { type?: unknown; text?: unknown; ignored?: unknown; synthetic?: unknown }
      return value.type === "text" && typeof value.text === "string" && !value.ignored && !value.synthetic
        ? [value.text]
        : []
    })
    .join("\n")
  return classify(user.info.id, text)
}

const inspection = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "websearch",
  "question",
  "todowrite",
  "task",
  "finish",
  "skill",
  "tool_search",
  "tool_search_regex",
])
export function inspectionTool(id: string) {
  return inspection.has(id)
}

export function complex(text: string) {
  return /\b(complex|complexa|complexo|multi-step|several stages|varias etapas|multiple deliverables)\b/i.test(text)
}

/** An actual native object, with a unique runtime name, owns a role. */
export function ownsRole<T extends { name: string; native?: boolean }>(
  all: readonly T[],
  expected: T | undefined,
  name: string | undefined,
) {
  return expected?.native === true && expected.name === name && all.filter((item) => item.name === name).length === 1
}
