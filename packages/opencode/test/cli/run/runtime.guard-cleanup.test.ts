import { expect, test } from "bun:test"
import vm from "node:vm"

// Drive the actual lifecycle entry through its early setup failure, without
// booting a native renderer. All later runtime dependencies remain unused.
const sourceFile = new URL("../../../src/cli/cmd/run/runtime.lifecycle.ts", import.meta.url)
const source = new Bun.Transpiler({ loader: "ts" })
  .transformSync(await Bun.file(sourceFile).text())
  .replace(/^import[\s\S]*?from ["'][^"']+["'];?\n/gm, "")
  .replaceAll("export ", "")

test("closes resolved terminal input when guard installation throws", async () => {
  let closed = 0
  const failure = new Error("guard install failed")
  const create = vm.runInNewContext(`(() => { ${source}; return createRuntimeLifecycle })()`, {
    resolveInteractiveStdin: () => ({
      stdin: { isTTY: true },
      cleanup: () => {
        closed++
      },
    }),
    win32InstallCtrlCGuard: () => {
      throw failure
    },
  })
  await expect(create({})).rejects.toBe(failure)
  expect(closed).toBe(1)
})
