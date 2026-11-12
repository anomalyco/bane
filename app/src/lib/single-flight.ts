import { useMutation, type DefaultError, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query'
import { useRef } from 'react'

/** A write dropped because the same write is still in flight. It rejects once that write settles, and is never shown. */
export class DuplicateSubmission extends Error {
  constructor() { super('This is already being sent.'); this.name = 'DuplicateSubmission' }
}
export const isDuplicateSubmission = (error: unknown): error is DuplicateSubmission => error instanceof DuplicateSubmission

/**
 * useMutation that sends a write once per submission. A double click (or Enter, then a click) reaches the handler before
 * the button disables: React Query reports isPending a task later. A call is a duplicate when it is the same action on
 * the same target with the same input as one still in flight. The action and its target are the mutation function as
 * rendered: a target such as the open conversation is captured by that render's function, so after moving to another
 * conversation the next call is a new action even with the same input (Star on B while Star on A is pending). A
 * duplicate isn't sent; its promise rejects with DuplicateSubmission once the first call settles, so the code after it
 * (close the dialog, open what was created) runs once. Once the first call settles, the same write can be sent again.
 */
export function useGuardedMutation<TData = unknown, TError = DefaultError, TVariables = void, TContext = unknown>(options: UseMutationOptions<TData, TError, TVariables, TContext>): UseMutationResult<TData, TError, TVariables, TContext> {
  const mutation = useMutation(options)
  const inflight = useRef(new WeakMap<object, Map<string, Promise<TData>>>())
  const action = options.mutationFn
  const mutateAsync = ((...args: Parameters<typeof mutation.mutateAsync>) => {
    const input = args[0]
    let key: string | undefined
    try { key = JSON.stringify(input ?? null) } catch { key = undefined }
    const calls = action && key !== undefined ? inflight.current.get(action) ?? new Map<string, Promise<TData>>() : undefined
    const running = calls && key !== undefined ? calls.get(key) : undefined
    if (running) return new Promise<TData>((_, reject) => { const drop = () => reject(new DuplicateSubmission()); running.then(drop, drop) })
    const call = mutation.mutateAsync(...args)
    if (action && calls && key !== undefined) {
      calls.set(key, call)
      inflight.current.set(action, calls)
      const release = () => { calls.delete(key) }
      call.then(release, release)
    }
    return call
  }) as typeof mutation.mutateAsync
  const mutate = ((...args: Parameters<typeof mutation.mutate>) => { mutateAsync(...args).catch(() => {}) }) as typeof mutation.mutate
  return { ...mutation, mutate, mutateAsync }
}

/**
 * An async handler that ignores calls while its previous call is still running: the same guard for a write sent with
 * request() rather than a mutation (Save in the ritual editor). The handler's own busy state disables its button a
 * render later; this covers the clicks before that render.
 */
export function useExclusive<A extends unknown[]>(run: (...args: A) => Promise<void>) {
  const running = useRef(false)
  return async (...args: A) => {
    if (running.current) return
    running.current = true
    try { await run(...args) } finally { running.current = false }
  }
}
