import type { Contact, PipelineStage, Pipeline } from '../types'
import { usePipeline } from '../context/PipelineContext'
import { LeadCard } from './LeadCard'

interface Props {
  stage: PipelineStage
  pipeline: Pipeline
  search: string
  selectedId: string | null
  onSelect: (contact: Contact) => void
}

export function StageColumn({ stage, pipeline, search, selectedId, onSelect }: Props) {
  const { getContactsByPipelineAndStage } = usePipeline()

  let contacts = getContactsByPipelineAndStage(pipeline, stage.id)

  if (search) {
    const q = search.toLowerCase()
    contacts = contacts.filter(
      c =>
        c.name?.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.address?.toLowerCase().includes(q)
    )
  }

  return (
    <div className="flex flex-col shrink-0 w-64 bg-white/2 rounded-xl border border-white/8">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/8">
        <div className="flex items-center gap-2">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: stage.color }}
          />
          <span className="text-xs font-semibold text-slate-300 truncate">{stage.name}</span>
        </div>
        <span className="text-xs text-slate-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
          {contacts.length}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1" style={{ maxHeight: 'calc(100vh - 140px)' }}>
        {contacts.length === 0 ? (
          <div className="text-xs text-slate-700 text-center py-6">Empty</div>
        ) : (
          contacts.map(c => (
            <LeadCard
              key={c.id}
              contact={c}
              onClick={() => onSelect(c)}
              isSelected={selectedId === c.id}
            />
          ))
        )}
      </div>
    </div>
  )
}
