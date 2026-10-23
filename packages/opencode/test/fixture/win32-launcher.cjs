// Test-only entry for the npm launcher: process.platform is pinned to win32
// before the launcher loads so its Windows signal policy runs on every host.
// The launcher passes process.argv.slice(2) to the child, so the child script
// follows this file on the command line unchanged.
Object.defineProperty(process, "platform", { value: "win32" })
require("../../bin/silvercode")
