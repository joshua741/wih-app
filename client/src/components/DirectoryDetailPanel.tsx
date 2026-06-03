import { useEffect, useState } from 'react'
import type { DirectoryContactDetail } from '../types'
import { fetchDirectoryContact, patchDirectoryContact } from '../api'
import { LabelEditor } from './LabelEditor'

export function DirectoryDetailPanel({ id, onClose, onChanged }: {
  id: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [c, setC] = useState<DirectoryContactDetail | null>(null)
  useEffect(() => { fetchDirectoryContact(id).then(setC) }, [id])

  async function setLabels(next: string[]) {
    if (!c) return
    const categories = next.length ? next : ['uncategorized']
    setC({ ...c, categories })
    await patchDirectoryContact(id, { categories })
    onChanged?.()
  }

  if (!c) return (
    <div className="w-96 border-l border-white/10 bg-[#1a1a2e] p-4 text-slate-400">Loading…</div>
  )
  const fields = Object.entries(c.data).filter(([, v]) => v && String(v).trim())
  return (
    <div className="w-96 border-l border-white/10 bg-[#1a1a2e] flex flex-col min-h-0">
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="text-white font-semibold">{c.full_name || '(no name)'}</div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
      </div>
      <div className="overflow-y-auto p-4 text-sm space-y-3">
        <div className="text-slate-300">{c.phone} · {c.email}</div>
        {c.address && <div className="text-slate-400">{c.address}</div>}

        <div>
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">Tags / Labels</div>
          <LabelEditor value={c.categories} onChange={setLabels} />
        </div>

        {c.tags.length > 0 && (
          <div className="text-slate-400 text-xs">GHL tags: {c.tags.join(', ')}</div>
        )}

        <div className="border-t border-white/10 pt-3">
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">Pipelines &amp; Opportunities</div>
          {c.pipeline_matches.length === 0
            ? <div className="text-slate-500">Not in any pipeline.</div>
            : c.pipeline_matches.map(m => (
                <div key={m.id} className="text-slate-300">{m.pipeline} — {m.stage_name || 'no stage'}</div>
              ))}
        </div>

        <div className="border-t border-white/10 pt-3">
          <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase mb-2">All fields</div>
          {fields.map(([k, v]) => (
            <div key={k} className="mb-1">
              <span className="text-slate-500">{k}:</span> <span className="text-slate-200">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
