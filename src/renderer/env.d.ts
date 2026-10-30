/// <reference types="vite/client" />

import type { EdgeNotesApi } from '../shared/api'

declare global {
  interface Window {
    edgeNotes: EdgeNotesApi
  }
}

export {}
