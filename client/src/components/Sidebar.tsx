import type { Pipeline } from '../types'
import { usePipeline } from '../context/PipelineContext'

interface Props {
  active: Pipeline
  view: 'pipeline' | 'directory'
  onChange: (p: Pipeline) => void
  onSelectDirectory: () => void
}

const TABS: { id: Pipeline; label: string }[] = [
  { id: 'agent_outreach', label: 'Agent Outreach' },
  { id: 'seller_inbound', label: 'ISP to Lead' },
  { id: 'active_deals', label: 'Disposition' },
]

export function Sidebar({ active, view, onChange, onSelectDirectory }: Props) {
  const { state } = usePipeline()
  const countForPipeline = (pipeline: Pipeline) =>
    Object.values(state.contacts).filter(c => c.pipeline === pipeline && !c.is_dnc).length

  return (
    <div className="flex flex-col w-56 min-h-screen bg-[#1a1a2e] border-r border-white/10 shrink-0">
      <div className="px-5 py-6 border-b border-white/10">
        <div className="text-xs font-bold tracking-widest text-purple-400 uppercase mb-1">WIH</div>
        <div className="text-white font-semibold text-sm leading-tight">Webber Investment<br />Homes</div>
      </div>

      <nav className="flex flex-col gap-1 p-3 flex-1">
        <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase px-3 mb-1">Pipelines</div>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
              view === 'pipeline' && active === tab.id
                ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <span>{tab.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-mono ${
              view === 'pipeline' && active === tab.id ? 'bg-purple-500/40 text-purple-200' : 'bg-white/10 text-slate-400'
            }`}>{countForPipeline(tab.id)}</span>
          </button>
        ))}

        <div className="border-t border-white/10 my-3" />
        <div className="text-[10px] font-bold tracking-widest text-slate-500 uppercase px-3 mb-1">Directory</div>
        <button
          onClick={onSelectDirectory}
          className={`flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
            view === 'directory'
              ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
          }`}
        >
          Contacts
        </button>
      </nav>

      <div className="px-4 py-3 border-t border-white/10">
        <div className="text-xs text-slate-600">Live pipeline</div>
      </div>
    </div>
  )
}
