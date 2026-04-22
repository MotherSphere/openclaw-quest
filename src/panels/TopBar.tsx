import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { API_URL } from '../api'

type EveStatus = {
  available: boolean
  agents: Array<{ id: string; model: string }>
  tasks: { by_status: Record<string, number>; total: number; last_event_at: number | null }
}

export default function TopBar() {
  const connected = useStore((s) => s.connected)
  const [eve, setEve] = useState<EveStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const resp = await fetch(`${API_URL}/api/openclaw/status`)
        if (!resp.ok) return
        const data = await resp.json()
        if (!cancelled) setEve(data)
      } catch {
        /* leave as-is; next tick will retry */
      }
    }
    load()
    const id = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const failed = eve?.tasks?.by_status?.failed ?? 0
  const total = eve?.tasks?.total ?? 0
  const setActiveTab = useStore((s) => s.setActiveTab)

  return (
    <div className="pixel-panel" style={{ padding: '8px 16px', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
      {/* EVE status (left) */}
      {eve?.available && (
        <button
          onClick={() => setActiveTab('eve')}
          style={{
            position: 'absolute', left: '16px',
            fontFamily: 'var(--font-pixel)', fontSize: '6px', letterSpacing: '1px',
            background: 'transparent', border: '1px solid rgba(107,76,42,0.5)',
            color: 'var(--text-dim)', padding: '3px 6px', cursor: 'pointer',
            display: 'flex', gap: '6px', alignItems: 'center',
          }}
          title="Click to open EVE panel"
        >
          <span style={{ color: 'var(--gold)' }}>EVE</span>
          <span>{total} tasks</span>
          {failed > 0 && <span style={{ color: 'var(--red)' }}>{failed} fail</span>}
        </button>
      )}

      {/* Centered title */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--font-pixel)', fontSize: '10px', color: 'var(--gold)', letterSpacing: '2px' }}>
          OPENCLAW QUEST
        </span>
        <span style={{ fontFamily: 'var(--font-pixel)', fontSize: '5px', letterSpacing: '1px', marginTop: '2px' }}>
          <span style={{ color: 'var(--text-dim)' }}>Built on </span>
          <span style={{ color: '#c97d3a' }}>OpenClaw</span>
          <span style={{ color: 'var(--text-dim)' }}> — forked from Hermes Quest</span>
        </span>
      </div>

      {/* Backend connected (right) */}
      <span style={{
        position: 'absolute', right: '16px',
        fontSize: '8px',
        color: connected ? 'var(--green)' : 'var(--red)',
        fontFamily: 'var(--font-pixel)',
      }}>
        {connected ? '●' : '○'}
      </span>
    </div>
  )
}
