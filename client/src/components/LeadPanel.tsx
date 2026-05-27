import { useState, useEffect, useRef } from 'react'
import type { Contact, Message, Pipeline } from '../types'
import { fetchMessages, sendMessage, markDNC, initiateCall, moveStage } from '../api'
import { usePipeline } from '../context/PipelineContext'

interface Props {
  contact: Contact
  onClose: () => void
  activeCallId: string | null
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}


export function LeadPanel({ contact, onClose, activeCallId }: Props) {
  const { getStagesForPipeline, dispatch } = usePipeline()
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(true)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [dncConfirm, setDncConfirm] = useState(false)
  const [callStatus, setCallStatus] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const stages = getStagesForPipeline(contact.pipeline as Pipeline)

  useEffect(() => {
    setLoadingMsgs(true)
    fetchMessages(contact.id)
      .then(setMessages)
      .finally(() => setLoadingMsgs(false))
  }, [contact.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    if (!reply.trim() || sending) return
    setSending(true)
    try {
      const msg = await sendMessage(contact.id, reply.trim())
      setMessages(prev => [...prev, msg])
      setReply('')
    } finally {
      setSending(false)
    }
  }

  async function handleDNC() {
    await markDNC(contact.id, 'marked from dashboard')
    dispatch({ type: 'UPSERT_CONTACT', contact: { ...contact, is_dnc: true, ai_active: false } })
    onClose()
  }

  async function handleCall(agent: 'josh' | 'angel') {
    setCallStatus('calling…')
    try {
      await initiateCall(contact.phone, agent)
      setCallStatus(`calling with ${agent}`)
    } catch {
      setCallStatus('call failed')
    }
  }

  async function handleStageChange(stageId: string) {
    await moveStage(contact.id, stageId)
    const stage = stages.find(s => s.id === stageId)
    dispatch({
      type: 'UPSERT_CONTACT',
      contact: { ...contact, stage_id: stageId, stage_name: stage?.name ?? null, stage_color: stage?.color ?? null },
    })
  }

  const dealType = contact.metadata?.deal_type as string | null | undefined

  const isActiveCall = activeCallId != null

  return (
    <div className="flex flex-col w-[480px] shrink-0 bg-[#12122a] border-l border-white/10 h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white truncate">{contact.name ?? contact.phone}</span>
            {dealType === 'cash' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">CASH</span>
            )}
            {dealType === 'creative_finance' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">CREATIVE</span>
            )}
            {dealType === 'wholetail' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">WHOLETAIL</span>
            )}
            {contact.human_takeover && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">NEEDS HUMAN</span>
            )}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">{contact.phone}</div>
          {contact.takeover_by && (
            <div className="text-xs text-slate-400 mt-0.5">Assigned: {contact.takeover_by}</div>
          )}
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors text-lg shrink-0 ml-2">✕</button>
      </div>

      {/* Active call indicator */}
      {isActiveCall && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-500/15 border-b border-green-500/30 shrink-0">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-xs text-green-400 font-medium">Active call in progress</span>
        </div>
      )}

      {/* Deal row */}
      <div className="px-4 py-3 border-b border-white/10 shrink-0">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-slate-600 mb-0.5">Stage</div>
            <div className="text-slate-300">{contact.stage_name ?? '—'}</div>
          </div>
          <div>
            <div className="text-slate-600 mb-0.5">Pipeline</div>
            <div className="text-slate-300 capitalize">{contact.pipeline.replace('_', ' ')}</div>
          </div>
          <div>
            <div className="text-slate-600 mb-0.5">Address</div>
            <div className="text-slate-300 truncate">{contact.address ?? '—'}</div>
          </div>
        </div>
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {loadingMsgs ? (
          <div className="text-xs text-slate-600 text-center py-4">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div className="text-xs text-slate-700 text-center py-4">No messages yet</div>
        ) : (
          messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply box */}
      <div className="px-4 py-3 border-t border-white/10 shrink-0">
        <div className="flex gap-2">
          <textarea
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="Type a message… (Enter to send)"
            rows={2}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-purple-500/50 resize-none transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={sending || !reply.trim()}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors self-end"
          >
            Send
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4 py-3 border-t border-white/10 shrink-0 flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            onClick={() => handleCall('angel')}
            className="flex-1 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-400 text-xs font-medium rounded-lg transition-colors"
          >
            Call with Angel
          </button>
          <button
            onClick={() => handleCall('josh')}
            className="flex-1 py-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 text-xs font-medium rounded-lg transition-colors"
          >
            Call with Josh
          </button>
        </div>

        {callStatus && (
          <div className="text-xs text-center text-slate-400">{callStatus}</div>
        )}

        <div className="flex gap-2 items-center">
          <select
            value={contact.stage_id ?? ''}
            onChange={e => handleStageChange(e.target.value)}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-purple-500/50"
          >
            <option value="" disabled>Move stage…</option>
            {stages.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          {!dncConfirm ? (
            <button
              onClick={() => setDncConfirm(true)}
              className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 border border-red-500/30 text-red-400 text-xs font-medium rounded-lg transition-colors"
            >
              Mark DNC
            </button>
          ) : (
            <div className="flex gap-1">
              <button
                onClick={handleDNC}
                className="px-2 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => setDncConfirm(false)}
                className="px-2 py-1.5 bg-white/5 text-slate-400 text-xs rounded-lg"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: Message }) {
  const isContact = msg.sender === 'contact'
  const isAI = msg.sender === 'ai'

  return (
    <div className={`flex flex-col gap-0.5 ${isContact ? 'items-start' : 'items-end'}`}>
      <span className="text-xs text-slate-600 px-1">
        {isContact ? 'Seller' : isAI ? 'AI' : 'Human'}
      </span>
      <div
        className={`max-w-[80%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
          isContact
            ? 'bg-slate-700/60 text-slate-200 rounded-tl-sm'
            : isAI
            ? 'bg-blue-600/30 text-blue-100 border border-blue-500/20 rounded-tr-sm'
            : 'bg-emerald-600/30 text-emerald-100 border border-emerald-500/20 rounded-tr-sm'
        }`}
      >
        {msg.body}
      </div>
      <span className="text-xs text-slate-700 px-1">{timeLabel(msg.created_at)}</span>
    </div>
  )
}
