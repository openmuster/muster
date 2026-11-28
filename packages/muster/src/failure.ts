/** What a command exits with: 1 for a failure, 2 for misuse. */
export type ExitCode = 1 | 2

/**
 * An error as data: a `reason` to branch on, a headline that says what failed and why, and at most
 * two ways out. The CLI prints it; a program reads it with --json.
 */
export class Failure extends Error {
  readonly reason: string
  readonly hint: string | undefined
  readonly next: readonly string[]
  readonly exit: ExitCode
  readonly data: Record<string, unknown> | undefined

  constructor(
    reason: string,
    message: string,
    options: { hint?: string; next?: readonly string[]; exit?: ExitCode; data?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'Failure'
    this.reason = reason
    this.hint = options.hint
    this.next = (options.next ?? []).slice(0, 2)
    this.exit = options.exit ?? 1
    this.data = options.data
  }

  toJSON() {
    return {
      reason: this.reason,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.next.length ? { next: this.next } : {}),
      ...(this.data ? { data: this.data } : {}),
    }
  }
}

/** A request the caller got wrong: exit 2. */
export const misuse = (reason: string, message: string, hint?: string) => new Failure(reason, message, { exit: 2, ...(hint ? { hint } : {}) })

/** A cursor past a board's last event: see `mu wait --after`, `mu tail --after` and the live feed. */
export const cursorAhead = (after: number, head: number) =>
  new Failure('cursor_ahead', `The cursor ${after} is past this board's last event, ${head}.`, { hint: 'Was the board restored from a backup? Read on from its head, or from 0 to read it all again.', data: { head } })
