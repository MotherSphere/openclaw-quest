import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { API_URL } from '../api'

type TaskRun = {
  task_id: string
  runtime: string
  task_kind: string | null
  agent_id: string | null
  label: string | null
  status: string
  created_at: number | null
  started_at: number | null
  ended_at: number | null
  last_event_at: number | null
  error: string | null
  progress_summary: string | null
  terminal_summary: string | null
  terminal_outcome: string | null
}

type StatusSummary = {
  available: boolean
  agents: Array<{ id: string; model: string }>
  tasks: {
    by_status: Record<string, number>
    by_runtime: Record<string, number>
    total: number
    last_event_at: number | null
  }
  openclaw_home: string
}

const STATUS_COLORS: Record<string, string> = {
  succeeded: 'var(--green)',
  failed: 'var(--red)',
  running: 'var(--cyan)',
  cancelled: 'var(--text-dim)',
}

const RUNTIME_COLORS: Record<string, string> = {
  cron: 'var(--purple)',
  cli: 'var(--gold)',
  subagent: 'var(--cyan)',
}

function timeAgo(ms: number | null): string {
  if (!ms) return '-'
  const delta = Date.now() - ms
  if (delta < 0) return 'just now'
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

export default function EvePanel() {
  const [tasks, setTasks] = useState<TaskRun[]>([])
  const [summary, setSummary] = useState<StatusSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [tasksResp, summaryResp] = await Promise.all([
          fetch(`${API_URL}/api/openclaw/tasks?limit=50`),
          fetch(`${API_URL}/api/openclaw/status`),
        ])
        if (!tasksResp.ok || !summaryResp.ok) throw new Error(`HTTP ${tasksResp.status}/${summaryResp.status}`)
        const tasksData = await tasksResp.json()
        const summaryData = await summaryResp.json()
        if (!cancelled) {
          setTasks(tasksData.tasks || [])
          setSummary(summaryData)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 10000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const panelStyle: CSSProperties = {
    fontFamily: 'var(--font-pixel)',
    fontSize: '8px',
    padding: '12px 14px',
    height: '100%',
    overflow: 'auto',
    background: 'linear-gradient(180deg, #14100a 0%, #0d0a06 100%)',
    color: 'var(--text)',
  }

  if (loading) {
    return <div style={panelStyle}><div style={{ color: 'var(--text-dim)' }}>Reading EVE's ledger...</div></div>
  }

  if (error) {
    return (
      <div style={panelStyle}>
        <div style={{ color: 'var(--red)', marginBottom: '6px' }}>EVE bridge unreachable</div>
        <div style={{ color: 'var(--text-dim)', fontSize: '7px' }}>{error}</div>
      </div>
    )
  }

  if (!summary?.available) {
    return (
      <div style={panelStyle}>
        <div style={{ color: 'var(--text-dim)' }}>
          No OpenClaw runtime detected at {summary?.openclaw_home || '~/.openclaw'}.
        </div>
      </div>
    )
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontSize: '11px', color: 'var(--gold)', letterSpacing: '3px', marginBottom: '10px' }}>
        EVE — OPENCLAW AGENT
      </div>

      {/* Header summary */}
      <div style={{ marginBottom: '14px', color: 'var(--text-dim)', lineHeight: 1.8 }}>
        <div>
          <span style={{ color: 'var(--text-dim)' }}>agents: </span>
          {summary.agents.length === 0 ? (
            <span>none</span>
          ) : (
            summary.agents.map((a) => (
              <span key={a.id} style={{ marginRight: '10px' }}>
                <span style={{ color: 'var(--gold)' }}>{a.id}</span>
                <span style={{ color: 'var(--text-dim)' }}> · {a.model}</span>
              </span>
            ))
          )}
        </div>
        <div style={{ marginTop: '2px' }}>
          <span>total tasks: </span>
          <span style={{ color: 'var(--text)' }}>{summary.tasks.total}</span>
          <span style={{ marginLeft: '14px' }}>
            {Object.entries(summary.tasks.by_status).map(([k, v]) => (
              <span key={k} style={{ marginRight: '10px', color: STATUS_COLORS[k] || 'var(--text-dim)' }}>
                {k}: {v}
              </span>
            ))}
          </span>
        </div>
        <div style={{ marginTop: '2px' }}>
          <span>by runtime: </span>
          {Object.entries(summary.tasks.by_runtime).map(([k, v]) => (
            <span key={k} style={{ marginRight: '10px', color: RUNTIME_COLORS[k] || 'var(--text-dim)' }}>
              {k}: {v}
            </span>
          ))}
        </div>
      </div>

      {/* Task rows */}
      <div style={{ borderTop: '1px solid rgba(107,76,42,0.35)', paddingTop: '8px' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 50px 70px 40px',
          gap: '2px 12px',
          color: 'var(--text-dim)',
          fontSize: '6px',
          letterSpacing: '1px',
          paddingBottom: '6px',
          borderBottom: '1px dashed rgba(107,76,42,0.25)',
          marginBottom: '6px',
        }}>
          <div>LABEL</div>
          <div>RUNTIME</div>
          <div>STATUS</div>
          <div style={{ textAlign: 'right' }}>AGO</div>
        </div>

        {tasks.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', padding: '12px 0' }}>No tasks recorded.</div>
        ) : (
          tasks.map((t) => (
            <div
              key={t.task_id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 50px 70px 40px',
                gap: '2px 12px',
                padding: '3px 0',
                borderBottom: '1px dotted rgba(107,76,42,0.15)',
                alignItems: 'center',
              }}
              title={t.terminal_summary || t.progress_summary || t.error || ''}
            >
              <div style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: 'var(--text)',
              }}>
                {t.label || t.task_id.slice(0, 12)}
              </div>
              <div style={{ color: RUNTIME_COLORS[t.runtime] || 'var(--text-dim)', fontSize: '7px' }}>
                {t.runtime}
              </div>
              <div style={{ color: STATUS_COLORS[t.status] || 'var(--text-dim)', fontSize: '7px' }}>
                {t.status}
              </div>
              <div style={{ color: 'var(--text-dim)', fontSize: '7px', textAlign: 'right' }}>
                {timeAgo(t.created_at)}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ marginTop: '10px', color: 'var(--text-dim)', fontSize: '6px', letterSpacing: '1px' }}>
        refreshed every 10s · read-only view of ~/.openclaw/tasks/runs.sqlite
      </div>
    </div>
  )
}
