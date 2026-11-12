// Cloudflare's cache rules for the dashboard's files (dist/_headers), written by the build (vite.config.ts).
//
// Workers Assets answers a path that matches no file with the dashboard shell, under whichever _headers rule the path
// matches. A rule for all of /assets/* would keep that shell for a year under the name of a file that a later build,
// or a rollback, ships. So a lifetime goes to the files this build has, one rule per name; every other path keeps the
// default (max-age=0, must-revalidate). No dependencies, so the API acceptance suite can test it.

/** Lifetime by directory: a hashed build file never changes under its name; a font keeps its name across builds. */
export const FILE_CACHE: Record<string, string> = {
  assets: 'public, max-age=31536000, immutable',
  fonts: 'public, max-age=86400, stale-while-revalidate=604800',
}
/** Workers Assets reads this many rules and skips the rest of the file. */
export const MAX_RULES = 100

// A rule is its path, then indented headers. `*` and `:name` in a path are patterns, so a file whose name holds
// anything but these characters gets no rule (and revalidates) rather than one that could match other paths.
const PLAIN_FILE = /^([a-z]+)\/[A-Za-z0-9._~-]+$/
const isRule = (line: string) => line.startsWith('/')

/**
 * `source` (app/public/_headers) followed by one rule for each file of `files` in a directory that has a lifetime, in
 * the order given. `uncached` lists the files left without one: names that are not plain, and those past the rule limit.
 */
export function withFileRules(source: string, files: string[]): { headers: string; uncached: string[] } {
  const room = Math.max(0, MAX_RULES - source.split('\n').filter(isRule).length)
  const known = [...new Set(files)].filter(file => Object.hasOwn(FILE_CACHE, file.slice(0, Math.max(0, file.indexOf('/')))))
  const ruled = known.filter(file => PLAIN_FILE.test(file)).slice(0, room)
  const rules = ruled.map(file => `/${file}\n  Cache-Control: ${FILE_CACHE[PLAIN_FILE.exec(file)![1]!]}`)
  return { headers: [source.trimEnd(), ...rules].join('\n') + '\n', uncached: known.filter(file => !ruled.includes(file)) }
}
