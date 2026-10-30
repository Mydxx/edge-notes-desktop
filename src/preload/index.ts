import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/api'
import type { EdgeNotesApi, EdgeNotesState, NoteSnapshot, NoteStatus } from '../shared/api'

/** 渲染进程唯一可用的能力面：受限 IPC，不暴露 Node.js 或任意系统 API */
const api: EdgeNotesApi = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<EdgeNotesState>,
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, value) as Promise<EdgeNotesState>,
  setPinnedOpen: (value: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setPinnedOpen, value) as Promise<EdgeNotesState>,
  setSide: (side) => ipcRenderer.invoke(IPC_CHANNELS.setSide, side) as Promise<EdgeNotesState>,
  setWidth: (width: number) => ipcRenderer.invoke(IPC_CHANNELS.setWidth, width) as Promise<EdgeNotesState>,
  setResizing: (value: boolean) => {
    ipcRenderer.send(IPC_CHANNELS.setResizing, value)
  },
  quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit) as Promise<void>,

  getNote: () => ipcRenderer.invoke(IPC_CHANNELS.noteGet) as Promise<NoteSnapshot>,
  updateNote: (content: string) => {
    ipcRenderer.send(IPC_CHANNELS.noteUpdate, content)
  },
  saveNoteNow: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.noteSaveNow, content) as Promise<NoteStatus>,
  retrySave: () => ipcRenderer.invoke(IPC_CHANNELS.noteRetry) as Promise<NoteStatus>,
  setEditorFocused: (focused: boolean) => {
    ipcRenderer.send(IPC_CHANNELS.editorFocus, focused)
  },

  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: EdgeNotesState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC_CHANNELS.stateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, handler)
    }
  },

  onNoteStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: NoteStatus): void => {
      listener(status)
    }
    ipcRenderer.on(IPC_CHANNELS.noteStatus, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.noteStatus, handler)
    }
  }
}

contextBridge.exposeInMainWorld('edgeNotes', api)
