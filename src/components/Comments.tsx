// Per-episode comments section on the player page. Reading is public (the
// portal has no login wall); posting needs a Supabase session, so anonymous
// viewers get a sign-in prompt in place of the composer. Comments render
// newest-first; the author (and admins) can delete.
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { useAuth } from '@/lib/AuthContext'
import { getComments, postComment, deleteComment, type Comment } from '@/lib/api'
import { track } from '@/lib/analytics'

const COMMENT_MAX = 1000

// SQLite's datetime('now') is UTC but carries no zone marker — mark it as UTC
// before parsing or every timestamp shifts by the viewer's offset.
function parseUtc(s: string): number {
  const t = Date.parse(/[zZ+]|T.*-/.test(s) ? s : s.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : 0
}

function relTime(s: string): string {
  const diff = Date.now() - parseUtc(s)
  if (diff < 60_000) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  const [broken, setBroken] = useState(false)
  if (url && !broken) {
    return <img className="cmt-avatar" src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  }
  return <span className="cmt-avatar cmt-avatar-fallback">{(name[0] || '?').toUpperCase()}</span>
}

export function Comments({ itemId }: { itemId: string }) {
  const { user } = useAuth()
  const location = useLocation()
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    setComments(null)
    setError('')
    getComments(itemId)
      .then((d) => { if (alive) setComments(d.comments) })
      .catch(() => { if (alive) setComments([]) })
    return () => { alive = false }
  }, [itemId])

  const submit = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError('')
    try {
      const c = await postComment(itemId, body)
      setComments((cs) => [c, ...(cs ?? [])])
      setDraft('')
      track('comment_posted', { item_id: itemId, auth_state: 'authenticated' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post comment')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: number) => {
    const prev = comments
    setComments((cs) => (cs ?? []).filter((c) => c.id !== id))
    try {
      await deleteComment(id)
    } catch {
      setComments(prev) // restore on failure
    }
  }

  const count = comments?.length ?? 0

  return (
    <section className="comments panel">
      <div className="cmt-head">
        <Icon name="comment" size={15} />
        <span>Comments</span>
        {comments !== null && <span className="badge">{count}</span>}
      </div>

      {user ? (
        <div className="cmt-composer">
          <Avatar name={user.username} url={user.avatarUrl} />
          <div className="cmt-input-col">
            <textarea
              ref={inputRef}
              className="cmt-input"
              placeholder="Add a comment…"
              rows={2}
              maxLength={COMMENT_MAX}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
              }}
            />
            <div className="cmt-actions">
              {error && <span className="cmt-error">{error}</span>}
              <span className="cmt-count">{draft.length > COMMENT_MAX - 100 ? `${draft.length}/${COMMENT_MAX}` : ''}</span>
              <button type="button" className="btn btn-primary cmt-post" disabled={!draft.trim() || busy} onClick={submit}>
                {busy ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="cmt-signin">
          <Link to="/login" state={{ from: location.pathname }}>Sign in</Link> to join the discussion.
        </div>
      )}

      <div className="cmt-list">
        {comments === null && <div className="cmt-empty">Loading comments…</div>}
        {comments !== null && count === 0 && (
          <div className="cmt-empty">No comments yet — be the first to share your thoughts on this episode.</div>
        )}
        {(comments ?? []).map((c) => (
          <div key={c.id} className="cmt">
            <Avatar name={c.name} url={c.avatarUrl} />
            <div className="cmt-main">
              <div className="cmt-meta">
                <span className="cmt-name">{c.name}</span>
                <span className="cmt-time" title={c.createdAt}>{relTime(c.createdAt)}</span>
                {user && (user.id === c.userId || user.isAdmin) && (
                  <button type="button" className="cmt-del" title="Delete comment" onClick={() => remove(c.id)}>
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
              <p className="cmt-body">{c.body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
