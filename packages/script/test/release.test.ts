import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  ENV_NAMES,
  assertNoReleaseConflict,
  EnvConflictError,
  envValue,
  resolveBump,
  resolveEnv,
  resolveRelease,
  resolveVersion,
} from "../src/env"
import {
  assertReleaseVersions,
  isReleaseVersion,
  ReleaseValidationError,
  parseBumpArgs,
  tagForVersion,
  validateReleaseGate,
  validateReleaseVersions,
} from "../src/release"
import { bumpVersion, devVersion, type BumpInput } from "../src/version"
import { rewriteVersion } from "../src/bump"
import { git } from "./helpers/subprocess"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const packageVersion = (await Bun.file(path.join(repoRoot, "package.json")).json()).version as string
// Guaranteed to disagree with whatever the repository currently declares.
const otherVersion = packageVersion === "9.9.9" ? "8.8.8" : "9.9.9"

const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const names of Object.values(ENV_NAMES)) {
    for (const name of names) delete env[name]
  }
  delete env.GITHUB_REF
  delete env.GITHUB_REF_NAME
  return { ...env, ...extra }
}

describe("release environment", () => {
  test("reads SILVERCODE_* first; ALPHACODE_* and OPENCODE_* stay accepted aliases", () => {
    expect(resolveEnv({ SILVERCODE_VERSION: "0.1.1" }).version).toBe("0.1.1")
    expect(resolveEnv({ SILVERCODE_VERSION: "0.1.1", ALPHACODE_VERSION: "0.1.1" }).version).toBe("0.1.1")
    expect(() => resolveEnv({ SILVERCODE_VERSION: "0.1.1", ALPHACODE_VERSION: "0.2.0" })).toThrow(EnvConflictError)
    expect(() => resolveRelease({ SILVERCODE_RELEASE: "false", ALPHACODE_RELEASE: "1" })).toThrow(EnvConflictError)
    expect(resolveEnv({ SILVERCODE_RELEASE: "1" }).release).toBe(true)
  })

  test("reads ALPHACODE_* and falls back to the OPENCODE_* alias", () => {
    expect(resolveEnv({ ALPHACODE_VERSION: "0.1.1" }).version).toBe("0.1.1")
    expect(resolveEnv({ OPENCODE_VERSION: "v0.1.1" }).version).toBe("0.1.1")
    expect(resolveEnv({ ALPHACODE_VERSION: "0.1.1", OPENCODE_VERSION: "0.1.1" }).version).toBe("0.1.1")
    expect(resolveEnv({ ALPHACODE_CHANNEL: "latest" }).channel).toBe("latest")
    expect(resolveEnv({ OPENCODE_CHANNEL: "prod" }).channel).toBe("prod")
  })

  test("leaves every release input unset when nothing is configured", () => {
    expect(resolveEnv({})).toEqual({ release: false })
  })

  test("rejects disagreeing aliases instead of picking one silently", () => {
    expect(() => resolveEnv({ ALPHACODE_VERSION: "0.1.1", OPENCODE_VERSION: "0.2.0" })).toThrow(EnvConflictError)
    expect(() => resolveEnv({ ALPHACODE_CHANNEL: "latest", OPENCODE_CHANNEL: "dev" })).toThrow(EnvConflictError)
    expect(() => envValue({ A: "1", B: "2" }, ["A", "B"])).toThrow(EnvConflictError)
  })

  test("rejects versions that are not SemVer", () => {
    expect(resolveVersion("v1.2.3")).toBe("1.2.3")
    expect(resolveVersion(undefined)).toBeUndefined()
    expect(resolveVersion("   ")).toBeUndefined()
    expect(() => resolveVersion("1.2")).toThrow()
    expect(() => resolveVersion("01.2.3")).toThrow()
  })

  test.each(["auto", "PATCH", " minor ", "major"])("normalizes the bump %s", (input) => {
    const expected = input.trim().toLowerCase() as BumpInput
    expect(resolveBump(input)).toBe(expected)
  })

  test("rejects unknown bumps and leaves an unset bump unset", () => {
    expect(resolveBump(undefined)).toBeUndefined()
    expect(resolveBump("   ")).toBeUndefined()
    expect(() => resolveBump("huge")).toThrow(/Invalid bump/)
  })

  test("treats a release id or flag as a release build", () => {
    expect(resolveEnv({ ALPHACODE_RELEASE: "1" }).release).toBe(true)
    expect(resolveEnv({ OPENCODE_RELEASE_ID: "12345" }).release).toBe(true)
    expect(resolveEnv({ ALPHACODE_RELEASE: "false" }).release).toBe(false)
    expect(resolveRelease({})).toBe(false)
  })

  test("refuses a disabled release flag that contradicts a legacy release id", () => {
    // A new `false` never wins over an inherited id, and never loses to it
    // either: the contradiction is an error, not a silent decision.
    expect(() => resolveRelease({ ALPHACODE_RELEASE: "false", OPENCODE_RELEASE_ID: "12345" })).toThrow(EnvConflictError)
    expect(() => resolveRelease({ ALPHACODE_RELEASE: "0", OPENCODE_RELEASE: "1" })).toThrow(EnvConflictError)
    expect(() =>
      resolveEnv({ ALPHACODE_RELEASE: "false", OPENCODE_RELEASE_ID: "12345" }),
    ).toThrow(EnvConflictError)
    expect(assertNoReleaseConflict({ ALPHACODE_RELEASE: "1", ALPHACODE_RELEASE_ID: "12345" })).toBeUndefined()
    expect(() => assertNoReleaseConflict({ ALPHACODE_RELEASE: "false", OPENCODE_RELEASE_ID: "12345" })).toThrow(
      EnvConflictError,
    )
  })
})

  test("rejects a version override on a non-release channel", () => {
    expect(() => resolveEnv({ ALPHACODE_VERSION: "0.1.1", ALPHACODE_CHANNEL: "dev" })).toThrow(EnvConflictError)
    expect(() => resolveEnv({ OPENCODE_VERSION: "0.1.1", OPENCODE_CHANNEL: "beta" })).toThrow(EnvConflictError)
    expect(resolveEnv({ ALPHACODE_VERSION: "0.1.1", ALPHACODE_CHANNEL: "latest" }).version).toBe("0.1.1")
    expect(resolveEnv({ ALPHACODE_VERSION: "0.1.1" }).version).toBe("0.1.1")
    expect(resolveEnv({ ALPHACODE_CHANNEL: "dev" }).channel).toBe("dev")
  })

