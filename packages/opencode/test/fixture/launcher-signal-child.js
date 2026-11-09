// Keep the POSIX child alive until SIGINT is observed and the parent releases it.
process.on("SIGINT", () => process.stdout.write("child:sigint\n"))
process.stdin.setEncoding("utf8")
process.stdin.on("data", (data) => {
  if (data.includes("release")) {
    process.stdout.write("child:done\n")
    process.exit(7)
  }
})
process.stdin.on("end", () => process.exit(7))
process.stdout.write("child:ready\n")
