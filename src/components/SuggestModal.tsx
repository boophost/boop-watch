import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { submitSuggestion } from '@/lib/api'
import { useAuth } from '@/lib/AuthContext'

const MAX = 2000

interface SuggestContextType {
  open: () => void
}

const SuggestContext = createContext<SuggestContextType>({ open: () => {} })

/** Open the suggestion modal from anywhere in the portal. Triggers should only
 * be rendered for logged-in users — the modal itself also no-ops when signed out. */
export const useSuggest = () => useContext(SuggestContext)

export function SuggestProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const open = useCallback(() => {
    // Signed-out users have no way to submit; ignore stray opens.
    if (!user) return
    setText('')
    setError('')
    setDone(false)
    setIsOpen(true)
  }, [user])

  const close = useCallback(() => setIsOpen(false), [])

  // Focus the textarea on open; close on Escape.
  useEffect(() => {
    if (!isOpen) return
    const t = setTimeout(() => textareaRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, close])

  // A signed-out user (e.g. after logout while open) can't submit.
  useEffect(() => {
    if (!user) setIsOpen(false)
  }, [user])

  const submit = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setError('')
    try {
      await submitSuggestion(body)
      setDone(true)
      setTimeout(() => setIsOpen(false), 1200)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit suggestion')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SuggestContext.Provider value={{ open }}>
      {children}
      {isOpen && (
        <div
          className="kagura suggest-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Send a suggestion"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close()
          }}
        >
          <div className="suggest-modal">
            <div className="suggest-head">
              <div className="suggest-title">
                <Icon name="alert" size={16} />
                <span>Send a suggestion</span>
              </div>
              <button className="suggest-close" type="button" onClick={close} aria-label="Close">
                <Icon name="back" size={16} />
              </button>
            </div>
            {done ? (
              <div className="suggest-done">
                <Icon name="alert" size={22} />
                <p>Thanks! Your suggestion was sent.</p>
              </div>
            ) : (
              <>
                <p className="suggest-sub">
                  Missing a title, spotted a bug, or have an idea? Let us know.
                </p>
                <textarea
                  ref={textareaRef}
                  className="suggest-textarea"
                  placeholder="Type your suggestion…"
                  maxLength={MAX}
                  value={text}
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
                  }}
                />
                {error && <p className="suggest-error">{error}</p>}
                <div className="suggest-foot">
                  <span className="suggest-count">
                    {text.length}/{MAX}
                  </span>
                  <div className="suggest-actions">
                    <button className="btn btn-secondary" type="button" onClick={close} disabled={busy}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={submit}
                      disabled={busy || !text.trim()}
                    >
                      {busy ? 'Sending…' : 'Send suggestion'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </SuggestContext.Provider>
  )
}
