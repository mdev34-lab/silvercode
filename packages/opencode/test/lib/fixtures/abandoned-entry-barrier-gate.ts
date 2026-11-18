let resolveGate: ((value: string) => void) | undefined

export const gate = new Promise<string>((resolve) => {
  resolveGate = resolve
})

export const releaseGate = () => resolveGate?.("release\n")
