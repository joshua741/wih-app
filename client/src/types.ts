export type Pipeline = 'agent_outreach' | 'seller_inbound' | 'active_deals'
export type Agent = 'josh' | 'angel'
export type DealType = 'cash' | 'creative_finance' | 'wholetail' | 'unknown' | null
export type MessageSender = 'ai' | 'human' | 'contact'

export interface Contact {
  id: string
  phone: string
  name: string | null
  pipeline: Pipeline
  stage_id: string | null
  stage_name: string | null
  stage_color: string | null
  is_dnc: boolean
  human_takeover: boolean
  takeover_by: Agent | null
  ai_active: boolean
  address: string | null
  email: string | null
  city: string | null
  state: string | null
  zip: string | null
  notes: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  contact_id: string
  body: string
  sender: MessageSender
  direction: 'inbound' | 'outbound'
  ai_model: string | null
  created_at: string
}

export interface Deal {
  id: string
  contact_id: string
  stage_id: string | null
  stage_name: string | null
  stage_color: string | null
  assigned_to: Agent | null
  deal_type: DealType
  property_address: string | null
  asking_price: number | null
  arv: number | null
  repair_estimate: number | null
  offer_price: number | null
  motivation_score: number | null
  notes: string | null
  contact_name: string | null
  contact_phone: string | null
  created_at: string
  updated_at: string
}

export interface PipelineStage {
  id: string
  name: string
  pipeline: Pipeline
  color: string
  position: number
}

export interface WSEvent {
  event: string
  payload: Record<string, unknown>
  ts: string
}
