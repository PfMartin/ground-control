import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatController } from './controller'
import { DEFAULT_MAX_BYTES, isInsecureRemote, normalizeUrl } from './storage'
import { loadTheme, saveTheme, type Theme } from './theme'
import type { Backend, ExtensionDialog, Message } from './types'

function BackendForm({ backend, onSave, onCancel }: { backend?: Backend; onSave: (name: string, url: string, limit: number) => void; onCancel: () => void }) {
  const [name, setName] = useState(backend?.name ?? '')
  const [url, setUrl] = useState(backend?.url ?? '')
  const [limit, setLimit] = useState(String(backend?.maxMessageBytes ?? DEFAULT_MAX_BYTES))
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    try {
      if (!name.trim()) throw new Error('Enter a backend name.')
      const normalized = normalizeUrl(url)
      const bytes = Number(limit)
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Message limit must be a positive whole number of bytes.')
      if (backend && normalized !== backend.url && !window.confirm('Changing the URL will disconnect this backend and delete its local conversation. Continue?')) return
      if (backend && normalized === backend.url && bytes !== backend.maxMessageBytes && !window.confirm('Changing the limit disconnects any active session. Continue?')) return
      onSave(name, normalized, bytes)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save backend.') }
  }
  return <form className="backend-form" onSubmit={submit}>
    <h3>{backend ? 'Edit backend' : 'New backend'}</h3>
    {backend?.needsReview && <p className="form-error">Review this migrated URL before connecting. Any old query string was removed.</p>}
    <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="My agent" autoFocus maxLength={100} /></label>
    <label>Server base URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:8787/" spellCheck={false} /></label>
    <label>Message limit (bytes)<input type="number" min="1" step="1" value={limit} onChange={(event) => setLimit(event.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button primary" type="submit">Save</button><button className="button quiet" type="button" onClick={onCancel}>Cancel</button></div>
  </form>
}

function ConnectionForm({ backend, controller, onClose }: { backend: Backend; controller: ChatController; onClose: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const remembered = controller.hasToken(backend.id)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if ((!token && !remembered) || (token && /\s/.test(token))) { setError('Enter a nonempty bearer token without whitespace.'); return }
    let confirmed = false
    if (isInsecureRemote(backend.url)) {
      confirmed = window.confirm('This HTTP connection will send your bearer token without encryption. Continue only on a trusted network.')
      if (!confirmed) return
    }
    void controller.connect(token || undefined, confirmed)
    setToken(''); onClose()
  }
  return <form className="connection-form" aria-label="Backend connection" onSubmit={submit}>
    <div><strong>Connect to {backend.name}</strong><p>The token stays in memory until reload. It grants trusted users access to the shared workspace and tools.</p></div>
    <label>Bearer token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={remembered ? 'Leave blank to reuse remembered token' : 'Enter token'} autoFocus /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button primary" type="submit">Connect</button><button className="button quiet" type="button" onClick={onClose}>Cancel</button></div>
  </form>
}

function Dialog({ dialog, controller }: { dialog: ExtensionDialog; controller: ChatController }) {
  const [value, setValue] = useState(dialog.prefill ?? '')
  const [error, setError] = useState<string | null>(null)
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => () => { if (previousFocus.current?.isConnected) previousFocus.current.focus() }, [])
  const reply = (answer: { value: string } | { confirmed: boolean } | { cancelled: true }) => {
    if (!controller.replyDialog(dialog.id, answer)) setError(controller.getSnapshot().notice ?? 'Could not send this response.')
  }
  const cancel = () => reply({ cancelled: true })
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return }
    if (event.key !== 'Tab') return
    const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')
    if (!elements?.length) return
    const first = elements[0]; const last = elements[elements.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div className="dialog-overlay"><div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={keyboard}>
    <span className="eyebrow">EXTENSION REQUEST</span><h2 id="dialog-title">{dialog.title}</h2>
    {dialog.message && <p>{dialog.message}</p>}
    {dialog.deadline && <p className="dialog-timeout">This request expires automatically.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {dialog.method === 'select' && <div className="dialog-options">{dialog.options?.map((option, index) => <button key={`${index}-${option}`} className="button" onClick={() => reply({ value: option })}>{option}</button>)}</div>}
    {dialog.method === 'confirm' && <div className="dialog-options"><button className="button primary" onClick={() => reply({ confirmed: true })}>Yes</button><button className="button" onClick={() => reply({ confirmed: false })}>No</button></div>}
    {(dialog.method === 'input' || dialog.method === 'editor') && <form onSubmit={(event) => { event.preventDefault(); reply({ value }) }}>
      <label className="sr-only" htmlFor="dialog-value">Response</label>
      {dialog.method === 'input' ? <input id="dialog-value" autoFocus placeholder={dialog.placeholder} value={value} onChange={(event) => setValue(event.target.value)} /> : <textarea id="dialog-value" autoFocus rows={7} placeholder={dialog.placeholder} value={value} onChange={(event) => setValue(event.target.value)} />}
      <div className="dialog-options"><button className="button primary" type="submit">Submit</button></div>
    </form>}
    <button className="button quiet dialog-cancel" autoFocus={dialog.method === 'select' || dialog.method === 'confirm'} onClick={cancel}>Cancel</button>
  </div></div>
}

function MessageView({ message }: { message: Message }) {
  const name = message.role === 'user' ? 'You' : message.role === 'backend' ? 'Backend input' : message.role === 'system' ? 'Session' : 'Agent'
  return <article className={`message ${message.role}`}>
    <div className="avatar" aria-hidden="true">{message.role === 'user' ? 'Y' : message.role === 'backend' ? '↳' : message.role === 'system' ? '!' : '✳'}</div>
    <div className="message-body">
      <div className="message-meta"><strong>{name}</strong>
        {message.status === 'interrupted' && <span className="message-flag">Interrupted</span>}
        {message.status === 'unknown' && <span className="message-flag">Outcome unknown</span>}
        {message.status === 'cancelled' && <span className="message-flag">Cancelled</span>}
        {message.status === 'failed' && <span className="message-flag error">Failed</span>}
        {message.status === 'pending' && <span className="message-flag streaming">{message.role === 'assistant' ? 'Responding' : 'Sending'}</span>}
      </div>
      {message.content ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.content}</ReactMarkdown></div> : message.status === 'pending' && message.role === 'assistant' ? <div className="typing" aria-label="Waiting for response"><span /><span /><span /></div> : null}
      {message.error && <p className="message-error">{message.error}</p>}
    </div>
  </article>
}

function Composer({ controller, disabled, generating, canStop }: { controller: ChatController; disabled: boolean; generating: boolean; canStop: boolean }) {
  const [draft, setDraft] = useState('')
  const submit = () => { if (!disabled && controller.send(draft)) setDraft('') }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); if (!disabled && draft.trim()) submit()
    }
  }
  return <div className="composer-wrap"><form className="composer" onSubmit={(event) => { event.preventDefault(); submit() }}>
    <label className="sr-only" htmlFor="message-input">Message (Markdown supported)</label>
    <textarea id="message-input" rows={2} placeholder={generating ? 'Waiting for the agent…' : 'Send a message…'} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
    <div className="composer-footer"><span>Markdown supported</span><div className="composer-actions">{canStop && <button className="button quiet stop-button" type="button" onClick={() => controller.stop()}>Stop</button>}<button className="send-button" type="submit" disabled={disabled || !draft.trim()} aria-label="Send message">↑</button></div></div>
  </form><p className="composer-hint">Enter to send <span>·</span> Shift + Enter for a new line</p></div>
}

