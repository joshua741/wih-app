import { useCallback, useState } from 'react'
import type { Contact, WSEvent } from '../types'
import { usePipeline } from '../context/PipelineContext'
import { fetchContact } from '../api'
import { useWebSocket } from './useWebSocket'

export function usePipelineWebSocket() {
  const { dispatch, state } = usePipeline()
  const [activeCallId, setActiveCallId] = useState<string | null>(null)

  const onEvent = useCallback(async (evt: WSEvent) => {
    const p = evt.payload

    switch (evt.event) {
      case 'contact:created': {
        dispatch({ type: 'UPSERT_CONTACT', contact: p as unknown as Contact })
        break
      }
      case 'contact:updated': {
        dispatch({ type: 'UPSERT_CONTACT', contact: p as unknown as Contact })
        break
      }
      case 'contact:stage_changed': {
        const { contactId, stageId } = p as { contactId: string; stageId: string }
        const existing = state.contacts[contactId]
        if (existing) {
          // Refresh full contact to get updated stage_name/stage_color
          try {
            const updated = await fetchContact(contactId)
            dispatch({ type: 'UPSERT_CONTACT', contact: updated })
          } catch {
            dispatch({ type: 'UPSERT_CONTACT', contact: { ...existing, stage_id: stageId } })
          }
        }
        break
      }
      case 'contact:takeover': {
        const { id, agent } = p as { id: string; agent: 'josh' | 'angel' }
        const existing = state.contacts[id]
        if (existing) {
          dispatch({
            type: 'UPSERT_CONTACT',
            contact: { ...existing, human_takeover: true, takeover_by: agent, ai_active: false },
          })
        }
        break
      }
      case 'contact:dnc': {
        const { id } = p as { id: string }
        const existing = state.contacts[id]
        if (existing) {
          dispatch({ type: 'UPSERT_CONTACT', contact: { ...existing, is_dnc: true, ai_active: false } })
        }
        break
      }
      case 'contact:deleted': {
        const { id } = p as { id: string }
        dispatch({ type: 'REMOVE_CONTACT', id })
        break
      }
      case 'sms:inbound': {
        const { contactId } = p as { contactId: string }
        dispatch({ type: 'MARK_UNREAD', id: contactId })
        // Bump updated_at on the contact for recency sort
        const existing = state.contacts[contactId]
        if (existing) {
          dispatch({
            type: 'UPSERT_CONTACT',
            contact: { ...existing, updated_at: new Date().toISOString() },
          })
        }
        break
      }
      case 'deal:created':
      case 'deal:updated': {
        // Refresh the associated contact so deal_type badge updates
        const contactId = p.contact_id as string | undefined
        if (contactId) {
          try {
            const updated = await fetchContact(contactId)
            dispatch({ type: 'UPSERT_CONTACT', contact: updated })
          } catch { /* best-effort */ }
        }
        break
      }
      case 'call:initiated': {
        const { callSid } = p as { callSid: string }
        setActiveCallId(callSid)
        break
      }
      case 'call:status': {
        const { status } = p as { status: string }
        if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
          setActiveCallId(null)
        }
        break
      }
    }
  }, [dispatch, state.contacts])

  useWebSocket({ onEvent })

  return { activeCallId }
}
