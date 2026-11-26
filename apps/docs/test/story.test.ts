import { describe, expect, it } from 'vitest'
import { ALL_CHAPTERS, CHAPTERS, CHAR_MS, REST_MS, SYNC_CHAPTERS, chapterMs, frameAt } from '../components/story/cues'

describe('the home page demo', () => {
  it('shows nothing before it starts and everything once a chapter has played', () => {
    for (const chapter of CHAPTERS) {
      const end = frameAt(chapter, chapterMs(chapter))
      expect(end.done).toBe(true)
      expect(end.lines.every((line) => !line.typing)).toBe(true)
      expect(end.board).not.toBeNull()
      expect(end.app).toBeNull()
      expect(frameAt(chapter, chapterMs(chapter) - REST_MS).done).toBe(true)
    }
    const first = frameAt(CHAPTERS[0]!, 0)
    expect([first.lines, first.board]).toEqual([[], null])
  })

  it('types a command a character at a time, and prints what the board answers only after it', () => {
    const chapter = CHAPTERS[0]!
    const half = frameAt(chapter, 300 + 10 * CHAR_MS)
    expect(half.lines).toEqual([{ kind: 'cmd', text: 'mu tasks c', typing: true }])
    const answered = frameAt(chapter, 1700)
    expect(answered.lines.map((line) => line.kind)).toEqual(['cmd', 'out'])
    expect(answered.board).toMatchObject({ state: 'ready', replies: [] })
  })

  it('the board in the demo moves the way a real one does: ready, claimed, then completed, with the replies kept', () => {
    const chapter = CHAPTERS[0]!
    const states = [1700, 4300, 7900].map((t) => frameAt(chapter, t).board!.state)
    expect(states).toEqual(['ready', 'claimed', 'completed'])
    expect(frameAt(chapter, chapterMs(chapter)).board!.replies.map((reply) => reply.by)).toEqual(['worker-1', 'worker-1'])
    const ask = frameAt(CHAPTERS[1]!, chapterMs(CHAPTERS[1]!)).board!
    expect([ask.state, ask.replies.map((reply) => reply.by)]).toEqual(['ready', ['claude', 'ada']])
  })

  it('every command in it is typed in full before the next begins, and before what it prints', () => {
    for (const chapter of ALL_CHAPTERS) {
      const typed = chapter.cues.filter((cue): cue is { at: number; type: string } => 'type' in cue)
      typed.forEach((cue, at) => {
        const next = typed[at + 1]
        if (next) expect(cue.at + cue.type.length * CHAR_MS).toBeLessThanOrEqual(next.at)
        const printed = chapter.cues.find((other) => 'out' in other && other.at > cue.at)
        if (printed) expect(cue.at + cue.type.length * CHAR_MS).toBeLessThanOrEqual(printed.at)
      })
    }
  })

  it('each synced tool plays a person acting there, the board making it a task, and the agent\'s replies arriving as comments', () => {
    expect(SYNC_CHAPTERS.map((chapter) => chapter.view)).toEqual(['linear', 'github', 'slack', 'notion'])
    for (const chapter of SYNC_CHAPTERS) {
      const end = frameAt(chapter, chapterMs(chapter))
      expect(end.app).not.toBeNull()
      expect(end.lines.filter((line) => line.kind === 'cmd').map((line) => line.text.split(' ').slice(0, 3).join(' '))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^mu wait /), expect.stringMatching(/^mu tasks create$/), expect.stringMatching(/^mu run /)]),
      )
      expect(end.app!.comments.some((comment) => comment.agent)).toBe(true)
    }
  })

  it('the Linear card moves only when a person moves it, through the columns a team uses', () => {
    const linear = SYNC_CHAPTERS[0]!
    const columns = [0, 300, 5300, 8100].map((t) => frameAt(linear, t).app!.column)
    expect(columns).toEqual(['Backlog', 'Todo', 'In Progress', 'Done'])
    expect(frameAt(linear, 300).app!.tags).toEqual(['agent'])
    const github = SYNC_CHAPTERS[1]!
    expect([0, 6000, 7400].map((t) => frameAt(github, t).app!.checks)).toEqual(['failing', 'pending', 'passing'])
  })
})
