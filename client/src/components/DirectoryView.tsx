import { useEffect, useState, useCallback } from 'react'
import type { DirectoryContact, FilterSpec } from '../types'
import { fetchDirectory, bulkLabelDirectory, fetchLabels, startOutreachApi } from '../api'
import { DirectoryDetailPanel } from './DirectoryDetailPanel'
import { AdvancedFilterPanel } from './AdvancedFilterPanel'
import { LabelSidebar, type LabelSelection } from './LabelSidebar'

export function DirectoryView() {
  const [rows, setRows] = useState<DirectoryContact[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterSpec | undefined>()
  const [showFilters, setShowFilters] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<LabelSelection>({ label: null, junk: false })
  const [version, setVersion] = useState(0)
  const [allLabels, setAllLabels] = useState<string[]>([])
  const [outreachOpen, setOutreachOpen] = useState(false)
  const pageSize = 50

  useEffect(() => { fetchLabels().then(setAllLabels) }, [])

  const load = useCallback(() => {
    fetchDirectory({
      search,
      filters,
      label: sel.label || undefined,
      only_junk: sel.junk || undefined,
      page,
      pageSize,
    }).then(r => { setRows(r.contacts); setTotal(r.total) })
  }, [search, filters, sel, page])

  useEffect(() => { load() }, [load])

  function toggle(id: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function bumpCounts() { setVersion(v => v + 1) }

  async function applyBulkLabel(label: string, mode: 'add' | 'remove') {
    const ids = Array.from(checked)
    if (!ids.length || !label) return
    await bulkLabelDirectory(ids, mode === 'add' ? [label] : [], mode === 'remove' ? [label] : [])
    setChecked(new Set()); load(); bumpCounts()
  }

  async function startOutreach(pipeline: 'agent_outreach' | 'seller_inbound') {
    const ids = Array.from(checked)
    if (!ids.length) return
    const r = await startOutreachApi(ids, pipeline)
    alert(`Outreach queued for ${r.queued} contact(s).`)
    setOutreachOpen(false)
    setChecked(new Set()); load(); bumpCounts()
  }

  async function exportCsv() {
    const ids = Array.from(checked)
    const res = await fetch('/api/directory/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'directory-export.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-1 min-h-0">
      <LabelSidebar
        selected={sel}
        version={version}
        onSelect={s => { setPage(1); setSel(s); setSelectedId(null) }}
      />

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-3 p-4 border-b border-white/10 bg-[#12121f]">
          <input
            value={search}
            onChange={e => { setPage(1); setSearch(e.target.value) }}
            placeholder="Search name, phone, or email…"
            className="flex-1 bg-[#1a1a2e] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500"
          />
          <button onClick={() => setShowFilters(s => !s)}
            className="px-3 py-2 rounded-lg text-sm bg-white/5 text-slate-300 hover:bg-white/10">
            Filters{filters?.conditions.length ? ` (${filters.conditions.length})` : ''}
          </button>
          <span className="text-xs text-slate-500">{total.toLocaleString()} contacts</span>
        </div>

        {checked.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 bg-purple-600/20 border-b border-purple-500/30 text-sm">
            <span className="text-purple-200">{checked.size} selected</span>
            <select value="" onChange={e => { applyBulkLabel(e.target.value, 'add'); e.target.value = '' }}
              className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-slate-200 text-xs">
              <option value="">+ Add label…</option>
              {allLabels.filter(l => l !== 'uncategorized').map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select value="" onChange={e => { applyBulkLabel(e.target.value, 'remove'); e.target.value = '' }}
              className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-slate-200 text-xs">
              <option value="">− Remove label…</option>
              {allLabels.filter(l => l !== 'uncategorized').map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            {!outreachOpen ? (
              <button onClick={() => setOutreachOpen(true)} className="text-slate-200 hover:text-white">Start outreach</button>
            ) : (
              <span className="flex items-center gap-2">
                <span className="text-purple-200">Send first text via:</span>
                <button onClick={() => startOutreach('agent_outreach')}
                  className="px-2 py-0.5 rounded bg-blue-600/30 text-blue-200 text-xs hover:bg-blue-600/50">Agent</button>
                <button onClick={() => startOutreach('seller_inbound')}
                  className="px-2 py-0.5 rounded bg-amber-600/30 text-amber-200 text-xs hover:bg-amber-600/50">Seller</button>
                <button onClick={() => setOutreachOpen(false)} className="text-slate-400 hover:text-white text-xs">cancel</button>
              </span>
            )}
            <button onClick={exportCsv} className="text-slate-200 hover:text-white">Export CSV</button>
            <button onClick={() => setChecked(new Set())} className="text-slate-400 hover:text-white">Clear</button>
          </div>
        )}

        <div className="overflow-auto flex-1">
          <table className="w-full text-sm text-left">
            <thead className="sticky top-0 bg-[#12121f] text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="p-3 w-8"></th>
                <th className="p-3">Name</th>
                <th className="p-3">Phone</th>
                <th className="p-3">Email</th>
                <th className="p-3">Tags</th>
                <th className="p-3">Street Address</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${selectedId === r.id ? 'bg-white/5' : ''}`}>
                  <td className="p-3" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="p-3 text-white">{r.full_name || '—'}</td>
                  <td className="p-3 text-slate-300">{r.phone || '—'}</td>
                  <td className="p-3 text-slate-300">{r.email || '—'}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {r.categories.filter(c => c !== 'uncategorized').map(c => (
                        <span key={c} className="px-2 py-0.5 rounded-full bg-white/10 text-slate-300 text-xs">{c}</span>
                      ))}
                      {r.categories.filter(c => c !== 'uncategorized').length === 0 && <span className="text-slate-600">—</span>}
                    </div>
                  </td>
                  <td className="p-3 text-slate-400">{r.address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between p-3 border-t border-white/10 text-sm text-slate-400">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 rounded bg-white/5 disabled:opacity-30">Prev</button>
          <span>Page {page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 rounded bg-white/5 disabled:opacity-30">Next</button>
        </div>
      </div>

      {showFilters && (
        <AdvancedFilterPanel
          value={filters}
          onApply={f => { setPage(1); setFilters(f); setShowFilters(false) }}
          onClose={() => setShowFilters(false)}
        />
      )}
      {selectedId && (
        <DirectoryDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => { load(); bumpCounts() }}
        />
      )}
    </div>
  )
}
