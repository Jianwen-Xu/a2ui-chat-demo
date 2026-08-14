import { useEffect, useRef, useState } from 'react'
import { MessageProcessor, type A2uiMessage } from '@a2ui/web_core/v0_9'
import { A2uiSurface, basicCatalog } from '@a2ui/react/v0_9'
import { A2UI_SYSTEM_PROMPT } from './a2uiPrompt'
import './App.css'

interface ChatMessage {
  role: 'user' | 'system'
  text: string
}

function App() {
  // 1. Create the processor (with an action handler for user clicks).
  const [processor] = useState(() => {
    return new MessageProcessor([basicCatalog], (action) => {
      console.log('User action:', action)
    })
  })

  // 2. Keep the surface list in sync with the processor.
  const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()))
  useEffect(() => {
    const sync = () => setSurfaces(Array.from(processor.model.surfacesMap.values()))
    const createdSub = processor.onSurfaceCreated(sync)
    const deletedSub = processor.onSurfaceDeleted(sync)
    return () => {
      createdSub.unsubscribe()
      deletedSub.unsubscribe()
    }
  }, [processor])

  // 3. Chat state.
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track surfaces already created so repeated createSurface messages
  // (common in multi-turn / streaming agent responses) don't throw
  // "Surface already exists" in the processor.
  const seenSurfaceIds = useRef(new Set<string>())

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setError(null)
    setHistory((h) => [...h, { role: 'user', text }])
    setLoading(true)

    try {
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, systemPrompt: A2UI_SYSTEM_PROMPT }),
      })

      const data = (await res.json()) as { messages?: A2uiMessage[]; error?: string }
      if (!res.ok || !data.messages) {
        throw new Error(data.error || `Request failed (${res.status})`)
      }

      // Drop createSurface messages for surfaces that already exist.
      const messages = data.messages.filter((m) => {
        const cs = (m as { createSurface?: { surfaceId?: string } }).createSurface
        if (!cs?.surfaceId) return true
        if (seenSurfaceIds.current.has(cs.surfaceId)) return false
        seenSurfaceIds.current.add(cs.surfaceId)
        return true
      })

      // Feed the agent-generated messages to the processor.
      processor.processMessages(messages)
      setHistory((h) => [
        ...h,
        { role: 'system', text: '✨ Agent generated a new UI' },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // 4. Render: chat input + A2UI surfaces.
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>A2UI + Gemini</h1>
        <p className="subtitle">Agent-generated UI, rendered live via A2UI protocol</p>
      </header>

      <div className="chat-panel">
        <div className="chat-history">
          {history.length === 0 && (
            <div className="chat-empty">Type a request below — e.g. &quot;Show a card with my name and a button&quot;</div>
          )}
          {history.map((m, i) => (
            <div key={i} className={`chat-bubble ${m.role}`}>
              {m.text}
            </div>
          ))}
          {loading && <div className="chat-bubble system typing">Generating UI…</div>}
          {error && <div className="chat-error">Error: {error}</div>}
        </div>

        <div className="surface-area">
          {surfaces.length === 0 && !loading && (
            <div className="surface-empty">Waiting for the agent to create a surface…</div>
          )}
          {surfaces.map((surface) => (
            <A2uiSurface key={surface.id} surface={surface} />
          ))}
        </div>
      </div>

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault()
          sendMessage()
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe the UI you want…"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          {loading ? 'Generating…' : 'Send'}
        </button>
      </form>
    </div>
  )
}

export default App
