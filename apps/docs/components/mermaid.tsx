'use client'

import { useEffect, useId, useState } from 'react'

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
        themeVariables: { background: '#000000', primaryColor: '#0a0a0a', primaryTextColor: '#ededed', primaryBorderColor: '#3a3a3a', lineColor: '#8a8a8a', secondaryColor: '#0a0a0a', tertiaryColor: '#0a0a0a', noteBkgColor: '#111111', noteTextColor: '#ededed', actorBkg: '#0a0a0a', actorBorder: '#3a3a3a', actorTextColor: '#ededed', signalColor: '#8a8a8a', signalTextColor: '#ededed', labelBoxBkgColor: '#0a0a0a', labelTextColor: '#ededed', loopTextColor: '#8a8a8a' },
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
