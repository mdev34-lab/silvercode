import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { notificationCommand } from "../src/notification"

describe("native notification commands", () => {
  const title = '$(touch /tmp/injected); "quotes" & <xml>'
  const message = "line one\nline two ' ` $HOME"

  test("Windows keeps all user text out of PowerShell source", () => {
    const command = notificationCommand(title, message, "win32", {})!
    expect(command.cmd[0]).toBe("powershell.exe")
    expect(command.cmd).toContain("-STA")
    const script = Buffer.from(command.cmd.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("ShowBalloonTip")
    expect(script).toContain("finally")
    expect(script).not.toContain(title)
    expect(script).not.toContain(message)
    expect(JSON.parse(Buffer.from(command.env!.SILVERCODE_NOTIFICATION!, "base64").toString())).toEqual({
      title,
      message,
    })
  })

  test("macOS passes data as AppleScript argv, not source", () => {
    const command = notificationCommand(title, message, "darwin", {})!
    expect(command.cmd.slice(-3)).toEqual(["--", title, message])
    expect(command.cmd[2]).not.toContain(title)
  })

  test("Linux ends option parsing and does not play a second sound", () => {
    expect(notificationCommand("--help", message, "linux", { WAYLAND_DISPLAY: "wayland-0" })!.cmd).toEqual([
      "notify-send",
      "--app-name=silvercode",
      "--hint=boolean:suppress-sound:true",
      "--",
      "--help",
      message,
    ])
  })

  test("remote, headless and unsupported hosts use terminal fallback", () => {
    expect(notificationCommand(title, message, "linux", {})).toBeUndefined()
    expect(notificationCommand(title, message, "freebsd", {})).toBeUndefined()
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        notificationCommand(title, message, platform, { SSH_CONNECTION: "client server", DISPLAY: ":0" }),
      ).toBeUndefined()
    }
  })
})

describe("helper environment", () => {
  test("Windows keeps runtime paths case-insensitively but drops secrets", () => {
    const command = notificationCommand("title", "message", "win32", {
      Path: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      SILVERCODE_NOTIFICATION: "stale",
    })!
    expect(command.env.Path).toBe("C:\\Windows\\System32")
    expect(command.env.SYSTEMROOT).toBe("C:\\Windows")
    expect(command.env.TEMP).toBe("C:\\Temp")
    expect(Object.keys(command.env).sort()).toEqual(["Path", "SILVERCODE_NOTIFICATION", "SYSTEMROOT", "TEMP"])
    expect(command.env.SILVERCODE_NOTIFICATION).not.toBe("stale")
  })

  test("Unix helpers keep desktop-session variables, not application credentials", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XAUTHORITY: "/home/user/.Xauthority",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require malicious.js",
      LD_PRELOAD: "/tmp/unwanted.so",
    }
    expect(notificationCommand("title", "message", "darwin", env)!.env).toEqual({
      PATH: env.PATH,
      HOME: env.HOME,
      TMPDIR: env.TMPDIR,
      LANG: env.LANG,
    })
    expect(notificationCommand("title", "message", "linux", env)!.env).toEqual({
      PATH: env.PATH,
      HOME: env.HOME,
      LANG: env.LANG,
      DISPLAY: env.DISPLAY,
      WAYLAND_DISPLAY: env.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
      XAUTHORITY: env.XAUTHORITY,
    })
  })
})

// Exercise the actual Bun.spawn boundary in an isolated process, without changing
// the test runner's environment or launching a real desktop notification.
describe.skipIf(process.platform !== "linux")("native helper lifecycle", () => {
  for (const mode of ["success", "abort", "preaborted"] as const) {
    test(mode, async () => {
      const dir = await mkdtemp(join(tmpdir(), "silvercode-notification-"))
      const ready = join(dir, "ready.json")
      const helper = join(dir, "notify-send")
      const module = new URL("../src/notification.ts", import.meta.url).href
      try {
        await Bun.write(
          helper,
          `#!${process.execPath}
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, env: process.env }))
${mode === "abort" ? "setInterval(() => {}, 1000)" : "process.exit(0)"}
`,
        )
        await chmod(helper, 0o755)
        const runner = Bun.spawn(
          [
            process.execPath,
            "-e",
            `
import { notifyNative } from ${JSON.stringify(module)}
const controller = new AbortController()
if (${JSON.stringify(mode)} === "preaborted") controller.abort()
const result = notifyNative("title", "message", controller.signal)
if (${JSON.stringify(mode)} === "abort") {
  const deadline = Date.now() + 2000
  while (!(await Bun.file(${JSON.stringify(ready)}).exists())) {
    if (Date.now() > deadline) throw new Error("helper did not become ready")
    await Bun.sleep(5)
  }
  controller.abort()
}
console.log(await result)
`,
          ],
          {
            env: {
              ...process.env,
              PATH: dir,
              DISPLAY: ":0",
              SSH_CONNECTION: "",
              SSH_CLIENT: "",
              SSH_TTY: "",
              OPENAI_API_KEY: "must-not-leak",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 5000,
          },
        )
        const output = await new Response(runner.stdout).text()
        const error = await new Response(runner.stderr).text()
        expect(error).toBe("")
        expect(await runner.exited).toBe(0)
        expect(output.trim()).toBe(mode === "success" ? "true" : "false")
        expect(await Bun.file(ready).exists()).toBe(mode !== "preaborted")
        if (mode !== "preaborted") {
          const captured = await Bun.file(ready).json()
          expect(captured.env.PATH).toBe(dir)
          expect(captured.env.OPENAI_API_KEY).toBeUndefined()
          expect(() => process.kill(captured.pid, 0)).toThrow()
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
})
