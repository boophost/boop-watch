// HTTP client for the admin suggestions API (server/index.ts), shared by the
// suggestions MCP server and its CLI. Auth + env loading are reused from
// flows-client.mjs (same JWT_SECRET-minted admin token, same mcp/flows.env),
// so both drivers talk to the same deployment the same way. Point BOOP_API at a
// port-forward of the staging pod (see mcp/README.md).

import { api } from './flows-client.mjs'

// A suggestion is { id, user_id, email, body, resolved, status, title, notes,
// duplicate_of, group_id, created_at, updated_at }. `body` is the user's verbatim
// words and is read-only; title/notes are admin-authored triage metadata.
export const suggestions = {
  // Returns { suggestions, groups } — the board's whole state in one call.
  list: () => api('GET', '/api/suggestions'),
  // Patch keys: status, title, notes, duplicate_of, group_id. Absent keys are
  // left unchanged; null clears a nullable field (title/notes/duplicate_of/group_id).
  update: (id, patch) => api('PATCH', `/api/suggestions/${Number(id)}`, patch),
  remove: (id) => api('DELETE', `/api/suggestions/${Number(id)}`),
}

// Epics: an admin-authored bundle (title + description) that related suggestions
// attach to via suggestions.group_id.
export const groups = {
  list: () => api('GET', '/api/suggestion-groups'),
  create: (title, description) => api('POST', '/api/suggestion-groups', { title, description: description ?? null }),
  update: (id, patch) => api('PATCH', `/api/suggestion-groups/${Number(id)}`, patch),
  remove: (id) => api('DELETE', `/api/suggestion-groups/${Number(id)}`),
}
