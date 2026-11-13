// The dashboard's writes in flight (lib/single-flight.ts uses this), one registry per QueryClient, outside React: a
// re-render, a remount or another component making the same write all see the same entries. A key is the workspace the
// write is sent for, its operation, its target and its input, serialized. The workspace is the one selected when the
// write is made, which its request carries (X-Bane-Workspace): the same rename in two workspaces is two writes, and back
// in the first while its write still runs, a repeat there is still a duplicate. An entry leaves when its write settles,
// whether it succeeded or failed. No imports, so the API acceptance suite can test it.

const registries = new WeakMap<object, Map<string, Promise<unknown>>>()
const registryOf = (scope: object) => registries.get(scope) ?? registries.set(scope, new Map()).get(scope)!
/** The key of a write: undefined when a part can't be serialized, and then the write isn't guarded. */
export function flightKey(workspace: string | null, operation: string, target: unknown, input: unknown) {
  try { return JSON.stringify([workspace, operation, target ?? null, input ?? null]) } catch { return undefined }
}
/** Starts a write unless the same one (key) is in flight in this scope (the app's QueryClient): then it isn't started,
 *  and the running call comes back with duplicate set. A write without a key always starts. */
export function once<T>(scope: object, key: string | undefined, start: () => Promise<T>): { call: Promise<T>; duplicate: boolean } {
  if (key === undefined) return { call: start(), duplicate: false }
  const registry = registryOf(scope), running = registry.get(key) as Promise<T> | undefined
  if (running) return { call: running, duplicate: true }
  const call = start()
  registry.set(key, call)
  const release = () => { if (registry.get(key) === call) registry.delete(key) }
  call.then(release, release)
  return { call, duplicate: false }
}
