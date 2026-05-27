import axios from 'axios'
import type { Contact, Message, Deal, PipelineStage, Pipeline, Agent } from './types'

const api = axios.create({ baseURL: '/api' })

export async function fetchContacts(pipeline: Pipeline): Promise<Contact[]> {
  const res = await api.get('/contacts', { params: { pipeline, limit: 500 } })
  return res.data.contacts
}

export async function fetchContact(id: string): Promise<Contact> {
  const res = await api.get(`/contacts/${id}`)
  return res.data
}

export async function fetchMessages(contactId: string): Promise<Message[]> {
  const res = await api.get(`/contacts/${contactId}/messages`)
  return res.data.messages
}

export async function sendMessage(contactId: string, body: string): Promise<Message> {
  const res = await api.post(`/contacts/${contactId}/messages`, { body, sender: 'human' })
  return res.data
}

export async function patchContact(id: string, data: Partial<Contact>): Promise<Contact> {
  const res = await api.patch(`/contacts/${id}`, data)
  return res.data
}

export async function markDNC(id: string, reason?: string): Promise<void> {
  await api.post(`/contacts/${id}/dnc`, { reason })
}

export async function initiateCall(contactPhone: string, agent: Agent): Promise<{ callSid: string }> {
  const res = await api.post('/call/initiate', { contactPhone, agent })
  return res.data
}

export async function fetchStages(): Promise<PipelineStage[]> {
  const res = await api.get('/pipeline/stages')
  return res.data.stages
}

export async function moveStage(contactId: string, stageId: string): Promise<void> {
  await api.patch('/pipeline/move', { contactId, stageId })
}

export async function fetchDeals(params?: { stage_id?: string; assigned_to?: Agent }): Promise<Deal[]> {
  const res = await api.get('/deals', { params })
  return res.data.deals
}
