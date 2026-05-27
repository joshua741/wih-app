import type { Contact } from '../types'
import { usePipeline } from '../context/PipelineContext'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface Props {
  contact: Contact
  onClick: () => void
  isSelected: boolean
}

export function LeadCard({ contact, onClick, isSelected }: Props) {
  const { state } = usePipeline()
  const isUnread = state.unreadIds.has(contact.id)
  const dealType = contact.metadata?.deal_type as string | null | undefined

  const lastMsg = (contact.metadata?.last_message as string | null) ?? ''
  const preview = lastMsg.length > 60 ? lastMsg.slice(0, 60) + '…' : lastMsg

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-3 transition-all cursor-pointer ${
        isSelected
          ? 'bg-purple-600/20 border-purple-500/60'
          : 'bg-white/4 border-white/8 hover:bg-white/7 hover:border-white/15'
      } ${contact.is_dnc ? 'opacity-40' : ''}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isUnread && (
            <span className="shrink-0 w-2 h-2 rounded-full bg-blue-400" />
          )}
          <span className="font-medium text-sm text-white truncate">
            {contact.name ?? contact.phone}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {contact.human_takeover && (
            <span className="text-orange-400 text-xs" title="Needs human">⚠️</span>
          )}
          {dealType === 'cash' && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium border border-emerald-500/30">CASH</span>
          )}
          {dealType === 'creative_finance' && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium border border-blue-500/30">CREATIVE</span>
          )}
          {dealType === 'wholetail' && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium border border-amber-500/30">WHOLETAIL</span>
          )}
          {contact.is_dnc && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-slate-600/40 text-slate-500 font-medium">DEAD</span>
          )}
        </div>
      </div>

      <div className="text-xs text-slate-500 mb-1.5 font-mono">{contact.phone}</div>

      {preview && (
        <div className="text-xs text-slate-400 truncate mb-1.5">{preview}</div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-600">{timeAgo(contact.updated_at)}</span>
        {contact.takeover_by && (
          <span className="text-xs text-orange-400 font-medium">{contact.takeover_by}</span>
        )}
      </div>
    </button>
  )
}
