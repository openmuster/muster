/**
 * The muster mark: a stack of sheets, the front one a checklist with two items done and one open. Drawn
 * on a 14px grid in the spirit of the early Mac icons, so it is only ever shown at whole multiples of
 * a pixel (14, 21 on a 2x screen, 28) where every square stays square.
 */
export const MARK_PATH =
  'M4 0h10v1h-10zM4 1h1v1h-1zM13 1h1v1h-1zM2 2h10v1h-10zM13 2h1v1h-1zM11 3h1v1h-1zM13 3h1v1h-1zM0 4h10v1h-10zM11 4h1v1h-1zM13 4h1v1h-1zM0 5h10v1h-10zM11 5h1v1h-1zM13 5h1v1h-1zM0 6h4v1h-4zM5 6h5v1h-5zM11 6h1v1h-1zM13 6h1v1h-1zM0 7h1v1h-1zM2 7h1v1h-1zM4 7h2v1h-2zM9 7h1v1h-1zM11 7h1v1h-1zM13 7h1v1h-1zM0 8h2v1h-2zM3 8h7v1h-7zM11 8h1v1h-1zM13 8h1v1h-1zM0 9h10v1h-10zM11 9h3v1h-3zM0 10h1v1h-1zM4 10h6v1h-6zM11 10h1v1h-1zM0 11h1v1h-1zM2 11h1v1h-1zM4 11h2v1h-2zM9 11h1v1h-1zM11 11h1v1h-1zM0 12h1v1h-1zM4 12h6v1h-6zM0 13h10v1h-10z'

export function Mark({ size = 21, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" shapeRendering="crispEdges" className={className} aria-hidden="true">
      <path fill="currentColor" d={MARK_PATH} />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className ?? ''}`}>
      <Mark />
      muster
    </span>
  )
}
