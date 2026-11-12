import { useMutation, useQueryClient, type DefaultError, type QueryClient, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query'

/** A write dropped because the same write is still in flight. It rejects once that write settles, and is never shown. */
export class DuplicateSubmission extends Error {
  constructor() { super('This is already being sent.'); this.name = 'DuplicateSubmission' }
}
export const isDuplicateSubmission = (error: unknown): error is DuplicateSubmission => error instanceof DuplicateSubmission

// The writes in flight, one registry per QueryClient (so per app, and fresh in each test), outside React: a re-render,
// a remount or another component making the same write all see the same entries. A key is the operation, its target
// and its input, serialized; an entry leaves when its write settles, whether it succeeded or failed.
const registries = new WeakMap<QueryClient, Map<string, Promise<unknown>>>()
const registryOf = (client: QueryClient) => registries.get(client) ?? registries.set(client, new Map()).get(client)!
/** The key of a write: undefined when a part can't be serialized, and then the write isn't guarded. */
export function flightKey(operation: string, target: unknown, input: unknown) {
  try { return JSON.stringify([operation, target ?? null, input ?? null]) } catch { return undefined }
}
function track<T>(client: QueryClient, key: string, call: Promise<T>) {
  const registry = registryOf(client)
  registry.set(key, call)
  const release = () => { if (registry.get(key) === call) registry.delete(key) }
  call.then(release, release)
  return call
}

/** What a guarded write is: the operation (by default its function's source, which is the same in every render and
 *  remount, and differs between call sites unless they make the same call) and the target its function closes over
 *  rather than takes as input, such as the open conversation. A write whose target is in its input needs no target. */
export type Flight = { target?: unknown; operation?: string }

/**
 * useMutation that sends a write once while it is in flight. A double click, Enter then a click, or a click after the
 * re-render that follows the first (an icon button that stays enabled) reaches the handler again before the write
 * answers. A call with the same operation, target and input as one in flight isn't sent: its promise rejects with
 * DuplicateSubmission once the first settles, so the code after it (close the dialog, open what was created) runs
 * once. The same operation on another target or with another input is sent (Star on conversation B while Star on A is
 * pending). Once the first call settles, the same write can be sent again.
 */
export function useGuardedMutation<TData = unknown, TError = DefaultError, TVariables = void, TContext = unknown>({ target, operation, ...options }: UseMutationOptions<TData, TError, TVariables, TContext> & Flight): UseMutationResult<TData, TError, TVariables, TContext> {
  const client = useQueryClient()
  const mutation = useMutation(options)
  const name = operation ?? options.mutationFn?.toString()
  const mutateAsync = ((...args: Parameters<typeof mutation.mutateAsync>) => {
    const key = name === undefined ? undefined : flightKey(name, target, args[0])
    const running = key === undefined ? undefined : registryOf(client).get(key)
    if (running) return new Promise<TData>((_, reject) => { const drop = () => reject(new DuplicateSubmission()); running.then(drop, drop) })
    const call = mutation.mutateAsync(...args)
    return key === undefined ? call : track(client, key, call)
  }) as typeof mutation.mutateAsync
  const mutate = ((...args: Parameters<typeof mutation.mutate>) => { mutateAsync(...args).catch(() => {}) }) as typeof mutation.mutate
  return { ...mutation, mutate, mutateAsync }
}

/**
 * The same guard for a write sent with request() or the API from a handler (the ritual editor's saves, New endpoint, an
 * inbox key, template Publish): a call with the same operation, target and arguments as one in flight isn't run again;
 * it gets that run's promise, so the write and what it shows happen once and the caller still gets the result. Other
 * arguments or another target still run.
 */
export function useSingleFlight<A extends unknown[], R>(operation: string, run: (...args: A) => Promise<R>, target?: unknown) {
  const client = useQueryClient()
  return (...args: A): Promise<R> => {
    const key = flightKey(operation, target, args)
    if (key === undefined) return run(...args)
    const running = registryOf(client).get(key) as Promise<R> | undefined
    return running ?? track(client, key, run(...args))
  }
}
