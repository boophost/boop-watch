// Client side of the profile-page avatar upload (server/index.ts POST/DELETE
// /api/profile/avatar). The server only owns file storage; the caller is
// responsible for pointing user_metadata.custom_avatar_url at the returned URL
// (via supabase.auth.updateUser) — that's the user's own field to write.
import { fetchAuth, parseAuthJson } from './api'

const MAX_AVATAR_BYTES = 5 * 1024 * 1024

export async function uploadAvatar(file: File): Promise<string> {
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error('Image must be 5MB or smaller')
  }
  const r = await fetchAuth('/api/profile/avatar', {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  const body = await parseAuthJson<{ avatarUrl: string }>(r)
  return body.avatarUrl
}

export async function deleteAvatarFile(): Promise<void> {
  const r = await fetchAuth('/api/profile/avatar', { method: 'DELETE' })
  if (!r.ok) throw new Error('Failed to remove profile picture')
}
