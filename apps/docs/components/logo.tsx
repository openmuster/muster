/**
 * The muster mark: three figures standing in line, drawn as one stroke that reads as an "m". A muster
 * is a roll call, and a board is where people and agents fall in.
 */
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 19V10.5a4 4 0 0 1 8 0V19" />
      <path d="M12 10.5a4 4 0 0 1 8 0V19" />
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
