'use client'

import { useEffect, useId, useState } from 'react'
import { DARK } from '../lib/tokens'

/** A diagram written as text in the markdown. Drawn in the browser, in the site's own colours. */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replaceAll(':', '')
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        theme: 'base',
        themeVariables: { background: DARK.bg, primaryColor: DARK.panel, primaryTextColor: DARK.fg, primaryBorderColor: DARK['thumb-hover'], lineColor: DARK.dim, secondaryColor: DARK.panel, tertiaryColor: DARK.panel, noteBkgColor: '#111111', noteTextColor: DARK.fg, actorBkg: DARK.panel, actorBorder: DARK['thumb-hover'], actorTextColor: DARK.fg, signalColor: DARK.dim, signalTextColor: DARK.fg, labelBoxBkgColor: DARK.panel, labelTextColor: DARK.fg, loopTextColor: DARK.dim },
      })
      try {
        const drawn = await mermaid.render(`m${id}`, chart)
        if (live) setSvg(drawn.svg)
      } catch {
        if (live) setSvg(null)
      }
    })
    return () => {
      live = false
    }
  }, [chart, id])
  // Until it is drawn, and if it can't be, the text of the diagram is what a reader gets.
  if (svg === null) return <pre className="muster-diagram-source">{chart}</pre>
  return <div className="muster-diagram" role="img" aria-label="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}
