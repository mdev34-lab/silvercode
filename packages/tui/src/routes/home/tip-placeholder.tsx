import { createContext, createSignal, useContext, type Accessor, type ParentProps, type Setter } from "solid-js"

type Context = {
  tips: Accessor<string[] | undefined>
  setTips: Setter<string[] | undefined>
}

const HomeTipPlaceholderContext = createContext<Context>()

/**
 * Lets the home tips plugin publish plain-text tips for the prompt placeholder.
 * `undefined` means no tips are visible, so the prompt keeps its example placeholder.
 */
export function HomeTipPlaceholderProvider(props: ParentProps) {
  const [tips, setTips] = createSignal<string[]>()
  return (
    <HomeTipPlaceholderContext.Provider value={{ tips, setTips }}>{props.children}</HomeTipPlaceholderContext.Provider>
  )
}

export function useHomeTipPlaceholder() {
  return useContext(HomeTipPlaceholderContext)
}
