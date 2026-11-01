import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

test("offers retry, dismiss and log when background installs failed at startup", async () => {
  await using tmp = await tmpdir()
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const failures = spyOn(TuiConfig, "installFailures").mockReturnValue(["Could not install @opencode-ai/plugin"])
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi()
  const replace = spyOn(api.ui.dialog, "replace")

  try {
    await TuiPluginRuntime.init({ api, config: createTuiResolvedConfig({ plugin: [], plugin_origins: [] }) })
    expect(replace).toHaveBeenCalledTimes(1)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    failures.mockRestore()
  }
})
