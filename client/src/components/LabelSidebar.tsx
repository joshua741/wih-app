import { useEffect, useState } from 'react'
import { fetchLabelCounts } from '../api'
import type { LabelCounts } from '../types'

export interface LabelSelection { label: string | null; junk: boolean }

// Left rail of labels with live counts. `version` bumps to force a count refresh
// after the user edits labels elsewhere.
export function LabelSidebar({ selected, onSelect, version }: {
  selected: LabelSelection
  onSelect: (s: LabelSelection) => void
  version: number
}) {
  const [data, setData] = useState<LabelCounts | null>(null)
  useEffect(() => { fetchLabelCounts().then(setData) }, [version])

  const Row = ({ id, label, n, active, onClick }: {
    id: string; label: string; n: number; active: boolean; onClick: () => void
  }) => (
    <button key={id} onClick={onClick}
      className={`flex items-center justify-between w-full px-3 py-1.5 rounded text-sm ${
        active ? 'bg-purple-600/30 text-white' : 'text-slate-300 hover:bg-white/5'}`}>
      <span className="truncate">{label}</span>
      <span className="text-xs text-slate-500 ml-2">{n.toLocaleString()}</span>
    </button>
  )

  return (
    <div className="w-52 shrink-0 border-r border-white/10 bg-[#12121f] p-2 overflow-y-auto space-y-0.5">
      <Row id="all" label="All" n={data?.total_active ?? 0}
        active={selected.label === null && !selected.junk}
        onClick={() => onSelect({ label: null, junk: false })} />
      {(data?.labels ?? []).map(l => (
        <Row key={l.label} id={l.label} label={l.label} n={l.n}
          active={selected.label === l.label && !selected.junk}
          onClick={() => onSelect({ label: l.label, junk: false })} />
      ))}
      <div className="border-t border-white/10 my-1" />
      <Row id="junk" label="Junk" n={data?.junk ?? 0}
        active={selected.junk}
        onClick={() => onSelect({ label: null, junk: true })} />
    </div>
  )
}
