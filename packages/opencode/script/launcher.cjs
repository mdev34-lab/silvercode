#!/usr/bin/env node
// silvercode launcher: the only file the npm package ships. It finds the right
// prebuilt binary for this machine, downloads it once from the GitHub release
// of the same version, checks its SHA-256, caches it and runs it.
"use strict"

const childProcess = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")

const REPO = "mdev34-lab/silvercode"
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))
const version = pkg.version

const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()] ?? os.platform()
const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[os.arch()] ?? os.arch()
const base = `silvercode-ai-${platform}-${arch}`
const exe = platform === "windows" ? "silvercode.exe" : "silvercode"

function supportsAvx2() {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    const r = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
    return r.status === 0 && (r.stdout || "").trim() === "1"
  }
  if (platform === "windows") {
    const cmd =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    for (const shell of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      const r = childProcess.spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      })
      if (r.status !== 0) continue
      const out = (r.stdout || "").trim().toLowerCase()
      if (out === "true" || out === "1") return true
      if (out === "false" || out === "0") return false
    }
  }
  return false
}

function isMusl() {
  if (platform !== "linux") return false
  if (fs.existsSync("/etc/alpine-release")) return true
  const r = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
  return `${r.stdout || ""}${r.stderr || ""}`.toLowerCase().includes("musl")
}

// Release targets in order of preference for this machine.
function candidates() {
  const baseline = arch === "x64" && !supportsAvx2()
  if (platform === "linux") {
    if (isMusl()) {
      if (arch !== "x64") return [`${base}-musl`, base]
      return baseline
        ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
        : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
    }
    if (arch !== "x64") return [base, `${base}-musl`]
    return baseline
      ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
      : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
  }
  if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  return [base]
}

function cacheRoot() {
  if (process.env.SILVERCODE_CACHE_DIR) return process.env.SILVERCODE_CACHE_DIR
  if (platform === "windows") return path.join(process.env.LOCALAPPDATA || os.homedir(), "silvercode", "bin")
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "silvercode", "bin")
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "silvercode", "bin")
}

const releaseBase = process.env.SILVERCODE_RELEASE_URL || `https://github.com/${REPO}/releases/download/v${version}`

async function download(url) {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchTarget(name, sums, dir) {
  const archive = platform === "linux" ? `${name}.tar.gz` : `${name}.zip`
  const expected = sums.get(archive)
  if (!expected) throw new Error(`no checksum listed for ${archive}`)
  const data = await download(`${releaseBase}/${archive}`)
  const actual = crypto.createHash("sha256").update(data).digest("hex")
  if (actual !== expected) throw new Error(`checksum mismatch for ${archive}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "silvercode-"))
  try {
    const file = path.join(tmp, archive)
    fs.writeFileSync(file, data)
    const out = path.join(tmp, "out")
    fs.mkdirSync(out)
    // tar reads .tar.gz everywhere and .zip on macOS and Windows 10+.
    const r = childProcess.spawnSync("tar", ["-xf", file, "-C", out], { windowsHide: true })
    if (r.status !== 0) throw new Error(`could not unpack ${archive} (is tar installed?)`)
    if (!fs.existsSync(path.join(out, exe))) throw new Error(`${archive} has no ${exe}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    fs.renameSync(out, dir)
    if (platform !== "windows") fs.chmodSync(path.join(dir, exe), 0o755)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function install() {
  const dir = path.join(cacheRoot(), version)
  const target = path.join(dir, exe)
  if (fs.existsSync(target)) return target

  const sums = new Map()
  let text
  try {
    text = (await download(`${releaseBase}/SHA256SUMS`)).toString("utf8")
  } catch (error) {
    throw new Error(
      `Could not reach the silvercode ${version} release (${error.message}).\n` +
        `Get a binary from https://github.com/${REPO}/releases/tag/v${version} and set OPENCODE_BIN_PATH to it.`,
    )
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m) sums.set(m[2].trim(), m[1].toLowerCase())
  }

  const errors = []
  for (const name of candidates()) {
    try {
      await fetchTarget(name, sums, dir)
      return target
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
    }
  }
  throw new Error(
    `Could not download silvercode ${version} for ${platform}-${arch}.\n  ${errors.join("\n  ")}\n` +
      `Get a binary from https://github.com/${REPO}/releases/tag/v${version} and set OPENCODE_BIN_PATH to it.`,
  )
}

function run(target) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"]
  const forward = {}
  for (const s of signals) {
    forward[s] = () => {
      try {
        child.kill(s)
      } catch {}
    }
    process.on(s, forward[s])
  }
  child.on("error", (e) => {
    console.error(e.message)
    process.exit(1)
  })
  child.on("exit", (code, signal) => {
    for (const s of signals) process.removeListener(s, forward[s])
    if (signal) return process.kill(process.pid, signal)
    process.exit(typeof code === "number" ? code : 0)
  })
}

async function main() {
  // Run by npm after install: warm the cache, but never fail the install.
  if (process.argv[2] === "--install") {
    if (process.env.OPENCODE_BIN_PATH || process.env.SILVERCODE_SKIP_DOWNLOAD) return
    try {
      await install()
    } catch (error) {
      console.warn(`silvercode: ${error.message}\nIt will try again the first time you run it.`)
    }
    return
  }
  if (process.env.OPENCODE_BIN_PATH) return run(process.env.OPENCODE_BIN_PATH)
  try {
    run(await install())
  } catch (error) {
    console.error(`silvercode: ${error.message}`)
    process.exit(1)
  }
}

module.exports = { candidates, install, main }
if (require.main === module) main()