describe("release version validation", () => {
  test("accepts facts that describe one version", () => {
    expect(
      validateReleaseVersions({
        packageVersion: "0.1.1",
        executableVersion: "0.1.1",
        runtimeVersion: "0.1.1",
        tag: "v0.1.1",
      }),
    ).toEqual([])
  })

  test("rejects a package/tag/runtime mismatch", () => {
    expect(
      validateReleaseVersions({ packageVersion: "0.1.1", executableVersion: "0.1.0", tag: "v0.1.2", runtimeVersion: "0.1.3" }),
    ).toEqual([
      "packages/opencode/package.json version 0.1.0 does not match root package.json version 0.1.1",
      "tag v0.1.2 does not match root package.json version 0.1.1 (expected v0.1.1)",
      "runtime version 0.1.3 does not match root package.json version 0.1.1",
    ])
  })

  test("rejects a tag that is not a release tag", () => {
    expect(validateReleaseVersions({ packageVersion: "0.1.1", tag: "vscode-v9.9.9" })).toEqual([
      "tag vscode-v9.9.9 is not a release tag (expected vX.Y.Z)",
    ])
    expect(validateReleaseVersions({ packageVersion: "0.1.1", tag: "v0.1.1-rc.1" })).toEqual([
      "tag v0.1.1-rc.1 is not a release tag (expected vX.Y.Z)",
    ])
  })

  test("rejects package metadata that is not a stable SemVer release", () => {
    expect(validateReleaseVersions({ packageVersion: "0.1.1-dev.3+abc1234" })).toEqual([
      "root package.json version 0.1.1-dev.3+abc1234 is not an exact release version (no prerelease, no build metadata); run ./script/bump.ts",
    ])
    expect(validateReleaseVersions({ packageVersion: "nope" })).toEqual([
      'root package.json version "nope" is not valid SemVer',
    ])
  })

  test("rejects a stable version that still carries build metadata", () => {
    const problems = validateReleaseVersions({ packageVersion: "0.1.1+abc1234" })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("0.1.1+abc1234")
    expect(problems[0]).toContain("build metadata")
    expect(isReleaseVersion("0.1.1+abc1234")).toBe(false)
  })

  test("rejects a runtime version that carries build metadata", () => {
    const problems = validateReleaseVersions({
      packageVersion: "0.1.1",
      tag: "v0.1.1",
      runtimeVersion: "0.1.1+abc1234",
    })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("runtime version 0.1.1+abc1234")
  })

  test("a release-check is refused without a tag at HEAD or with a dirty tree", () => {
    expect(validateReleaseGate({ expectedTag: "v0.1.1", tagAtHead: null, dirty: false })).toEqual([
      "HEAD is not tagged v0.1.1; a release must be built from an exact tag checkout",
    ])
    expect(validateReleaseGate({ expectedTag: "v0.1.1", tagAtHead: "v0.1.1", dirty: true })).toEqual([
      "working tree has uncommitted changes to tracked files; a release must be built from a clean checkout",
    ])
  })

  test("a release-check accepts a clean, tagged checkout of the package version", () => {
    expect(validateReleaseGate({ expectedTag: "v0.1.1", tagAtHead: "v0.1.1", dirty: false })).toEqual([])
  })

  test("a release-check is refused when HEAD is tagged with another version", () => {
    expect(validateReleaseGate({ expectedTag: "v0.1.1", tagAtHead: "v0.1.2", dirty: false })).toEqual([
      "HEAD is tagged v0.1.2 but the release version is v0.1.1",
    ])
  })

  test("a bump flag typo is rejected instead of silently running for real", () => {
    expect(() => parseBumpArgs(["--dry-rnu"])).toThrow(/Unknown flag "--dry-rnu"/)
    expect(() => parseBumpArgs(["--dry-rnu"])).toThrow(/--dry-run/)
    expect(parseBumpArgs(["--dry-run"])).toEqual({ bump: "patch", dryRun: true })
    expect(parseBumpArgs(["minor", "--dry-run"])).toEqual({ bump: "minor", dryRun: true })
    expect(() => parseBumpArgs(["patch", "minor"])).toThrow(/at most one bump argument/)
  })

  test("the typo hint stays quiet for flags that merely share a substring", () => {
    expect(() => parseBumpArgs(["--dry-runner"])).toThrow(/^Unknown flag "--dry-runner"\. Supported flags:/)
    expect(() => parseBumpArgs(["--rundown"])).toThrow(/^Unknown flag "--rundown"\. Supported flags:/)
    expect(() => parseBumpArgs(["--dryrun"])).toThrow(/did you mean --dry-run/)
  })

  test("throws with every problem listed", () => {
    try {
      assertReleaseVersions({ packageVersion: "0.1.1", tag: "v0.1.2" })
      throw new Error("expected a ReleaseValidationError")
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseValidationError)
      const failure = error as ReleaseValidationError
      expect(failure.problems).toHaveLength(1)
      expect(failure.message).toContain("does not match root package.json version 0.1.1")
    }
  })
})