export function App({ controller }: { controller: ChatController }) {
  const { data, status, notice, storageWarning, currentSessionId, canSend, canReset, canStop, busy, runLabel, dialogs, tools } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [form, setForm] = useState<'new' | string | null>(null)
  const [connectingForm, setConnectingForm] = useState(false)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [themeWarning, setThemeWarning] = useState<string | null>(null)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f8f6f0' : '#0f0f10')
  }, [theme])
  const toggleTheme = () => {
    const next = theme === 'light' ? 'ssp' : 'light'
    setTheme(next)
    setThemeWarning(saveTheme(next) ? null : 'Theme preference could not be saved and may reset on reload.')
  }
  const selected = data.backends.find((backend) => backend.id === data.selectedBackendId)
  const editing = form && form !== 'new' ? data.backends.find((backend) => backend.id === form) : undefined
  const messages = selected ? data.conversations[selected.id] ?? [] : []
  const groups: { id: string; messages: Message[] }[] = []
  for (const message of messages) {
    if (groups.at(-1)?.id !== message.sessionId) groups.push({ id: message.sessionId, messages: [] })
    groups.at(-1)!.messages.push(message)
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  useEffect(() => { nearBottom.current = true; setConnectingForm(false) }, [selected?.id])
  useEffect(() => { const node = scrollRef.current; if (node && nearBottom.current && messages.length > 0) node.scrollTop = node.scrollHeight }, [messages, selected?.id])
  const select = (id: string) => { setForm(null); setConnectingForm(false); controller.selectBackend(id) }
  const remove = (backend: Backend) => { if (window.confirm(`Remove “${backend.name}” and delete its local conversation?`)) { controller.removeBackend(backend.id); setForm(null); setConnectingForm(false) } }
  const reset = () => {
    if (!selected) return
    if (status === 'connected') { if (window.confirm('Start a new Pi session and clear this local transcript?')) controller.newSession() }
    else if (status !== 'connecting' && window.confirm('Delete this historical local transcript?')) controller.clearHistory(selected.id)
  }
  return <div className="app-shell">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon" aria-hidden="true">&gt;_</div><div><strong>Ground Control</strong><span>AGENT WORKSPACE / 01</span></div></div>
      <div className="sidebar-heading"><span>BACKENDS</span><button className="icon-button" aria-label="Add backend" title="Add backend" onClick={() => { setConnectingForm(false); setForm('new') }}>+</button></div>
      <nav className="backend-list" aria-label="Backends">
        {data.backends.map((backend) => <button key={backend.id} className={`backend-item ${selected?.id === backend.id ? 'selected' : ''}`} onClick={() => select(backend.id)} aria-current={selected?.id === backend.id ? 'true' : undefined}>
          <span className={`backend-dot ${selected?.id === backend.id && status === 'connected' ? 'online' : ''}`} /><span className="backend-label"><strong>{backend.name}</strong><small>{backend.needsReview ? 'Review endpoint' : backend.url}</small></span><span className="backend-arrow" aria-hidden="true">›</span>
        </button>)}
        {!data.backends.length && <p className="sidebar-empty">Add a backend to get started.</p>}
      </nav>
      {form && <BackendForm key={form} backend={editing} onCancel={() => setForm(null)} onSave={(name, url, limit) => { if (editing) controller.updateBackend(editing.id, name, url, limit); else controller.addBackend(name, url, limit); setForm(null) }} />}
      <div className="sidebar-bottom"><span className="sidebar-foot-icon">◇</span><span>One connection at a time<br /><small>Conversations stored locally</small></span></div>
    </aside>
    <main className="main-panel" id="workspace" tabIndex={-1}>
      <header className="topbar"><div className="topbar-title"><span className="eyebrow">CONVERSATION</span><h1>{selected?.name ?? 'Select a backend'}</h1></div><div className="topbar-actions">
        <div className="theme-toggle"><span className={theme === 'light' ? 'active' : ''} aria-hidden="true">Light</span><button type="button" className="theme-switch" role="switch" aria-label="SSP dark theme" aria-checked={theme === 'ssp'} onClick={toggleTheme}><span /></button><span className={theme === 'ssp' ? 'active' : ''} aria-hidden="true">SSP</span></div>
        {selected && <><span className={`status ${status}`} role="status"><span className="status-dot" />{status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : status === 'error' ? 'Connection error' : 'Disconnected'}</span>
          {status === 'connected' || status === 'connecting' ? <button className="button quiet" onClick={() => controller.disconnect()}>Disconnect</button> : <button className="button connect" onClick={() => { setForm(null); if (selected.needsReview) setForm(selected.id); else setConnectingForm(true) }}>Connect <span aria-hidden="true">↗</span></button>}
          <button className="icon-button top-icon" title="Edit backend" aria-label="Edit backend" onClick={() => { setConnectingForm(false); setForm(selected.id) }}>⚙</button>
          <button className="icon-button top-icon" title="Remove backend" aria-label="Remove backend" onClick={() => remove(selected)}>×</button></>}
      </div></header>
      {connectingForm && selected && <ConnectionForm key={`connection-${selected.id}`} backend={selected} controller={controller} onClose={() => setConnectingForm(false)} />}
      {(notice || storageWarning || themeWarning) && <div className="notices">{storageWarning && <p role="alert">{storageWarning}</p>}{themeWarning && <p role="status">{themeWarning}</p>}{notice && <p role="status">{notice}</p>}</div>}
      <div className="conversation" ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120 }}>
        <div className="conversation-inner">
          {selected && <div className="conversation-heading"><span>MESSAGE HISTORY</span>{status === 'connected' ? <button className="text-button" onClick={reset} disabled={!canReset}>New session</button> : status !== 'connecting' && messages.length > 0 ? <button className="text-button" onClick={reset}>Clear history</button> : null}</div>}
          {messages.length > 0 ? <div className="messages">{groups.map((group, index) => <section key={`${group.id}-${index}`} className="session-group"><div className="session-label">{group.id === currentSessionId && status === 'connected' ? 'CURRENT SESSION' : 'HISTORICAL SESSION · NOT IN AGENT CONTEXT'}</div><div className="messages">{group.messages.map((message) => <MessageView key={message.id} message={message} />)}</div></section>)}</div> : <div className="empty-state"><div className="empty-icon" aria-hidden="true">&gt;_</div><span className="empty-eyebrow">01 — WORKSPACE</span><h2>{selected ? 'Start a conversation' : 'Your workspace awaits'}</h2><p>{selected ? status === 'connected' ? 'Your fresh agent session is ready.' : 'Connect to your backend, then send a message to get started.' : 'Add or select a backend to start chatting.'}</p><div className="empty-tags"><span>Streaming responses</span><span>Markdown ready</span></div></div>}
          {(runLabel || tools.length > 0) && <div className="activity" role="status">{runLabel && <div>{runLabel}</div>}{tools.map((tool) => <div key={tool.id}>{tool.name} · {tool.state === 'running' ? 'running' : tool.state === 'failed' ? 'failed' : 'complete'}</div>)}</div>}
        </div>
      </div>
      <Composer key={`composer-${selected?.id ?? 'none'}`} controller={controller} disabled={!canSend} generating={busy} canStop={canStop} />
    </main>
    {dialogs[0] && <Dialog key={dialogs[0].id} dialog={dialogs[0]} controller={controller} />}
  </div>
}
