// What the pane drew last, read by work that redraws it.

// Whether the pane was last drawn with room for the subagents' rows, and
// with the summary on and the recent turns to pick one from (on the
// desktop, and from WIDE_FROM columns in the terminal); the module's own,
// set as it draws.
export let isRoomyDrawn = false
export const setIsRoomyDrawn = (value: typeof isRoomyDrawn) => {
  isRoomyDrawn = value
}
export let isPickingDrawn = false
export const setIsPickingDrawn = (value: typeof isPickingDrawn) => {
  isPickingDrawn = value
}