describe("release vs development versions", () => {
  test("a development version is never a release version", () => {
    const dev = devVersion("v0.1.0", 3, "abc1234", false)
    expect(dev).toBe("0.1.1-dev.3+abc1234")
    expect(isReleaseVersion(dev)).toBe(false)
    expect(isReleaseVersion(devVersion("v0.1.0", 3, "abc1234", true))).toBe(false)
  })

  test("a bumped version is a release version", () => {
    expect(isReleaseVersion(bumpVersion("0.1.0", "patch"))).toBe(true)
    expect(isReleaseVersion("0.1.0")).toBe(true)
    expect(isReleaseVersion("1.2.3-rc.1")).toBe(false)
    expect(tagForVersion("0.1.1")).toBe("v0.1.1")
  })

  test("a development version cannot be published as a release", () => {
    expect(() =>
      assertReleaseVersions({ packageVersion: "0.1.1", runtimeVersion: devVersion("v0.1.1", 1, "abc1234", false) }),
    ).toThrow(ReleaseValidationError)
  })
})

const probe = async (extra: Record<string, string> = {}) => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      'const { Script } = await import("@opencode-ai/script"); console.log("PROBE " + JSON.stringify({ channel: Script.channel, version: Script.version, packageVersion: Script.packageVersion, preview: Script.preview, release: Script.release }))',
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: cleanEnv(extra) },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("PROBE "))
  return {
    exitCode,
    stderr,
    ...(line
      ? { result: JSON.parse(line.slice("PROBE ".length)) as Record<string, string | boolean> }
      : { result: undefined }),
  }
}

