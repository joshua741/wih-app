import { useEffect, useState } from 'react'
import type { FilterSpec, FilterCondition, FilterOperator } from '../types'
import { fetchDirectoryFields } from '../api'

const OPERATORS: { id: FilterOperator; label: string; needsValue: boolean }[] = [
  { id: 'is', label: 'is', needsValue: true },
  { id: 'is_not', label: 'is not', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'empty', label: 'is empty', needsValue: false },
  { id: 'not_empty', label: 'is not empty', needsValue: false },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
]

interface Props {
  value?: FilterSpec
  onApply: (f: FilterSpec | undefined) => void
  onClose: () => void
}

export function AdvancedFilterPanel({ value, onApply, onClose }: Props) {
  const [fields, setFields] = useState<string[]>([])
  const [combinator, setCombinator] = useState<'AND' | 'OR'>(value?.combinator || 'AND')
  const [conds, setConds] = useState<FilterCondition[]>(value?.conditions || [])

  useEffect(() => {
    fetchDirectoryFields().then(f => setFields([...f.core, ...f.jsonb]))
  }, [])

  function add() {
    setConds(c => [...c, { field: fields[0] || 'full_name', operator: 'contains', value: '' }])
  }
  function update(i: number, patch: Partial<FilterCondition>) {
    setConds(c => c.map((x, j) => j === i ? { ...x, ...patch } : x))
  }
  function remove(i: number) {
    setConds(c => c.filter((_, j) => j !== i))
  }

  return (
    <div className="w-[28rem] border-l border-white/10 bg-[#1a1a2e] flex flex-col min-h-0">
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="text-white font-semibold">Advanced Filter</div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="p-4 flex items-center gap-2 text-sm">
        <span className="text-slate-400">Match</span>
        <select value={combinator} onChange={e => setCombinator(e.target.value as 'AND' | 'OR')}
          className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white">
          <option value="AND">ALL</option>
          <option value="OR">ANY</option>
        </select>
        <span className="text-slate-400">of the conditions</span>
      </div>

      <div className="overflow-y-auto flex-1 px-4 space-y-3">
        {conds.map((c, i) => {
          const op = OPERATORS.find(o => o.id === c.operator)!
          return (
            <div key={i} className="space-y-2 border border-white/10 rounded-lg p-2">
              <select value={c.field} onChange={e => update(i, { field: e.target.value })}
                className="w-full bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white text-sm">
                {fields.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <div className="flex gap-2">
                <select value={c.operator} onChange={e => update(i, { operator: e.target.value as FilterOperator })}
                  className="bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white text-sm">
                  {OPERATORS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {op.needsValue && (
                  <input value={c.value || ''} onChange={e => update(i, { value: e.target.value })}
                    className="flex-1 bg-[#0f0f1a] border border-white/10 rounded px-2 py-1 text-white text-sm" />
                )}
                <button onClick={() => remove(i)} className="text-slate-500 hover:text-red-400">✕</button>
              </div>
            </div>
          )
        })}
        <button onClick={add} className="text-purple-300 text-sm hover:text-purple-200">+ Add condition</button>
      </div>

      <div className="p-4 border-t border-white/10 flex gap-2">
        <button onClick={() => onApply(conds.length ? { combinator, conditions: conds } : undefined)}
          className="flex-1 bg-purple-600 hover:bg-purple-500 text-white rounded-lg py-2 text-sm">Apply</button>
        <button onClick={() => { setConds([]); onApply(undefined) }}
          className="px-3 bg-white/5 text-slate-300 rounded-lg py-2 text-sm hover:bg-white/10">Clear</button>
      </div>
    </div>
  )
}
