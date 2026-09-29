// chalk decides its colour level when it is first evaluated, and turns colour off
// when stdout isn't a TTY (CI, piped, agents) — frames would then carry no styling to
// assert on. Import this before anything that loads ink.
const wasSet = process.env.FORCE_COLOR !== undefined
process.env.FORCE_COLOR ??= '3'

/** Call once ink has loaded, so the test reporter's output isn't forced into colour too. */
export function restoreColorEnv(): void {
  if (!wasSet) delete process.env.FORCE_COLOR
}
