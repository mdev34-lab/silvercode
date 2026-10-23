// Exercise the actual CJS launcher's signal branch without sending a host OS
// signal. This policy test runs on Windows too; it is not console-event proof.
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import vm from "node:vm"

const filename = path.join(import.meta.dir, "../../bin/silvercode")
const source = await Bun.file(filename).text()

for (const platform of ["win32", "linux"]) {
  test(`launcher ${platform} signal policy and exit cleanup`, () => {
    const forwarded: string[] = []
    const child = Object.assign(new EventEmitter(), { kill: (signal: string) => forwarded.push(signal) })
    const exits: number[] = []
    const proc = Object.assign(new EventEmitter(), {
      platform,
      arch: "x64",
      argv: ["node", filename],
      env: { OPENCODE_BIN_PATH: "fixture-binary" },
      exit: (code: number) => exits.push(code),
    })
    vm.runInNewContext(source, {
      __filename: filename,
      process: proc,
      console,
      require: (name: string) => {
        if (name === "child_process") return { spawn: () => child }
        if (name === "fs") return { realpathSync: () => filename, existsSync: () => true }
        if (name === "path") return path
        if (name === "os") return { platform: () => platform, arch: () => "x64" }
        throw new Error(`unexpected module ${name}`)
      },
    })
    expect(proc.listenerCount("SIGINT")).toBe(1)
    proc.emit("SIGINT")
    expect(forwarded).toEqual(platform === "win32" ? [] : ["SIGINT"])
    proc.emit("SIGTERM")
    proc.emit("SIGHUP")
    expect(forwarded.slice(-2)).toEqual(["SIGTERM", "SIGHUP"])
    child.emit("exit", 7, null)
    expect(exits).toEqual([7])
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(proc.listenerCount(signal)).toBe(0)
  })
}
