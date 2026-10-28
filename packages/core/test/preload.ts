import path from "path"
import { traceAborts } from "./lib/abort-trace"

// Installed before any test file so it covers the whole run; inert unless
// OPENCODE_TRACE_TEST_ABORTS is set (#560).
traceAborts()

process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
