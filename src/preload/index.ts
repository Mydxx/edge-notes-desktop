import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/api'
import type {
  AttachmentFile,
  DataDirInfo,
  EdgeNotesApi,
  EdgeNotesState,
  LoginItemState,
  MigrationResult,
  NotesIndexState,
  NoteSnapshot,
  NoteStatus,
  NoteSwitchResult,
  TrashResult
} from '../shared/api'

/** 渲染进程唯一可用的能力面：受限 IPC，不暴露 Node.js 或任意系统 API */
const api: EdgeNotesApi = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<EdgeNotesState>,
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, value) as Promise<EdgeNotesState>,
  setPinnedOpen: (value: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setPinnedOpen, value) as Promise<EdgeNotesState>,
  setSide: (side) => ipcRenderer.invoke(IPC_CHANNELS.setSide, side) as Promise<EdgeNotesState>,
  setWidth: (width: number) => ipcRenderer.invoke(IPC_CHANNELS.setWidth, width) as Promise<EdgeNotesState>,
  setCollapseDelay: (delay) => ipcRenderer.invoke(IPC_CHANNELS.setCollapseDelay, delay) as Promise<EdgeNotesState>,
  setResizing: (value: boolean) => {
    ipcRenderer.send(IPC_CHANNELS.setResizing, value)
  },
  setHidden: (hidden: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setHidden, hidden) as Promise<EdgeNotesState>,
  setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, theme) as Promise<EdgeNotesState>,
  setFontSize: (scale) => ipcRenderer.invoke(IPC_CHANNELS.setFontSize, scale) as Promise<EdgeNotesState>,
  setViewMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setViewMode, mode) as Promise<EdgeNotesState>,
  setNavCollapsed: (value: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setNavCollapsed, value) as Promise<EdgeNotesState>,

  listNotes: () => ipcRenderer.invoke(IPC_CHANNELS.notesList) as Promise<NotesIndexState>,
  createNote: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.notesCreate, title) as Promise<NoteSwitchResult>,
  switchNote: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.notesSwitch, id) as Promise<NoteSwitchResult>,
  renameNote: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.notesRename, id, title) as Promise<NotesIndexState>,
  deleteNote: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.notesDelete, id) as Promise<NoteSwitchResult>,
  reorderNotes: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.notesReorder, ids) as Promise<NotesIndexState>,
  setNoteViewState: (id: string, patch) => {
    ipcRenderer.send(IPC_CHANNELS.notesViewState, id, patch)
  },
  getReferencedAttachments: () =>
    ipcRenderer.invoke(IPC_CHANNELS.referencedAttachments) as Promise<string[]>,
  onNotesIndexChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, index: NotesIndexState): void => {
      listener(index)
    }
    ipcRenderer.on(IPC_CHANNELS.notesIndexChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.notesIndexChanged, handler)
    }
  },
  getLoginItemState: () => ipcRenderer.invoke(IPC_CHANNELS.getLoginItem) as Promise<LoginItemState>,
  setLaunchAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setLaunchAtLogin, enabled) as Promise<EdgeNotesState>,
  getDataDir: () => ipcRenderer.invoke(IPC_CHANNELS.getDataDir) as Promise<DataDirInfo>,
  pickDataDir: () => ipcRenderer.invoke(IPC_CHANNELS.pickDataDir) as Promise<string | null>,
  setDataDir: (dir: string) => ipcRenderer.invoke(IPC_CHANNELS.setDataDir, dir) as Promise<MigrationResult>,
  relaunch: () => ipcRenderer.invoke(IPC_CHANNELS.relaunch) as Promise<void>,
  quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit) as Promise<void>,

  getNote: () => ipcRenderer.invoke(IPC_CHANNELS.noteGet) as Promise<NoteSnapshot>,
  updateNote: (content: string) => {
    ipcRenderer.send(IPC_CHANNELS.noteUpdate, content)
  },
  saveNoteNow: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.noteSaveNow, content) as Promise<NoteStatus>,
  retrySave: () => ipcRenderer.invoke(IPC_CHANNELS.noteRetry) as Promise<NoteStatus>,
  saveAttachment: (bytes: Uint8Array, mime: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveAttachment, bytes, mime) as Promise<{ relative: string; bytes: number }>,
  checkAttachments: (paths: string[]) => ipcRenderer.invoke(IPC_CHANNELS.checkAttachments, paths) as Promise<string[]>,
  listAttachments: () => ipcRenderer.invoke(IPC_CHANNELS.listAttachments) as Promise<AttachmentFile[]>,
  trashAttachments: (relatives: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.trashAttachments, relatives) as Promise<TrashResult>,
  getAttachmentsInfo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.attachmentsInfo) as Promise<{ dir: string; count: number; bytes: number }>,
  openAttachmentsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openAttachmentsFolder) as Promise<void>,
  revealAttachment: (relative: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.revealAttachment, relative) as Promise<void>,
  openImageViewer: (relative: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openImageViewer, relative) as Promise<boolean>,
  isImageViewerOpen: () => ipcRenderer.invoke(IPC_CHANNELS.imageViewerOpen) as Promise<boolean>,
  closeImageViewer: () => ipcRenderer.invoke(IPC_CHANNELS.closeImageViewer) as Promise<void>,
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
  },

  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC_CHANNELS.openSettings, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.openSettings, handler)
    }
  }
}

contextBridge.exposeInMainWorld('edgeNotes', api)
