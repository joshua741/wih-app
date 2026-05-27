import type { Contact, Pipeline } from '../types'
import { usePipeline } from '../context/PipelineContext'
import { StageColumn } from './StageColumn'

interface Props {
  pipeline: Pipeline
  search: string
  selectedId: string | null
  onSelect: (contact: Contact) => void
}

export function KanbanBoard({ pipeline, search, selectedId, onSelect }: Props) {
  const { getStagesForPipeline, state } = usePipeline()
  const stages = getStagesForPipeline(pipeline)

  if (state.loading) {
    return (
      <div className="flex items-center justify-center flex-1 text-slate-500 text-sm">
        Loading pipeline…
      </div>
    )
  }

  return (
    <div className="flex gap-4 p-4 overflow-x-auto flex-1 items-start">
      {stages.map(stage => (
        <StageColumn
          key={stage.id}
          stage={stage}
          pipeline={pipeline}
          search={search}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
      {stages.length === 0 && (
        <div className="flex items-center justify-center flex-1 text-slate-600 text-sm">
          No stages configured for this pipeline.
        </div>
      )}
    </div>
  )
}
