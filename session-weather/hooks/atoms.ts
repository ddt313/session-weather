// The pane's values in `$.state` are declared in ../types, and each file
// that reads or writes one writes its atom itself: the engine's scan of
// `$.state` reads an atom only in the file that uses it. Those atoms take
// their shape tags from here, so a tag changes in one place.

// A turn an earlier version kept in another shape is declined, not read.
// Bump the tag whenever the shape of `Thinking` changes.
export const THINKING_SHAPE = 'thinking-entries-2'
// Bump it whenever the shape of `RecentTurn`, or of the updates it keeps,
// changes.
export const RECENT_TURNS_SHAPE = 'recent-turns-1'