const runScript = async (script: string, args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn(["bun", "run", path.join(repoRoot, "script", script), ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(env),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const runCheck = async (args: string[]) => runScript("release-check.ts", args)

const runCheckWithEnv = async (args: string[], env: Record<string, string>) => runScript("release-check.ts", args, env)

const runBump = async (args: string[]) => runScript("bump.ts", args)

describe("release scripts", () => {
  test(
    "a release build reports the committed package version",
    async () => {
      const { exitCode, result, stderr } = await probe({ ALPHACODE_VERSION: packageVersion })
      expect(exitCode).toBe(0)
      expect(result).toEqual({
        channel: "latest",
        version: packageVersion,
        packageVersion,
        preview: false,
        release: false,
      })
      expect(stderr).not.toContain("Release version validation failed")

      const alias = await probe({ OPENCODE_VERSION: packageVersion })
      expect(alias.exitCode).toBe(0)
      expect(alias.result).toEqual(result)
    },
    120_000,
  )

  test(
    "a development build never reports a stable release version",
    async () => {
      const { exitCode, result } = await probe({ ALPHACODE_CHANNEL: "dev" })
      expect(exitCode).toBe(0)
      expect(result?.preview).toBe(true)
      expect(result?.release).toBe(false)
      expect(result?.packageVersion).toBe(packageVersion)
      expect(String(result?.version)).toMatch(/-dev\./)
    },
    120_000,
  )

  test(
    "publishing is refused when the runtime version disagrees with package metadata",
    async () => {
      const { exitCode, stderr } = await probe({ ALPHACODE_RELEASE: "1", ALPHACODE_VERSION: otherVersion })
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("Release version validation failed")
      expect(stderr).toContain("does not match root package.json version")
    },
    120_000,
  )

  test(
    "release-check accepts the repository metadata and never invents a tag",
    async () => {
      const ok = await runCheck([])
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toContain(`release-check ok: ${packageVersion}`)
      // The tag must be real: HEAD is untagged in a working checkout, so the
      // check says so instead of passing on metadata alone.
      expect(ok.stdout).toContain("no tag at HEAD")

      const mismatch = await runCheck(["--tag", tagForVersion(otherVersion)])
      expect(mismatch.exitCode).toBe(1)
      expect(mismatch.stderr).toContain("does not match root package.json version")
    },
    120_000,
  )

  test(
    "release-check refuses a tag that is not at HEAD",
    async () => {
      // --tag declares which release is being built; it never substitutes for
      // a missing tag. An untagged HEAD must fail the strict check.
      const missing = await runCheck(["--tag", tagForVersion(packageVersion)])
      expect(missing.exitCode).toBe(1)
      expect(missing.stderr).toContain("HEAD is not tagged")
      expect(missing.stderr).toContain("a release must be built from an exact tag checkout")

      // GITHUB_REF_NAME alone must not make an untagged tree pass either.
      const named = await runCheckWithEnv(["--tag", tagForVersion(packageVersion)], {
        GITHUB_REF: `refs/tags/${tagForVersion(packageVersion)}`,
        GITHUB_REF_NAME: tagForVersion(packageVersion),
      })
      expect(named.exitCode).toBe(1)
      expect(named.stderr).toContain("HEAD is not tagged")

      // ...and it must not be consulted at all: a ref name that names some
      // other tag leaves the metadata-only check passing on its own merits.
      const ignored = await runCheckWithEnv([], {
        GITHUB_REF: `refs/tags/${tagForVersion(otherVersion)}`,
        GITHUB_REF_NAME: tagForVersion(otherVersion),
      })
      expect(ignored.exitCode).toBe(0)
      expect(ignored.stdout).toContain(`release-check ok: ${packageVersion}`)
      expect(ignored.stdout).toContain("no tag at HEAD")
    },
    120_000,
  )

  test(
    "release-check rejects an unknown flag",
    async () => {
      const typo = await runCheck(["--tagg", "v9.9.9"])
      expect(typo.exitCode).not.toBe(0)
      expect(typo.stderr).toContain('Unknown flag "--tagg"')
    },
    120_000,
  )

  test(
    "a bumped flag typo is rejected instead of writing a real bump",
    async () => {
      const before = await Bun.file(path.join(repoRoot, "package.json")).text()

      const typo = await runBump(["patch", "--dry-rnu"])
      expect(typo.exitCode).not.toBe(0)
      expect(typo.stderr).toContain('Unknown flag "--dry-rnu"')
      expect(typo.stderr).toContain("--dry-run")
      expect(await Bun.file(path.join(repoRoot, "package.json")).text()).toBe(before)

      const dry = await runBump(["patch", "--dry-run"])
      expect(dry.exitCode).toBe(0)
      expect(dry.stdout).toContain("dry-run:")
      expect(await Bun.file(path.join(repoRoot, "package.json")).text()).toBe(before)

      const tooMany = await runBump(["patch", "minor"])
      expect(tooMany.exitCode).not.toBe(0)
      expect(tooMany.stderr).toContain("at most one bump argument")
      expect(await Bun.file(path.join(repoRoot, "package.json")).text()).toBe(before)
    },
    120_000,
  )

})

describe("implicit release builds from a tag checkout", () => {
  // Tag setup/teardown on the real checkout goes through the shared diagnostic
  // runner, so a git fault here names its exit code, signal, spawn error and
  // stderr instead of throwing a bare `... failed:` with empty stderr (#286).
  const gitRoot = (...args: string[]) => git(repoRoot, ...args)
  // The clean-tree assertions only hold in a clean checkout (CI); a developer
  // with uncommitted changes exercises the dirty-marking test instead.
  const rootDirty =
    Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], {
      cwd: repoRoot,
      stdout: "pipe",
    }).stdout.toString().trim() !== ""

  test.skipIf(rootDirty)("a matching tag at HEAD is a release build reporting the package version", async () => {
    const tag = tagForVersion(packageVersion)
    gitRoot("tag", tag, "HEAD")
    try {
      const { exitCode, result } = await probe({})
      expect(exitCode).toBe(0)
      expect(result).toEqual({
        channel: "latest",
        version: packageVersion,
        packageVersion,
        preview: false,
        release: false,
      })
    } finally {
      gitRoot("tag", "-d", tag)
    }
  }, 120_000)

  test("a dirty checkout of a tag is marked as modified and can never publish", async () => {
    const tag = tagForVersion(packageVersion)
    gitRoot("tag", tag, "HEAD")
    const docFile = path.join(repoRoot, "docs", "releasing.md")
    const before = await Bun.file(docFile).text()
    try {
      await Bun.write(docFile, `${before}\n`)

      const dirty = await probe({})
      expect(dirty.exitCode).toBe(0)
      expect(dirty.result?.channel).toBe("latest")
      expect(dirty.result?.release).toBe(false)
      const escaped = packageVersion.replace(/\./g, "\\.")
      expect(String(dirty.result?.version)).toMatch(new RegExp(`^${escaped}\\+[0-9a-f]{7}\\.dirty$`))

      // The release guard still refuses to publish the marked build.
      const publish = await probe({ ALPHACODE_RELEASE: "1" })
      expect(publish.exitCode).not.toBe(0)
      expect(publish.stderr).toContain("Release version validation failed")
    } finally {
      await Bun.write(docFile, before)
      gitRoot("tag", "-d", tag)
    }
  }, 120_000)

  test("a mismatched tag at HEAD fails instead of silently adopting release semantics", async () => {
    const tag = tagForVersion(otherVersion)
    gitRoot("tag", tag, "HEAD")
    try {
      const { exitCode, stderr } = await probe({})
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("Release version validation failed")
      expect(stderr).toContain("does not match root package.json version")
    } finally {
      gitRoot("tag", "-d", tag)
    }
  }, 120_000)

  test("an explicit channel keeps its semantics on a dirty tag checkout", async () => {
    const tag = tagForVersion(packageVersion)
    gitRoot("tag", tag, "HEAD")
    const docFile = path.join(repoRoot, "docs", "releasing.md")
    const before = await Bun.file(docFile).text()
    try {
      await Bun.write(docFile, `${before}\n`)
      const explicit = await probe({ ALPHACODE_CHANNEL: "latest" })
      expect(explicit.exitCode).toBe(0)
      expect(explicit.result?.version).toBe(packageVersion)
      expect(explicit.result?.channel).toBe("latest")
    } finally {
      await Bun.write(docFile, before)
      gitRoot("tag", "-d", tag)
    }
  }, 120_000)
})

describe("bump version rewrite", () => {
  const manifest = [
    "{",
    '  "name": "demo",',
    '  "config": {',
    '    "version": "9.9.9"',
    "  },",
    '  "version": "0.1.0",',
    '  "dependencies": {',
    '    "left-pad": "1.0.0"',
    "  }",
    "}",
    "",
  ].join("\n")

  test("reads and rewrites only the top-level version field", () => {
    const rewritten = rewriteVersion(manifest, "0.1.0", "0.2.0", "package.json")
    expect(rewritten).toContain('"version": "0.2.0"')
    // The nested field is untouched, byte for byte.
    expect(rewritten).toContain('"version": "9.9.9"')
    expect(rewritten.length).toBe(manifest.length)
    expect(() => rewriteVersion(manifest, "9.9.9", "0.2.0", "package.json")).toThrow(/declares 0.1.0/)
  })

  test("ignores lookalike text inside a string value", () => {
    const tricky = [
      "{",
      '  "description": "nested \\\"version\\\": \\\"9.9.9\\\" example",',
      '  "version": "0.1.0"',
      "}",
      "",
    ].join("\n")
    const rewritten = rewriteVersion(tricky, "0.1.0", "0.2.0", "package.json")
    expect(rewritten).toContain('"version": "0.2.0"')
    expect(rewritten).toContain('\\\"version\\\": \\\"9.9.9\\\"')
    expect(() => rewriteVersion(tricky, "9.9.9", "0.2.0", "package.json")).toThrow(/declares 0.1.0/)
  })

  test("an escaped quote in the version value fails closed", () => {
    // The JSON value would be 0.1.0"evil: the capture swallows the escape
    // whole, so it can never be mistaken for (or rewritten as) a version.
    const evil = '{\n  "version": "0.1.0\\"evil"\n}\n'
    expect(() => rewriteVersion(evil, "0.1.0", "0.2.0", "package.json")).toThrow(/declares 0.1.0\\"/)
    expect(() => rewriteVersion(evil, '0.1.0"evil', "0.2.0", "package.json")).toThrow(/declares 0.1.0\\"/)
  })
})
