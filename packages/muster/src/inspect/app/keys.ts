import { useEffect, useRef } from 'react'

/** A key the page answers to: what is pressed, what `?` calls it, and what it does. */
export type Binding = {
  /** `KeyboardEvent.key` values. A letter is its lower case: Shift with it is another key. */
  keys: string[]
  /** How `?` shows the keys, such as `j ↓`. */
  shown: string
  /** What it does, as `?` says it. */
  does: string
  /** Does it, and says whether it did: a key that did nothing is left to the browser. None: listed only. */
  run?: () => boolean
}

/** Somewhere to type: a key pressed there is text, never a shortcut. */
export const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))

/**
 * The page's one keyboard listener. Each key in `bindings` runs while nothing is being typed and no
 * modifier is held; the first binding for a key that does something wins, in the order given.
 */
export function useKeys(bindings: Binding[]) {
  const now = useRef(bindings)
  now.current = bindings
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
      for (const binding of now.current) {
        if (binding.run && binding.keys.includes(event.key) && binding.run()) {
          event.preventDefault()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
