import type { Pipeline } from '../types'
import { usePipeline } from '../context/PipelineContext'

const LABELS: Record<Pipeline, string> = {
  agent_outreach: 'Agent Outreach',
  seller_inbound: 'ISP to Lead',
  active_deals: 'Disposition',
}

interface Props {
  pipeline: Pipeline
  search: string
  onSearch: (q: string) => void
}

export function TopBar({ pipeline, search, onSearch }: Props) {
  const { state } = usePipeline()
  const total = Object.values(state.contacts).filter(c => c.pipeline === pipeline && !c.is_dnc).length

  return (
    <div className="flex items-center gap-4 px-5 py-3 bg-[#12122a] border-b border-white/10 shrink-0">
      <h1 className="text-white font-semibold text-base shrink-0">{LABELS[pipeline]}</h1>
      <span className="text-xs text-slate-500 font-mono shrink-0">{total} leads</span>
      <div className="flex-1" />
      <input
        type="text"
        value={search}
        onChange={e => onSearch(e.target.value)}
        placeholder="Search leads..."
        className="w-64 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-purple-500/50 focus:bg-white/8 transition-colors"
      />
    </div>
  )
}
