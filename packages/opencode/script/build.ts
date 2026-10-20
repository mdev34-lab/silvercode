#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import { archiveName, assertReleaseGate, assertReleaseVersions, Script, tagForVersion, uploadReleaseArchives } from "@opencode-ai/script"
import pkg from "../package.json"

// A published build must be an exact, stable, committed version built from the
// release tag on a clean tree - never a dev build and never an untagged tree.
if (Script.release) {
  if (Script.preview) {
    throw new Error(
      `Refusing to publish a preview build (channel "${Script.channel}"). Build from the release tag or set SILVERCODE_CHANNEL=latest.`,
    )
  }
  const packageVersion = Script.packageVersion
  assertReleaseVersions({ packageVersion, runtimeVersion: Script.version })
  assertReleaseGate({
    expectedTag: tagForVersion(packageVersion),
    tagAtHead: await Script.tagAtHead,
    dirty: await Script.dirty,
  })
}

const generated = await import("./generate.ts")

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()

const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
const releaseTargets: { name: string; os: string }[] = []
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/silvercode`,
      execArgv: [`--user-agent=silvercode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
    },
    entrypoints: ["./src/index.ts", workerPath, treeSitterWorkerPath],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      // SILVERCODE_* is the SilverCode runtime version; ALPHACODE_* (pre-rename) and
      // OPENCODE_* stay as aliases so unchanged OpenCode code keeps resolving its globals.
      SILVERCODE_VERSION: `'${Script.version}'`,
      SILVERCODE_CHANNEL: `'${Script.channel}'`,
      ALPHACODE_VERSION: `'${Script.version}'`,
      ALPHACODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      // "undefined" (not "") so the watcher fallback reads it as unset.
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/silvercode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      if (versionOutput.trim() !== Script.version) {
        throw new Error(`Version mismatch: expected ${Script.version}, got ${versionOutput.trim()}`)
      }
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
  releaseTargets.push({ name, os: item.os })
}

if (Script.release) {
  // Upload exactly the archives this build produced. Globbing both extensions
  // breaks a single-target build: one of the two globs matches nothing and the
  // shell fails with "no matches".
  const archives: string[] = []
  for (const target of releaseTargets) {
    const archive = archiveName(target)
    if (target.os === "linux") {
      await $`tar -czf ../../${archive} *`.cwd(`dist/${target.name}/bin`)
    } else {
      await $`zip -r ../../${archive} *`.cwd(`dist/${target.name}/bin`)
    }
    archives.push(`./dist/${archive}`)
  }
  // The npm launcher downloads these archives and checks each against this file.
  const sums = await Promise.all(
    archives.map(async (archive) => {
      const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
      return `${hash}  ${archive.split("/").pop()}\n`
    }),
  )
  await Bun.write("./dist/SHA256SUMS", sums.join(""))
  archives.push("./dist/SHA256SUMS")
  await uploadReleaseArchives(tagForVersion(Script.version), archives)
}

export { binaries }
