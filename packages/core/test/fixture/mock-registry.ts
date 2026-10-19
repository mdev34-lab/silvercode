import http from "node:http"
import net from "node:net"
import zlib from "node:zlib"
import crypto from "node:crypto"

export interface MockPackageSpec {
  name: string
  version: string
  main?: string
  files?: Record<string, string>
  dependencies?: Record<string, string>
  bin?: string | Record<string, string>
}

export interface MockRequestLog {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  timestamp: number
}

export type MockRegistryBehavior =
  | { mode: "normal" }
  | { mode: "error"; statusCode?: number; body?: string }
  | { mode: "stall"; delayMs?: number }
  | { mode: "socket-destroy" }
  | { mode: "tarball-error"; statusCode?: number; body?: string }
  | { mode: "tarball-stall"; delayMs?: number }
  | { mode: "tarball-socket-destroy" }

export function createTar(files: Record<string, string | Buffer>): Buffer {
  const chunks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content
    const header = Buffer.alloc(512, 0)

    // name (0..99)
    header.write(name, 0, 100, "utf8")
    // mode (100..107)
    header.write("0000644\0", 100, 8, "ascii")
    // uid (108..115)
    header.write("0000000\0", 108, 8, "ascii")
    // gid (116..123)
    header.write("0000000\0", 116, 8, "ascii")
    // size (124..135)
    const sizeOctal = data.length.toString(8).padStart(11, "0") + "\0"
    header.write(sizeOctal, 124, 12, "ascii")
    // mtime (136..147)
    header.write("00000000000\0", 136, 12, "ascii")
    // typeflag (156)
    header.write("0", 156, 1, "ascii")
    // magic (257..262)
    header.write("ustar\0", 257, 6, "ascii")
    // version (263..264)
    header.write("00", 263, 2, "ascii")

    // checksum (148..155): compute with spaces
    header.fill(32, 148, 156)
    let chk = 0
    for (let i = 0; i < 512; i++) chk += header[i]
    const chkOctal = chk.toString(8).padStart(6, "0") + "\0 "
    header.write(chkOctal, 148, 8, "ascii")

    chunks.push(header)
    chunks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

export function createTgz(files: Record<string, string | Buffer>): {
  tgz: Buffer
  shasum: string
  integrity: string
} {
  const tar = createTar(files)
  const tgz = zlib.gzipSync(tar)
  const shasum = crypto.createHash("sha1").update(tgz).digest("hex")
  const sha512 = crypto.createHash("sha512").update(tgz).digest("base64")
  const integrity = `sha512-${sha512}`
  return { tgz, shasum, integrity }
}

export class MockRegistry {
  private server: http.Server
  private sockets = new Set<net.Socket>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  public requests: MockRequestLog[] = []
  private packages = new Map<
    string,
    Map<
      string,
      {
        tgz: Buffer
        shasum: string
        integrity: string
        pkgJson: Record<string, unknown>
      }
    >
  >()
  public behavior: MockRegistryBehavior = { mode: "normal" }
  public port = 0
  public url = ""

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on("connection", (socket) => {
      this.sockets.add(socket)
      socket.on("close", () => this.sockets.delete(socket))
    })
  }

  static async start(initialPackages?: MockPackageSpec[]): Promise<MockRegistry> {
    const reg = new MockRegistry()
    if (initialPackages) {
      for (const pkg of initialPackages) {
        reg.registerPackage(pkg)
      }
    }
    await new Promise<void>((resolve, reject) => {
      reg.server.once("error", reject)
      reg.server.listen(0, "127.0.0.1", () => {
        reg.server.removeListener("error", reject)
        resolve()
      })
    })
    const addr = reg.server.address()
    if (addr && typeof addr === "object") {
      reg.port = addr.port
      reg.url = `http://127.0.0.1:${reg.port}`
    }
    return reg
  }

  registerPackage(spec: MockPackageSpec) {
    const name = spec.name
    const version = spec.version
    const pkgJsonData: Record<string, unknown> = {
      name,
      version,
      main: spec.main ?? "index.js",
    }
    if (spec.dependencies) {
      pkgJsonData.dependencies = spec.dependencies
    }
    if (spec.bin) {
      pkgJsonData.bin = spec.bin
    }

    const files = spec.files ?? {
      "package/package.json": JSON.stringify(pkgJsonData),
      "package/index.js": `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };`,
    }

    const { tgz, shasum, integrity } = createTgz(files)
    if (!this.packages.has(name)) {
      this.packages.set(name, new Map())
    }
    this.packages.get(name)!.set(version, {
      tgz,
      shasum,
      integrity,
      pkgJson: pkgJsonData,
    })
  }

  setBehavior(behavior: MockRegistryBehavior) {
    this.behavior = behavior
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawUrl = req.url || ""
    this.requests.push({
      method: req.method || "GET",
      url: rawUrl,
      headers: req.headers,
      timestamp: Date.now(),
    })

    const behavior = this.behavior

    if (behavior.mode === "socket-destroy") {
      req.socket.destroy()
      return
    }

    if (behavior.mode === "stall") {
      if (behavior.delayMs && behavior.delayMs > 0) {
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          this.serveNormal(rawUrl, req, res)
        }, behavior.delayMs)
        this.timers.add(timer)
        return
      }
      // Stall indefinitely (until socket/server closed)
      return
    }

    if (behavior.mode === "error") {
      const statusCode = behavior.statusCode ?? 500
      const body = behavior.body ?? JSON.stringify({ error: `Mock registry error (${statusCode})` })
      res.writeHead(statusCode, { "Content-Type": "application/json" })
      res.end(body)
      return
    }

    this.serveNormal(rawUrl, req, res)
  }

  private serveNormal(rawUrl: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const decoded = decodeURIComponent(rawUrl)
    const behavior = this.behavior

    // Check if this is a tarball request
    for (const [pkgName, versions] of this.packages) {
      for (const [ver, data] of versions) {
        const simpleName = pkgName.includes("/") ? pkgName.split("/")[1] : pkgName
        const tarballSuffix = `/${simpleName}-${ver}.tgz`
        if (decoded.includes(tarballSuffix) || rawUrl.includes(tarballSuffix)) {
          if (behavior.mode === "tarball-socket-destroy") {
            req.socket.destroy()
            return
          }
          if (behavior.mode === "tarball-error") {
            const statusCode = behavior.statusCode ?? 500
            const body = behavior.body ?? "Tarball download error"
            res.writeHead(statusCode, { "Content-Type": "text/plain" })
            res.end(body)
            return
          }
          if (behavior.mode === "tarball-stall") {
            if (behavior.delayMs && behavior.delayMs > 0) {
              const timer = setTimeout(() => {
                this.timers.delete(timer)
                res.writeHead(200, {
                  "Content-Type": "application/octet-stream",
                  "Content-Length": data.tgz.length,
                })
                res.end(data.tgz)
              }, behavior.delayMs)
              this.timers.add(timer)
              return
            }
            return
          }

          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": data.tgz.length,
          })
          res.end(data.tgz)
          return
        }
      }
    }

    // Check packument request
    const pathWithoutSlash = decoded.replace(/^\//, "").split("?")[0]
    if (this.packages.has(pathWithoutSlash)) {
      const versions = this.packages.get(pathWithoutSlash)!
      const versionsObj: Record<string, unknown> = {}
      let latestVersion = ""
      for (const [ver, data] of versions) {
        latestVersion = ver
        const simpleName = pathWithoutSlash.includes("/") ? pathWithoutSlash.split("/")[1] : pathWithoutSlash
        versionsObj[ver] = {
          name: pathWithoutSlash,
          version: ver,
          dist: {
            tarball: `${this.url}/${pathWithoutSlash}/-/${simpleName}-${ver}.tgz`,
            shasum: data.shasum,
            integrity: data.integrity,
          },
          ...data.pkgJson,
        }
      }

      const packument = {
        name: pathWithoutSlash,
        "dist-tags": { latest: latestVersion },
        versions: versionsObj,
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(packument))
      return
    }

    // Audit/security advisories endpoint - return 200 with empty bulk result
    if (rawUrl.includes("/security/advisories/bulk")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({}))
      return
    }

    // Not found
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: `Not found: ${rawUrl}` }))
  }

  async stop() {
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()

    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    }
    this.sockets.clear()

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  async [Symbol.asyncDispose]() {
    await this.stop()
  }
}
