import { persistentAtom } from '@nanostores/persistent'
import { atom } from 'nanostores'

export interface EditorTab {
  id: string
  fileName: string
  main: boolean
}

export const $tabs = persistentAtom<EditorTab[]>('repl:tabs', [
  {
    id: 'main',
    fileName: 'main.ts',
    main: true,
  },
], {
  encode: JSON.stringify,
  decode: JSON.parse,
})

export const $activeTab = atom('main')

export const EPHEMERAL_TAB_ID = '__ephemeral__'
export const $ephemeralTab = atom<{ fileName: string, uri: string } | null>(null)
