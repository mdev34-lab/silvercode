/** Own the spawned process even if collection or a child fixture fails. */
export async function collectDeadlineChild(argv: string[], cwd: string, timeoutMs: number, env?: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env: env ? { ...process.env, ...env } : process.env, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    return { stdout, stderr, code, timedOut, pid: child.pid }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}
