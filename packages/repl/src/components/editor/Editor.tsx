import { useColorModeValue } from '@kobalte/core'
import { KeyCode, KeyMod, editor as mEditor, Uri } from 'monaco-editor'

import { createEffect, on, onMount } from 'solid-js'
import { $activeTab, $ephemeralTab, $tabs, type EditorTab, EPHEMERAL_TAB_ID } from '../../store/tabs.ts'
import { useStore } from '../../store/use-store.ts'
import { setupMonaco } from './utils/setup.ts'
import './Editor.css'

export interface EditorProps {
  class?: string
  onRun: () => void
}

const DEFAULT_CODE = `
/**
 * This playground comes pre-installed with all @mtcute/* libraries,
 * as well as a pre-configured Telegram client (available as \`tg\` global variable).
 *
 * Exports from this file will become available in the REPL.
 */
export const self = await tg.getMe()
console.log(self)
`.trimStart()

const LOCAL_STORAGE_PREFIX = 'repl:tab-content:'

function findChangedTab(a: EditorTab[], b: EditorTab[]) {
  const set = new Set(a.map(tab => tab.id))
  for (const tab of b) {
    if (!set.has(tab.id)) return tab
  }

  return null
}

function revealPosition(ed: mEditor.IStandaloneCodeEditor, pos: { lineNumber: number, column: number } & Record<string, unknown>) {
  if ('endLineNumber' in pos) {
    ed.setSelection(pos as any)
    ed.revealRangeInCenter(pos as any)
  } else {
    ed.setPosition(pos as any)
    ed.revealPositionInCenter(pos as any)
  }
}

export default function Editor(props: EditorProps) {
  const tabs = useStore($tabs)
  const activeTab = useStore($activeTab)

  let ref!: HTMLDivElement
  let editor: mEditor.IStandaloneCodeEditor | undefined

  const monacoTheme = useColorModeValue('latte', 'mocha')
  const modelsByTab = new Map<string, mEditor.ITextModel>()
  let ephemeralModel: mEditor.ITextModel | null = null

  onMount(async () => {
    editor = mEditor.create(ref, {
      model: null,
      automaticLayout: true,
      minimap: {
        enabled: false,
      },
      scrollbar: {
        verticalScrollbarSize: 8,
      },
      lightbulb: {
        enabled: 'onCode' as any,
      },
      quickSuggestions: {
        other: true,
        comments: true,
        strings: true,
      },
      padding: { top: 8 },
      acceptSuggestionOnCommitCharacter: true,
      acceptSuggestionOnEnter: 'on',
      accessibilitySupport: 'on',
      inlayHints: {
        enabled: 'on',
      },
      lineNumbersMinChars: 3,
      theme: monacoTheme(),
      scrollBeyondLastLine: false,
    })

    await setupMonaco()

    for (const tab of tabs()) {
      const storedCode = localStorage.getItem(LOCAL_STORAGE_PREFIX + tab.id)
      const model = mEditor.createModel(storedCode ?? (tab.main ? DEFAULT_CODE : ''), 'typescript', Uri.parse(`file:///${tab.fileName}`))
      modelsByTab.set(tab.id, model)
    }

    editor.setModel(modelsByTab.get(activeTab())!)

    editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => {
      props.onRun()
    })

    editor.onDidChangeModelContent(() => {
      const currentTab = tabs().find(tab => tab.id === activeTab())!
      const content = editor?.getModel()?.getValue()
      if (!currentTab || !content) return

      localStorage.setItem(LOCAL_STORAGE_PREFIX + currentTab.id, content)
    })

    mEditor.registerEditorOpener({
      openCodeEditor(_source: any, resource: any, selectionOrPosition: any) {
        if (!editor) return false

        // check if it's a playground file
        for (const [tabId, model] of modelsByTab) {
          if (model.uri.toString() === resource.toString()) {
            $activeTab.set(tabId)
            if (selectionOrPosition) revealPosition(editor, selectionOrPosition)
            return true
          }
        }

        // open as ephemeral read-only tab
        const model = mEditor.getModel(resource)
        if (!model) return false

        ephemeralModel = model
        const path = resource.path.replace(/^\/node_modules\//, '')
        $ephemeralTab.set({ fileName: path, uri: resource.toString() })
        $activeTab.set(EPHEMERAL_TAB_ID)

        editor.setModel(model)
        editor.updateOptions({ readOnly: true })
        if (selectionOrPosition) revealPosition(editor, selectionOrPosition)

        return true
      },
    })

    return () => editor?.dispose()
  })

  createEffect(on(() => monacoTheme(), (theme) => {
    if (!editor) return
    editor.updateOptions({ theme })
  }))

  createEffect(on(activeTab, (tabId) => {
    if (!editor) return

    if (tabId === EPHEMERAL_TAB_ID) {
      if (ephemeralModel) {
        editor.setModel(ephemeralModel)
        editor.updateOptions({ readOnly: true })
      }
      return
    }

    const model = modelsByTab.get(tabId)
    if (!model) return
    editor.setModel(model)
    editor.updateOptions({ readOnly: false })
  }))

  createEffect(on(tabs, (tabs, prevTabs) => {
    if (!editor || !prevTabs) return
    if (tabs.length === prevTabs.length) {
      // verify filenames
      for (const tab of tabs) {
        const oldName = prevTabs.find(prevTab => prevTab.id === tab.id)?.fileName
        if (!oldName) continue // weird flex but ok
        if (oldName === tab.fileName) continue

        // renamed
        const oldModel = modelsByTab.get(tab.id)
        if (!oldModel) continue
        const newModel = mEditor.createModel(oldModel.getValue(), 'typescript', Uri.parse(`file:///${tab.fileName}`))
        modelsByTab.set(tab.id, newModel)
        if (editor.getModel() === oldModel) {
          editor.setModel(newModel)
        }
        oldModel.dispose()
      }

      return
    }

    if (tabs.length > prevTabs.length) {
      // a tab was created
      const changed = findChangedTab(prevTabs, tabs)
      if (!changed) return
      const model = mEditor.createModel('', 'typescript', Uri.parse(`file:///${changed.fileName}`))
      modelsByTab.set(changed.id, model)
      editor.setModel(model)
    } else {
      // a tab was deleted
      const changed = findChangedTab(tabs, prevTabs)
      if (!changed) return
      modelsByTab.get(changed.id)?.dispose()
      modelsByTab.delete(changed.id)
      localStorage.removeItem(LOCAL_STORAGE_PREFIX + changed.id)
    }
  }))

  return (
    <div
      data-monaco-root
      class={props.class}
      ref={ref}
    />
  )
}
