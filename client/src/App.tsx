import { useState } from 'react'
import type { Contact, Pipeline } from './types'
import { PipelineProvider } from './context/PipelineContext'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { KanbanBoard } from './components/KanbanBoard'
import { LeadPanel } from './components/LeadPanel'
import { usePipelineWebSocket } from './hooks/usePipelineWebSocket'
import { usePipeline } from './context/PipelineContext'

function Dashboard() {
  const [pipeline, setPipeline] = useState<Pipeline>('agent_outreach')
  const [search, setSearch] = useState('')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const { activeCallId } = usePipelineWebSocket()
  const { dispatch } = usePipeline()

  function handleSelect(contact: Contact) {
    setSelectedContact(contact)
    dispatch({ type: 'CLEAR_UNREAD', id: contact.id })
  }

  function handlePipelineChange(p: Pipeline) {
    setPipeline(p)
    setSelectedContact(null)
    setSearch('')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f0f1a]">
      <Sidebar active={pipeline} onChange={handlePipelineChange} />

      <div className="flex flex-col flex-1 min-w-0">
        <TopBar pipeline={pipeline} search={search} onSearch={setSearch} />
        <div className="flex flex-1 min-h-0">
          <KanbanBoard
            pipeline={pipeline}
            search={search}
            selectedId={selectedContact?.id ?? null}
            onSelect={handleSelect}
          />
          {selectedContact && (
            <LeadPanel
              contact={selectedContact}
              onClose={() => setSelectedContact(null)}
              activeCallId={activeCallId}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function App() {
  return (
    <PipelineProvider>
      <Dashboard />
    </PipelineProvider>
  )
}

export default App
