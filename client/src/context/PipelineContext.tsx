import React, { createContext, useContext, useEffect, useReducer, useCallback } from 'react'
import type { Contact, Pipeline, PipelineStage } from '../types'
import { fetchContacts, fetchStages } from '../api'

interface PipelineState {
  contacts: Record<string, Contact>
  stages: PipelineStage[]
  loading: boolean
  unreadIds: Set<string>
}

type Action =
  | { type: 'SET_CONTACTS'; contacts: Contact[] }
  | { type: 'SET_STAGES'; stages: PipelineStage[] }
  | { type: 'UPSERT_CONTACT'; contact: Contact }
  | { type: 'REMOVE_CONTACT'; id: string }
  | { type: 'MARK_UNREAD'; id: string }
  | { type: 'CLEAR_UNREAD'; id: string }
  | { type: 'SET_LOADING'; loading: boolean }

function reducer(state: PipelineState, action: Action): PipelineState {
  switch (action.type) {
    case 'SET_CONTACTS': {
      const contacts = { ...state.contacts }
      for (const c of action.contacts) contacts[c.id] = c
      return { ...state, contacts }
    }
    case 'SET_STAGES':
      return { ...state, stages: action.stages }
    case 'UPSERT_CONTACT':
      return { ...state, contacts: { ...state.contacts, [action.contact.id]: action.contact } }
    case 'REMOVE_CONTACT': {
      const contacts = { ...state.contacts }
      delete contacts[action.id]
      return { ...state, contacts }
    }
    case 'MARK_UNREAD': {
      const unreadIds = new Set(state.unreadIds)
      unreadIds.add(action.id)
      return { ...state, unreadIds }
    }
    case 'CLEAR_UNREAD': {
      const unreadIds = new Set(state.unreadIds)
      unreadIds.delete(action.id)
      return { ...state, unreadIds }
    }
    case 'SET_LOADING':
      return { ...state, loading: action.loading }
    default:
      return state
  }
}

interface PipelineContextValue {
  state: PipelineState
  dispatch: React.Dispatch<Action>
  getContactsByPipelineAndStage: (pipeline: Pipeline, stageId: string) => Contact[]
  getStagesForPipeline: (pipeline: Pipeline) => PipelineStage[]
  refresh: () => void
}

const PipelineContext = createContext<PipelineContextValue | null>(null)

const PIPELINES: Pipeline[] = ['agent_outreach', 'seller_inbound', 'active_deals']

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    contacts: {},
    stages: [],
    loading: true,
    unreadIds: new Set<string>(),
  })

  const load = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', loading: true })
    try {
      const [stages, ...contactArrays] = await Promise.all([
        fetchStages(),
        ...PIPELINES.map(p => fetchContacts(p)),
      ])
      dispatch({ type: 'SET_STAGES', stages })
      for (const contacts of contactArrays) {
        dispatch({ type: 'SET_CONTACTS', contacts })
      }
    } finally {
      dispatch({ type: 'SET_LOADING', loading: false })
    }
  }, [])

  useEffect(() => { load() }, [load])

  const getContactsByPipelineAndStage = useCallback(
    (pipeline: Pipeline, stageId: string) =>
      Object.values(state.contacts).filter(
        c => c.pipeline === pipeline && c.stage_id === stageId && !c.is_dnc
      ),
    [state.contacts]
  )

  const getStagesForPipeline = useCallback(
    (pipeline: Pipeline) =>
      state.stages.filter(s => s.pipeline === pipeline).sort((a, b) => a.position - b.position),
    [state.stages]
  )

  return (
    <PipelineContext.Provider value={{ state, dispatch, getContactsByPipelineAndStage, getStagesForPipeline, refresh: load }}>
      {children}
    </PipelineContext.Provider>
  )
}

export function usePipeline() {
  const ctx = useContext(PipelineContext)
  if (!ctx) throw new Error('usePipeline must be used inside PipelineProvider')
  return ctx
}
