import { useEffect, useState } from 'react'
import { fetchLabels } from '../api'

// Reusable multi-label chip editor. `value` is the current labels; `onChange`
// fires with the next array whenever a label is added or removed.
export function LabelEditor({ value, onChange }: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [all, setAll] = useState<string[]>([])
  useEffect(() => { fetchLabels().then(setAll) }, [])
  const available = all.filter(l => l !== 'uncategorized' && !value.includes(l))

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {value.filter(l => l !== 'uncategorized').map(l => (
        <span key={l} className="px-2 py-0.5 rounded-full bg-purple-600/30 text-purple-100 text-xs flex items-center gap-1">
          {l}
          <button onClick={() => onChange(value.filter(x => x !== l))}
            className="text-purple-300 hover:text-white">×</button>
        </span>
      ))}
      {available.length > 0 && (
        <select value="" onChange={e => { if (e.target.value) onChange([...value.filter(x => x !== 'uncategorized'), e.target.value]) }}
          className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-0.5 text-xs text-slate-300">
          <option value="">+ label</option>
          {available.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
    </div>
  )
}
