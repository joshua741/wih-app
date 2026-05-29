import { useState, useEffect, useRef } from 'react'
import type { Note, NoteFolder } from '../types'
import {
  fetchNotes, createNote, updateNote, deleteNote,
  createNoteFolder, deleteNoteFolder,
} from '../api'

interface Props {
  contactId: string
}

function noteTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const ALL = '__all__'
const UNFILED = '__unfiled__'

export function NotesTab({ contactId }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [loading, setLoading] = useState(true)

  // active folder filter: ALL, UNFILED, or a folder id
  const [activeFolder, setActiveFolder] = useState<string>(ALL)

  // compose
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  // new folder
  const [folderInput, setFolderInput] = useState<string | null>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // per-note edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setActiveFolder(ALL)
    fetchNotes(contactId)
      .then(({ notes, folders }) => { setNotes(notes); setFolders(folders) })
      .finally(() => setLoading(false))
  }, [contactId])

  useEffect(() => {
    if (folderInput !== null) folderInputRef.current?.focus()
  }, [folderInput])

  // the folder a brand-new note lands in, based on the current filter
  const targetFolderId = activeFolder === ALL || activeFolder === UNFILED ? null : activeFolder

  const visibleNotes = notes.filter(n => {
    if (activeFolder === ALL) return true
    if (activeFolder === UNFILED) return n.folder_id == null
    return n.folder_id === activeFolder
  })

  const folderName = (id: string | null) => folders.find(f => f.id === id)?.name ?? null

  async function handleAdd() {
    const body = draft.trim()
    if (!body || adding) return
    setAdding(true)
    try {
      const note = await createNote(contactId, body, targetFolderId)
      setNotes(prev => [note, ...prev])
      setDraft('')
    } finally {
      setAdding(false)
    }
  }

  async function handleAddFolder() {
    const name = (folderInput ?? '').trim()
    if (!name) { setFolderInput(null); return }
    const folder = await createNoteFolder(contactId, name)
    setFolders(prev => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)))
    setFolderInput(null)
    setActiveFolder(folder.id)
  }

  async function handleDeleteFolder(id: string) {
    await deleteNoteFolder(id)
    setFolders(prev => prev.filter(f => f.id !== id))
    // notes that were in this folder become unfiled
    setNotes(prev => prev.map(n => n.folder_id === id ? { ...n, folder_id: null } : n))
    if (activeFolder === id) setActiveFolder(ALL)
  }

  async function handleSaveEdit(id: string) {
    const body = editDraft.trim()
    if (!body) return
    const updated = await updateNote(id, { body })
    setNotes(prev => prev.map(n => n.id === id ? updated : n))
    setEditingId(null)
  }

  async function handleMove(id: string, folderId: string | null) {
    const updated = await updateNote(id, { folder_id: folderId })
    setNotes(prev => prev.map(n => n.id === id ? updated : n))
  }

  async function handleDelete(id: string) {
    await deleteNote(id)
    setNotes(prev => prev.filter(n => n.id !== id))
    setConfirmDeleteId(null)
  }

  const isEmpty = !loading && notes.length === 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Folder bar */}
      <div className="px-4 pt-3 pb-2 border-b border-white/10 shrink-0">
        <div className="flex flex-wrap gap-1.5 items-center">
          <FolderPill label="All" active={activeFolder === ALL} onClick={() => setActiveFolder(ALL)} />
          <FolderPill label="Unfiled" active={activeFolder === UNFILED} onClick={() => setActiveFolder(UNFILED)} />
          {folders.map(f => (
            <FolderPill
              key={f.id}
              label={f.name}
              active={activeFolder === f.id}
              onClick={() => setActiveFolder(f.id)}
              onDelete={() => handleDeleteFolder(f.id)}
            />
          ))}
          {folderInput === null ? (
            <button
              onClick={() => setFolderInput('')}
              className="px-2 py-1 rounded-full text-xs text-slate-400 border border-dashed border-white/15 hover:border-purple-500/50 hover:text-purple-300 transition-colors"
            >
              + Folder
            </button>
          ) : (
            <input
              ref={folderInputRef}
              value={folderInput}
              onChange={e => setFolderInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddFolder()
                if (e.key === 'Escape') setFolderInput(null)
              }}
              onBlur={handleAddFolder}
              placeholder="Folder name"
              className="px-2 py-1 rounded-full text-xs bg-white/5 border border-purple-500/50 text-slate-200 placeholder-slate-600 outline-none w-28"
            />
          )}
        </div>
      </div>

      {/* Scroll-log of notes */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2 min-h-0">
        {loading ? (
          <div className="text-xs text-slate-600 text-center py-4">Loading notes…</div>
        ) : visibleNotes.length === 0 ? (
          <div className="text-xs text-slate-700 text-center py-6">
            {isEmpty ? 'No notes yet — write your first one below.' : 'No notes in this folder.'}
          </div>
        ) : (
          visibleNotes.map(note => (
            <div key={note.id} className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 group">
              {editingId === note.id ? (
                <>
                  <textarea
                    value={editDraft}
                    onChange={e => setEditDraft(e.target.value)}
                    rows={3}
                    className="w-full bg-white/5 border border-purple-500/40 rounded-md px-2 py-1.5 text-sm text-slate-200 outline-none resize-none"
                  />
                  <div className="flex gap-2 mt-1.5">
                    <button onClick={() => handleSaveEdit(note.id)} className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-md">Save</button>
                    <button onClick={() => setEditingId(null)} className="px-2.5 py-1 bg-white/5 text-slate-400 text-xs rounded-md">Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">{note.body}</p>
                  <div className="flex items-center justify-between mt-1.5 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-slate-600">{noteTime(note.created_at)}</span>
                      {note.updated_at !== note.created_at && (
                        <span className="text-xs text-slate-700 italic">edited</span>
                      )}
                      {folderName(note.folder_id) && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/20 truncate">
                          {folderName(note.folder_id)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <select
                        value={note.folder_id ?? ''}
                        onChange={e => handleMove(note.id, e.target.value || null)}
                        title="Move to folder"
                        className="bg-white/5 border border-white/10 rounded px-1 py-0.5 text-xs text-slate-400 outline-none max-w-[90px]"
                      >
                        <option value="">No folder</option>
                        {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                      <button
                        onClick={() => { setEditingId(note.id); setEditDraft(note.body) }}
                        className="text-slate-500 hover:text-slate-300 text-xs px-1"
                        title="Edit"
                      >✎</button>
                      {confirmDeleteId === note.id ? (
                        <button onClick={() => handleDelete(note.id)} className="text-red-400 hover:text-red-300 text-xs px-1" title="Confirm delete">✓</button>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(note.id)} className="text-slate-500 hover:text-red-400 text-xs px-1" title="Delete">🗑</button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Compose — expands to ~half the panel when there are no notes yet */}
      <div className={`px-4 py-3 border-t border-white/10 shrink-0 flex flex-col gap-2 ${isEmpty ? 'h-1/2' : ''}`}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleAdd() } }}
          placeholder={targetFolderId ? `New note in “${folderName(targetFolderId)}”… (⌘/Ctrl+Enter)` : 'Write a note… (⌘/Ctrl+Enter)'}
          className={`w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-purple-500/50 resize-none transition-colors ${isEmpty ? 'flex-1' : 'h-20'}`}
        />
        <button
          onClick={handleAdd}
          disabled={adding || !draft.trim()}
          className="w-full py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          {adding ? 'Adding…' : 'Add Note'}
        </button>
      </div>
    </div>
  )
}

function FolderPill({ label, active, onClick, onDelete }: {
  label: string
  active: boolean
  onClick: () => void
  onDelete?: () => void
}) {
  return (
    <span
      onClick={onClick}
      className={`group/pill inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs cursor-pointer transition-colors border ${
        active
          ? 'bg-purple-600/30 text-purple-200 border-purple-500/40'
          : 'bg-white/5 text-slate-400 border-white/10 hover:text-slate-200'
      }`}
    >
      <span className="truncate max-w-[120px]">{label}</span>
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="text-slate-500 hover:text-red-400 opacity-0 group-hover/pill:opacity-100 transition-opacity"
          title="Delete folder"
        >×</button>
      )}
    </span>
  )
}
