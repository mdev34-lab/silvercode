import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"

const base = "https://skills.example.test/catalog/"

async function pull(
  skills: unknown[],
  files: Record<string, string> = {},
  cache?: Awaited<ReturnType<typeof tmpdir>>,
  failures?: { promotion: boolean; rollback: boolean; invalidBackup?: boolean; seen: string[] },
) {
  const tmp = cache ?? (await tmpdir())
  const requests: string[] = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => requests.push(request.url)).pipe(
        Effect.map(() => {
          const body = request.url === `${base}index.json` ? JSON.stringify({ skills }) : files[request.url]
          return HttpClientResponse.fromWeb(
            request,
            new Response(body ?? "Not Found", { status: body === undefined ? 404 : 200 }),
          )
        }),
      ),
    ),
  )
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return {
        ...fs,
        rename: (source: string, destination: string) => {
          if (failures?.promotion && source.includes(".tmp-") && destination.endsWith("deploy")) {
            failures.promotion = false
            failures.seen.push("promotion")
            return Effect.fail(
              new PlatformError(
                new SystemError({ _tag: "Busy", module: "FileSystem", method: "rename", cause: { code: "EBUSY" } }),
              ),
            )
          }
          if (failures?.rollback && source.includes(".old-") && destination.endsWith("deploy")) {
            failures.rollback = false
            failures.seen.push("rollback")
            return (failures.invalidBackup ? fs.remove(path.join(source, "SKILL.md")) : Effect.void).pipe(
              Effect.andThen(
                Effect.fail(
                  new PlatformError(
                    new SystemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      cause: { code: "EPERM" },
                    }),
                  ),
                ),
              ),
            )
          }
          return fs.rename(source, destination)
        },
      }
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  const skillDiscoveryLayer = AppNodeBuilder.build(SkillDiscovery.node, [
    [LayerNodePlatform.httpClient, http],
    [FSUtil.node, filesystem],
    [Global.node, Global.layerWith({ cache: tmp.path })],
  ])
  const directories = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SkillDiscovery.Service).pull(base)
    }).pipe(Effect.provide(skillDiscoveryLayer)),
  )
  return { tmp, requests, directories }
}

describe("SkillDiscovery.pull", () => {
  test("rejects skill name traversal without fetching files", async () => {
    const result = await pull([{ name: "../outside", files: ["SKILL.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects file traversal without fetching files", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "../outside.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects absolute file paths without fetching files", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "/tmp/outside.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("rejects cross-origin file URLs without fetching files", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "https://evil.example.test/outside.md"] }])
    try {
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([`${base}index.json`])
      expect(await fs.readdir(result.tmp.path)).toEqual([])
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("downloads safe nested files under the skill root", async () => {
    const result = await pull([{ name: "deploy", files: ["SKILL.md", "references/guide.md"] }], {
      [`${base}deploy/SKILL.md`]: "# Deploy",
      [`${base}deploy/references/guide.md`]: "# Guide",
    })
    try {
      expect(result.directories).toHaveLength(1)
      expect(result.requests.toSorted()).toEqual(
        [`${base}index.json`, `${base}deploy/SKILL.md`, `${base}deploy/references/guide.md`].toSorted(),
      )
      expect(await fs.readFile(path.join(result.directories[0], "SKILL.md"), "utf8")).toBe("# Deploy")
      expect(await fs.readFile(path.join(result.directories[0], "references", "guide.md"), "utf8")).toBe("# Guide")
    } finally {
      await result.tmp[Symbol.asyncDispose]()
    }
  })

  test("refreshes cached files when the version changes", async () => {
    const tmp = await tmpdir()
    try {
      const first = await pull(
        [{ name: "deploy", version: "1", files: ["SKILL.md"] }],
        {
          [`${base}deploy/SKILL.md`]: "# Old",
        },
        tmp,
      )
      const second = await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md"] }],
        {
          [`${base}deploy/SKILL.md`]: "# New",
        },
        tmp,
      )

      expect(await fs.readFile(path.join(first.directories[0], "SKILL.md"), "utf8")).toBe("# New")
      expect(second.requests).toContain(`${base}deploy/SKILL.md`)
      const third = await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md"] }],
        { [`${base}deploy/SKILL.md`]: "# Ignored" },
        tmp,
      )
      expect(third.requests).toEqual([`${base}index.json`])
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("publishes complete updates and removes stale files", async () => {
    const tmp = await tmpdir()
    try {
      const first = await pull(
        [{ name: "deploy", version: "1", files: ["SKILL.md", "old.md"] }],
        {
          [`${base}deploy/SKILL.md`]: "# Old",
          [`${base}deploy/old.md`]: "old reference",
        },
        tmp,
      )
      const root = first.directories[0]

      await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md", "missing.md"] }],
        { [`${base}deploy/SKILL.md`]: "# Partial" },
        tmp,
      )
      expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("# Old")
      expect(await fs.readFile(path.join(root, "old.md"), "utf8")).toBe("old reference")

      await pull([{ name: "deploy", version: "3", files: ["SKILL.md"] }], { [`${base}deploy/SKILL.md`]: "# New" }, tmp)
      expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("# New")
      expect(await Bun.file(path.join(root, "old.md")).exists()).toBe(false)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})

for (const scenario of ["single", "double", "empty-cache", "invalid-backup"] as const) {
  test(`retains usable core roots after ${scenario} promotion failure`, async () => {
    const tmp = await tmpdir()
    try {
      const files = { [`${base}deploy/SKILL.md`]: "# Old", [`${base}deploy/ref.md`]: "reference" }
      const old =
        scenario === "empty-cache"
          ? undefined
          : await pull([{ name: "deploy", version: "1", files: ["SKILL.md", "ref.md"] }], files, tmp)
      const failures = {
        promotion: true,
        rollback: scenario === "double" || scenario === "invalid-backup",
        invalidBackup: scenario === "invalid-backup",
        seen: [] as string[],
      }
      const result = await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md"] }],
        { [`${base}deploy/SKILL.md`]: "# New" },
        tmp,
        failures,
      )
      expect(failures.seen).toEqual(
        scenario === "double" || scenario === "invalid-backup" ? ["promotion", "rollback"] : ["promotion"],
      )
      if (scenario === "single" || scenario === "double") {
        expect(result.directories).toHaveLength(1)
        expect(await fs.readFile(path.join(result.directories[0], "SKILL.md"), "utf8")).toBe("# Old")
        expect(await fs.readFile(path.join(result.directories[0], "ref.md"), "utf8")).toBe("reference")
        if (scenario === "single") expect(result.directories[0]).toBe(old!.directories[0])
        else expect(result.directories[0]).toContain(".old-")
      } else expect(result.directories).toEqual([])
      const recovered = await pull(
        [{ name: "deploy", version: "2", files: ["SKILL.md"] }],
        { [`${base}deploy/SKILL.md`]: "# New" },
        tmp,
      )
      expect(await fs.readFile(path.join(recovered.directories[0], "SKILL.md"), "utf8")).toBe("# New")
      if (scenario === "double")
        expect(await fs.readFile(path.join(result.directories[0], "SKILL.md"), "utf8")).toBe("# Old")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
}
