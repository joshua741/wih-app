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
  immediate_goal: string | null
  long_term_goal: string | null
  goal_owner: 'josh' | 'angel' | null
  goal_status: string
  created_at: string
  updated_at: string
}

export interface NoteFolder {
  id: string
  contact_id: string
  name: string
  created_at: string
}

export interface Note {
  id: string
  contact_id: string
  folder_id: string | null
  body: string
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

export interface DirectoryContact {
  id: string
  ghl_contact_id: string | null
  full_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  business_name: string | null
  city: string | null
  state: string | null
  category: string
  categories: string[]
  tags: string[]
  is_junk: boolean
  promoted_to_pipeline: boolean
}

export interface DirectoryContactDetail extends DirectoryContact {
  first_name: string | null
  last_name: string | null
  address: string | null
  postal_code: string | null
  data: Record<string, string>
  pipeline_matches: { id: string; name: string | null; pipeline: string; stage_name: string | null }[]
}

export type FilterOperator =
  | 'is' | 'is_not' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'between'

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value?: string
  value2?: string
}

export interface FilterSpec {
  combinator: 'AND' | 'OR'
  conditions: FilterCondition[]
}

export interface DirectoryListResult {
  contacts: DirectoryContact[]
  total: number
  page: number
  pageSize: number
}

export interface LabelCounts {
  labels: { label: string; n: number }[]
  total_active: number
  junk: number
}
