// What each tool call of the main loop adds to the context, as an estimate.
//
// The engine tells the size of the context a model request was answered
// over. A call made in one request is answered in the next, so the context's
// growth from one request to the next goes on the calls the first made:
//
//   request N makes calls → request N+1 starts (takes them) → it is answered
//   (its context, less request N's, is what they added)
//
// The growth also holds the model's own words and what a hook added. A call
// of a turn's last request, or of one cut, gets nothing, nor does one made
// before a compaction: a context that shrank puts nothing anywhere. A
// subagent's calls fill its own context, which the engine does not report.
// Kept in the module's own memory: a reload costs a request's figures.

// A call of the main loop, as its turn's row keeps it.
export type Called = { at: number; text: string }

// A request's growth shared evenly among its calls when it made this many
// at most: past them a large read and a short command would get the same
// figure, so they get none.
const SHARED_AT_MOST = 3

let waiting: Called[] = []
let lastContext: number | undefined

// The main loop made a call: the next request is sent with its result.
export const called = (call: Called) => {
  waiting.push(call)
}

// A request of the main loop starts: it answers the calls made since the
// last one.
export const requestStarted = () => {
  const answered = waiting
  waiting = []

  return answered
}

// That request was answered over `context` tokens (undefined when the engine
// did not say): what each call it answered added, for their rows, shared
// marked so. None where there is nothing to put anywhere.
export const requestAnswered = (answered: readonly Called[], context: number | undefined) => {
  const before = lastContext
  lastContext = context

  if (before === undefined || context === undefined || context <= before || answered.length === 0) return null
  if (answered.length > SHARED_AT_MOST) return null

  return { calls: answered, tokens: Math.round((context - before) / answered.length), isShared: answered.length > 1 }
}

// The turn ended: what its last request's calls added would show only with
// the next prompt, so they get none.
export const turnEnded = () => {
  waiting = []
}

// The context started again, after a compaction or a /clear: no call before
// it gets a figure, and the next request only sets where the next counts
// from.
export const contextRestarted = () => {
  waiting = []
  lastContext = undefined
}
