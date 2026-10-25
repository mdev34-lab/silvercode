import { describe, expect, beforeAll, afterAll } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { Discovery } from "../../src/skill/discovery"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { rm } from "fs/promises"
import path from "path"
import { testEffect } from "../lib/effect"

let CLOUDFLARE_SKILLS_URL: string
let server: ReturnType<typeof Bun.serve>
let downloadCount = 0
let mutableVersion = "1"
let mutableContent = "# Old"
let mutableDownloadCount = 0
let mutableFiles = ["SKILL.md"]

const fixturePath = path.join(import.meta.dir, "../fixture/skills")
const cacheDir = path.join(Global.Path.cache, "skills")
let failPromotion = false
let failRollback = false
let removeBackupSkill = false
const promotionFailures: string[] = []
const wrappedFs = Layer.effect(FSUtil.Service, Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  return { ...fs, rename: (source: string, dest: string) => {
    if (failPromotion && source.includes(".tmp-") && dest.endsWith("mutable")) {
      failPromotion = false
      promotionFailures.push("injected-promotion-failure")
      return Effect.fail(new PlatformError(new SystemError({_tag:"Busy",module:"FileSystem",method:"rename",cause:{code:"EBUSY"}})))
    }
    if (failRollback && source.includes(".old-") && dest.endsWith("mutable")) {
      failRollback=false
      promotionFailures.push("injected-rollback-failure")
      return (removeBackupSkill ? fs.remove(path.join(source,"SKILL.md")) : Effect.void).pipe(
        Effect.andThen(Effect.fail(new PlatformError(new SystemError({_tag:"PermissionDenied",module:"FileSystem",method:"rename",cause:{code:"EPERM"}})))),
      )
    }
    return fs.rename(source, dest)
  } }
})).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const it = testEffect(LayerNode.compile(LayerNode.group([Discovery.node, FSUtil.node]), [[FSUtil.node, wrappedFs]]))

beforeAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/mutable/index.json") {
        return Response.json({ skills: [{ name: "mutable", version: mutableVersion, files: mutableFiles }] })
      }
      if (url.pathname === "/mutable/mutable/SKILL.md") {
        mutableDownloadCount++
        return new Response(mutableContent)
      }
      if (url.pathname === "/mutable/mutable/old.md") return new Response("old reference")

      // route /.well-known/skills/* to the fixture directory
      if (url.pathname.startsWith("/.well-known/skills/")) {
        const filePath = url.pathname.replace("/.well-known/skills/", "")
        const fullPath = path.join(fixturePath, filePath)

        if (await Filesystem.exists(fullPath)) {
          if (!fullPath.endsWith("index.json")) {
            downloadCount++
          }
          return new Response(Bun.file(fullPath))
        }
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  CLOUDFLARE_SKILLS_URL = `http://localhost:${server.port}/.well-known/skills/`
})

