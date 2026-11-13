// The public API definition the docs render (GET /openapi.json, cached five minutes by the server). Shared with the
// sidebar's hover warm-up, so opening Docs from the dashboard usually finds it loaded.
export const openApiQuery = {
  queryKey: ['public-openapi'],
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<unknown> => {
    const response = await fetch('/openapi.json', { signal })
    if (!response.ok) throw new Error('Couldn’t load the API definition.')
    return response.json()
  },
  staleTime: 5 * 60_000,
}
