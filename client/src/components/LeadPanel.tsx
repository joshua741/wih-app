import { useState, useEffect, useRef } from 'react'
import type { Contact, Message, Pipeline } from '../types'
import { fetchMessages, sendMessage, markDNC, initiateCall, moveStage, patchContact } from '../api'
import { usePipeline } from '../context/PipelineContext'
import { NotesTab } from './NotesTab'

interface Props {
  contact: Contact
  onClose: () => void
  activeCallId: string | null
}

type Tab = 'messages' | 'details' | 'notes'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const PIPELINE_LABELS: Record<string, string> = {
  agent_outreach: 'Agent Outreach',
  seller_inbound: 'Seller Inbound',
  active_deals: 'Active Deals',
}

const PIPELINE_ORDER: Pipeline[] = ['agent_outreach', 'seller_inbound', 'active_deals']

export function LeadPanel({ contact, onClose, activeCallId }: Props) {
  const { state, dispatch } = usePipeline()
  const [tab, setTab] = useState<Tab>('messages')

  // Messages
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(true)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Actions
  const [dncConfirm, setDncConfirm] = useState(false)
  const [callStatus, setCallStatus] = useState<string | null>(null)

  // Details form
  const [name, setName] = useState(contact.name ?? '')
  const [email, setEmail] = useState(contact.email ?? '')
  const [address, setAddress] = useState(contact.address ?? '')
  const [city, setCity] = useState(contact.city ?? '')
  const [stateVal, setStateVal] = useState(contact.state ?? '')
  const [zip, setZip] = useState(contact.zip ?? '')
  const [saving, setSaving] = useState(false)

  // Reset form fields when contact switches
  useEffect(() => {
    setName(contact.name ?? '')
    setEmail(contact.email ?? '')
    setAddress(contact.address ?? '')
    setCity(contact.city ?? '')
    setStateVal(contact.state ?? '')
    setZip(contact.zip ?? '')
  }, [contact.id])

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
    const updated = await moveStage(contact.id, stageId)
    dispatch({ type: 'UPSERT_CONTACT', contact: updated })
  }

  async function handleSaveDetails() {
    setSaving(true)
    try {
      const updated = await patchContact(contact.id, {
        name: name || null,
        email: email || null,
        address: address || null,
        city: city || null,
        state: stateVal || null,
        zip: zip || null,
      })
      dispatch({ type: 'UPSERT_CONTACT', contact: updated })
    } finally {
      setSaving(false)
    }
  }

  const dealType = contact.metadata?.deal_type as string | null | undefined
  const isActiveCall = activeCallId != null
  const allStages = state.stages

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

      {/* Tab bar */}
      <div className="flex border-b border-white/10 shrink-0">
        {(['messages', 'details', 'notes'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-xs font-medium capitalize transition-colors ${
              tab === t
                ? 'text-purple-400 border-b-2 border-purple-400'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Messages tab */}
      {tab === 'messages' && (
        <>
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
        </>
      )}

      {/* Details tab */}
      {tab === 'details' && (
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
          <Field label="Name">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Contact name"
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
            <input value={contact.phone} readOnly className={readonlyCls} />
          </Field>
          <Field label="Email">
            <input
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="email@example.com"
              type="email"
              className={inputCls}
            />
          </Field>
          <Field label="Property Address">
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Street address"
              className={inputCls}
            />
          </Field>
          <div className="flex gap-2">
            <Field label="City" className="flex-1">
              <input value={city} onChange={e => setCity(e.target.value)} placeholder="City" className={inputCls} />
            </Field>
            <Field label="State" className="w-16">
              <input value={stateVal} onChange={e => setStateVal(e.target.value)} placeholder="TX" maxLength={2} className={inputCls} />
            </Field>
            <Field label="Zip" className="w-24">
              <input value={zip} onChange={e => setZip(e.target.value)} placeholder="79401" className={inputCls} />
            </Field>
          </div>
          <Field label="Pipeline">
            <div className={readonlyCls}>{PIPELINE_LABELS[contact.pipeline] ?? contact.pipeline}</div>
          </Field>
          <Field label="Stage">
            <div className={readonlyCls}>{contact.stage_name ?? '—'}</div>
          </Field>
          <button
            onClick={handleSaveDetails}
            disabled={saving}
            className="mt-1 w-full py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? 'Saving…' : 'Save Details'}
          </button>
        </div>
      )}

      {/* Notes tab */}
      {tab === 'notes' && <NotesTab contactId={contact.id} />}

      {/* Bottom actions — always visible */}
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
            <option value="" disabled>Move to stage…</option>
            {PIPELINE_ORDER.map(p => {
              const pStages = allStages
                .filter(s => s.pipeline === p)
                .sort((a, b) => a.position - b.position)
              if (!pStages.length) return null
              return (
                <optgroup key={p} label={PIPELINE_LABELS[p]}>
                  {pStages.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </optgroup>
              )
            })}
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

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      <label className="text-xs text-slate-500">{label}</label>
      {children}
    </div>
  )
}

const inputCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-purple-500/50 transition-colors'
const readonlyCls = 'w-full bg-white/3 border border-white/5 rounded-lg px-3 py-2 text-sm text-slate-400 cursor-not-allowed'

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
