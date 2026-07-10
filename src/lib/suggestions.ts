import { fetchAuth, parseAuthJson } from './api'

export type SuggestionStatus = 'unread' | 'todo' | 'working' | 'staged' | 'done'

export interface SuggestionRow {
  id: number
  user_id: string
  email: string | null
  body: string
  resolved: number
  status: SuggestionStatus
  /** Admin-authored short title (the user's `body` stays verbatim). */
  title: string | null
  /** Admin-authored triage / resolution notes. */
  notes: string | null
  /** Canonical suggestion id this one duplicates, or null. */
  duplicate_of: number | null
  /** Epic (SuggestionGroup id) this belongs to, or null. */
  group_id: number | null
  created_at: string
  updated_at: string | null
}

export interface SuggestionGroup {
  id: number
  title: string
  description: string | null
  created_at: string
  updated_at: string
}

/** Fields an admin may edit. Omit a key to leave it unchanged; pass null to
 * clear a nullable field (title/notes/duplicate_of/group_id). */
export interface SuggestionPatch {
  status?: SuggestionStatus
  title?: string | null
  notes?: string | null
  duplicate_of?: number | null
  group_id?: number | null
}

export async function listSuggestions(): Promise<{ suggestions: SuggestionRow[]; groups: SuggestionGroup[] }> {
  const r = await fetchAuth('/api/suggestions')
  const data = await parseAuthJson<{ suggestions: SuggestionRow[]; groups: SuggestionGroup[]; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return { suggestions: data.suggestions, groups: data.groups ?? [] }
}

export async function updateSuggestion(id: number, patch: SuggestionPatch): Promise<SuggestionRow> {
  const r = await fetchAuth(`/api/suggestions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseAuthJson<{ suggestion: SuggestionRow; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.suggestion
}

/** Status-only move (kanban drag). Thin wrapper over updateSuggestion. */
export function setSuggestionStatus(id: number, status: SuggestionStatus): Promise<SuggestionRow> {
  return updateSuggestion(id, { status })
}

export async function deleteSuggestion(id: number): Promise<void> {
  const r = await fetchAuth(`/api/suggestions/${id}`, { method: 'DELETE' })
  const data = await parseAuthJson<{ ok?: boolean; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
}

// --- Epics (suggestion groups) ---------------------------------------------

export async function createSuggestionGroup(title: string, description: string | null): Promise<SuggestionGroup> {
  const r = await fetchAuth('/api/suggestion-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  })
  const data = await parseAuthJson<{ group: SuggestionGroup; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.group
}

export async function updateSuggestionGroup(
  id: number,
  patch: { title?: string; description?: string | null },
): Promise<SuggestionGroup> {
  const r = await fetchAuth(`/api/suggestion-groups/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseAuthJson<{ group: SuggestionGroup; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.group
}

export async function deleteSuggestionGroup(id: number): Promise<void> {
  const r = await fetchAuth(`/api/suggestion-groups/${id}`, { method: 'DELETE' })
  const data = await parseAuthJson<{ ok?: boolean; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
}
