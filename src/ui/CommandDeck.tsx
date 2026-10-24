import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

type SystemStatus = {
  ok: boolean
  brain: string
  brainOnline: boolean
  speech: 'local Whisper' | 'unavailable'
  memoryMB: number
  memories: number
  uptimeSeconds: number
}

const QUICK_COMMANDS = [
  { label: 'Status report', text: 'Give me a concise system status report.' },
  { label: 'Today', text: 'Help me plan the rest of today.' },
  { label: 'Capabilities', text: 'What can you help me with right now on this Mac?' },
]

export function CommandDeck({ onCommand }: { onCommand: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (event.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    let cancelled = false
    const readStatus = async () => {
      try {
        const response = await fetch(`${BRIDGE_HTTP_URL}/system`, {
          signal: AbortSignal.timeout(1200),
        })
        if (response.ok && !cancelled) setStatus(await response.json() as SystemStatus)
      } catch {
        if (!cancelled) setStatus(null)
      }
    }
    void readStatus()
    const id = window.setInterval(() => void readStatus(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [open])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const command = text.trim()
    if (!command) return
    onCommand(command)
    setText('')
    setOpen(false)
  }

  const runQuick = (command: string) => {
    onCommand(command)
    setOpen(false)
  }

  return (
    <section className={`command-deck ${open ? 'is-open' : ''}`} aria-label="Command deck">
      {open ? (
        <div className="command-card">
          <div className="command-heading">
            <div>
              <strong>Command deck</strong>
              <span>Type anything. Voice is optional.</span>
            </div>
            <button className="command-close" type="button" onClick={() => setOpen(false)} aria-label="Close command deck">×</button>
          </div>

          <form className="command-form" onSubmit={submit}>
            <span aria-hidden="true">›</span>
            <input
              ref={input}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Ask JARVIS anything…"
              autoComplete="off"
            />
            <button type="submit">Send</button>
          </form>

          <div className="quick-commands">
            {QUICK_COMMANDS.map((command) => (
              <button key={command.label} type="button" onClick={() => runQuick(command.text)}>
                {command.label}
              </button>
            ))}
          </div>

          <div className="system-readout">
            <span><i className={status?.brainOnline ? 'live' : ''} />{status?.brainOnline ? status.brain : 'brain checking'}</span>
            <span>{status?.speech ?? 'speech checking'}</span>
            <span>{status ? `${status.memories} saved memories` : 'local-only link'}</span>
            <span>{status ? `${status.memoryMB} MB bridge memory` : ''}</span>
          </div>
          <p className="privacy-note">Say “remember that…” to save a preference locally. Voice and prompts stay on this Mac.</p>
        </div>
      ) : (
        <button className="command-launch" type="button" onClick={() => setOpen(true)}>
          <span className="command-plus">+</span>
          Command deck <kbd>/</kbd>
        </button>
      )}
    </section>
  )
}