afterAll(async () => {
  void server?.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

describe("Discovery.pull", () => {
  it.live("downloads skills from cloudflare url", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        expect(dir).toStartWith(cacheDir)
        const md = path.join(dir, "SKILL.md")
        expect(yield* fsys.existsSafe(md)).toBe(true)
      }
    }),
  )

  it.live("url without trailing slash works", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL.replace(/\/$/, ""))
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        const md = path.join(dir, "SKILL.md")
        expect(yield* fsys.existsSafe(md)).toBe(true)
      }
    }),
  )

  it.live("returns empty array for invalid url", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/invalid-url/`)
      expect(dirs).toEqual([])
    }),
  )

  it.live("returns empty array for non-json response", () =>
    Effect.gen(function* () {
      // any url not explicitly handled in server returns 404 text "Not Found"
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/some-other-path/`)
      expect(dirs).toEqual([])
    }),
  )

  it.live("downloads reference files alongside SKILL.md", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      // find a skill dir that should have reference files (e.g. agents-sdk)
      const agentsSdk = dirs.find((d) => d.endsWith(path.sep + "agents-sdk"))
      expect(agentsSdk).toBeDefined()
      if (agentsSdk) {
        const refs = path.join(agentsSdk, "references")
        expect(yield* fsys.existsSafe(path.join(agentsSdk, "SKILL.md"))).toBe(true)
        // agents-sdk has reference files per the index
        const refDir = yield* Effect.promise(() =>
          Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: refs, onlyFiles: true })),
        )
        expect(refDir.length).toBeGreaterThan(0)
      }
    }),
  )

  it.live("caches downloaded files on second pull", () =>
    Effect.gen(function* () {
      // clear dir and downloadCount
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      downloadCount = 0
      const discovery = yield* Discovery.Service

      // first pull to populate cache
      const first = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(first.length).toBeGreaterThan(0)
      const firstCount = downloadCount
      expect(firstCount).toBeGreaterThan(0)

      // second pull should return same results from cache
      const second = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(second.length).toBe(first.length)
      expect(second.sort()).toEqual(first.sort())

      // second pull should NOT increment download count
      expect(downloadCount).toBe(firstCount)
    }),
  )

  it.live("refreshes a remote skill when its version changes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      mutableVersion = "1"
      mutableContent = "# Old"
      mutableDownloadCount = 0
      mutableFiles = ["SKILL.md", "old.md"]
      const discovery = yield* Discovery.Service
      const url = `http://localhost:${server.port}/mutable/`

      const first = yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(first[0], "SKILL.md")).text())).toBe("# Old")

      mutableVersion = "2"
      mutableContent = "# Partial"
      mutableFiles = ["SKILL.md", "missing.md"]
      const second = yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "SKILL.md")).text())).toBe("# Old")
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "old.md")).text())).toBe("old reference")

      mutableVersion = "3"
      mutableContent = "# New"
      mutableFiles = ["SKILL.md"]
      yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "SKILL.md")).text())).toBe("# New")
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "old.md")).exists())).toBe(false)
      expect(mutableDownloadCount).toBe(3)

      yield* discovery.pull(url)
      expect(mutableDownloadCount).toBe(3)
    }),
  )
  for (const scenario of ["single", "double", "empty-cache", "invalid-backup"] as const) {
    it.live(`preserves usable roots after ${scenario} promotion failure`,()=>Effect.gen(function*(){
      yield* Effect.promise(()=>rm(cacheDir,{recursive:true,force:true}))
      mutableVersion="rollback-1";mutableContent="# Old";mutableFiles=["SKILL.md","old.md"]
      promotionFailures.length=0
      const discovery=yield* Discovery.Service
      const url=`http://localhost:${server.port}/mutable/`
      const first=scenario==="empty-cache"?[]:yield* discovery.pull(url)
      mutableVersion="rollback-2";mutableContent="# New";mutableFiles=["SKILL.md"]
      failPromotion=true;failRollback=scenario==="double"||scenario==="invalid-backup"
      removeBackupSkill=scenario==="invalid-backup"
      try {
        const result=yield* discovery.pull(url)
        if(scenario==="double"||scenario==="single"){
          expect(result).toHaveLength(1)
          expect(result[0].includes(".old-")).toBe(scenario==="double")
          expect(yield* Effect.promise(()=>Bun.file(path.join(result[0],"SKILL.md")).text())).toBe("# Old")
          expect(yield* Effect.promise(()=>Bun.file(path.join(result[0],"old.md")).text())).toBe("old reference")
          if(scenario==="single")expect(result[0]).toBe(first[0])
          const recovered=yield* discovery.pull(url)
          expect(yield* Effect.promise(()=>Bun.file(path.join(recovered[0],"SKILL.md")).text())).toBe("# New")
          if(scenario==="double")expect(yield* Effect.promise(()=>Bun.file(path.join(result[0],"old.md")).text())).toBe("old reference")
        }else expect(result).toEqual([])
      }finally{failPromotion=false;failRollback=false;removeBackupSkill=false}
    }))
  }

})
