import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

test("toasts background dependency install failures at startup", async () => {
  await using tmp = await tmpdir()
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const failures = spyOn(TuiConfig, "installFailures").mockReturnValue(["Could not install @opencode-ai/plugin"])
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi()
  const toast = spyOn(api.ui, "toast")

  try {
    await TuiPluginRuntime.init({ api, config: createTuiResolvedConfig({ plugin: [], plugin_origins: [] }) })
    expect(toast).toHaveBeenCalledWith({
      variant: "error",
      title: "Plugin dependency install failed",
      message: "Could not install @opencode-ai/plugin",
    })
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    failures.mockRestore()
  }
})
