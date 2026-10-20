import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The release surface spans several files that never import each other: the
// installer shell script, the npm package metadata, the postinstall shim, the
// publish scripts, and the publish workflow. A rename has to keep the artifact
// base name, the release repository, and the workflow guard in agreement, or
// the installer 404s and no release can ever be cut. These tests read the files
// as text so a mismatch fails CI instead of shipping.

const root = join(import.meta.dir, "..", "..", "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const REPO = "mdev34-lab/silvercode"

describe("release surface", () => {
  test("installer requests the artifact names that the build publishes", () => {
    const install = read("install")
    // `.trim()` keeps this honest on Windows checkouts, which are CRLF.
    const app = install.match(/^APP=(.+)$/m)?.[1]?.trim()
    expect(app).toBeDefined()

    const pkg = JSON.parse(read("packages/opencode/package.json")) as { name: string; bin: Record<string, string> }
    // `packages/opencode/script/build.ts` names every dist folder and archive
    // after pkg.name, so the installer must request that exact prefix.
    expect(app).toBe(pkg.name)

    // The npm launcher derives the same base when it fetches the release archive.
    expect(read("packages/opencode/script/launcher.cjs")).toContain(`const base = \`${pkg.name}-\${platform}-\${arch}\``)

    // The published binary keeps the product name.
    expect(Object.keys(pkg.bin)).toEqual(["silvercode"])
  })

  test("installer target suffixes mirror the build's artifact matrix", () => {
    // build.ts names a target `pkg.name-os-arch[-baseline][-abi]`; the
    // installer has to append the same qualifiers in the same order or it
    // requests an archive that was never produced.
    const install = read("install")
    expect(install).toContain('target="$os-$arch"')
    const baseline = install.indexOf('target="$target-baseline"')
    const musl = install.indexOf('target="$target-musl"')
    expect(baseline).toBeGreaterThan(-1)
    expect(musl).toBeGreaterThan(baseline)

    const build = read("packages/opencode/script/build.ts")
    const avx2 = build.indexOf('item.avx2 === false ? "baseline" : undefined')
    const abi = build.indexOf("item.abi === undefined ? undefined : item.abi")
    expect(avx2).toBeGreaterThan(-1)
    expect(abi).toBeGreaterThan(avx2)
    expect(build).toContain("const name = [")
    expect(build).toContain('item.os === "win32" ? "windows" : item.os')
  })

  test("installer and updater point at the repository that actually exists", () => {
    const install = read("install")
    expect(install).toContain(`https://github.com/${REPO}/releases/latest/download/install`)
    expect(install).not.toContain("/alphacode/releases")

    const installation = read("packages/opencode/src/installation/index.ts")
    expect(installation).toContain(`const REPO = "${REPO}"`)
  })

  test("publish workflow is gated on the repository owner, not a renamed repo", () => {
    const workflow = read(".github/workflows/publish.yml")
    expect(workflow).toContain("github.repository_owner == 'mdev34-lab'")
    expect(workflow).not.toContain("github.repository == 'mdev34-lab/silvercode'")
  })

  test("installer banner spells the product name", () => {
    const install = read("install")
    // The three-row block banner is drawn as half-cell art; the muted left half
    // spells SILVER and the highlighted right half spells CODE.
    const banner = install.split("\n").filter((line) => line.includes("${MUTED}") && line.includes("█"))
    expect(banner.length).toBeGreaterThanOrEqual(3)
    const art = banner.join("\n")
    expect(art).toContain("█▀▀▀ ▀██▀ █░░░ █░░█ █▀▀█ █▀▀█")
    expect(art).not.toContain("█▀▀█ █░░░ █▀▀█ █░░█ █▀▀█")
  })
})
