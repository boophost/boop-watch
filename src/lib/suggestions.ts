import { fetchAuth, parseAuthJson } from './api'

export interface SuggestionRow {
  id: number
  user_id: string
  email: string | null
  body: string
  resolved: number
  created_at: string
}

export async function listSuggestions(): Promise<SuggestionRow[]> {
  const r = await fetchAuth('/api/suggestions')
  const data = await parseAuthJson<{ suggestions: SuggestionRow[]; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.suggestions
}

export async function setSuggestionResolved(id: number, resolved: boolean): Promise<SuggestionRow> {
  const r = await fetchAuth(`/api/suggestions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  })
  const data = await parseAuthJson<{ suggestion: SuggestionRow; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.suggestion
}

export async function deleteSuggestion(id: number): Promise<void> {
  const r = await fetchAuth(`/api/suggestions/${id}`, { method: 'DELETE' })
  const data = await parseAuthJson<{ ok?: boolean; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
}
