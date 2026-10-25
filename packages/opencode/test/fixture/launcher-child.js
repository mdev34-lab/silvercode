// Stub child for the npm launcher tests. It stays alive long enough to receive
// a forwarded signal, records any SIGINT it sees, then exits with a sentinel
// code so the launcher's exit propagation is observable.
process.on("SIGINT", () => process.stdout.write("child:sigint\n"))
process.stdout.write("child:ready\n")
setTimeout(() => {
  process.stdout.write("child:done\n")
  process.exit(7)
}, 750)
