import { asNonNull, asyncPool, utf8 } from '@fuman/utils'
import { wireTmGrammars } from 'monaco-editor-textmate'
import { editor, languages } from 'monaco-editor/esm/vs/editor/editor.api.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { Registry } from 'monaco-textmate'
import { workerInvoke } from 'mtcute-repl-worker/client'

import { loadWASM } from 'onigasm'
import onigasmWasm from 'onigasm/lib/onigasm.wasm?url'
import TypeScriptWorker from './custom-worker.ts?worker'
import latte from './latte.json'
import mocha from './mocha.json'
import typescriptTM from './typescript.tmLanguage.json'

window.MonacoEnvironment = {
  getWorker: (_, label: string) => {
    if (label === 'editorWorkerService') {
      return new EditorWorker()
    }
    if (label === 'typescript') {
      return new TypeScriptWorker()
    }
    throw new Error(`Unknown worker: ${label}`)
  },
}

let loadingWasm: Promise<void>

const registry = new Registry({
  async getGrammarDefinition() {
    return {
      format: 'json',
      content: typescriptTM,
    }
  },
})

const grammars = new Map()
grammars.set('typescript', 'source.tsx')
grammars.set('javascript', 'source.tsx')
grammars.set('css', 'source.css')

editor.defineTheme('latte', latte as any)
editor.defineTheme('mocha', mocha as any)

const compilerOptions: languages.typescript.CompilerOptions = {
  strict: true,
  target: languages.typescript.ScriptTarget.ESNext,
  module: languages.typescript.ModuleKind.ESNext,
  moduleResolution: languages.typescript.ModuleResolutionKind.NodeJs,
  moduleDetection: 3, // force
  jsx: languages.typescript.JsxEmit.Preserve,
  allowNonTsExtensions: true,
  allowImportingTsExtensions: true,
  noErrorTruncation: true,
}

languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)

export async function setupMonaco() {
  if (!loadingWasm) loadingWasm = loadWASM(onigasmWasm)
  await loadingWasm

  const libs = await workerInvoke('vfs', 'getLibraryNames')
  const extraLibs: {
    content: string
    filePath?: string
  }[] = []

  await asyncPool(libs, async (lib) => {
    const { files } = asNonNull(await workerInvoke('vfs', 'getLibrary', lib))

    for (const file of files) {
      const { path, contents } = file
      if (!path.endsWith('.d.ts') && path !== 'package.json') continue

      extraLibs.push({ content: utf8.decoder.decode(contents), filePath: `file:///node_modules/${lib}/${path}` })
    }
  })

  extraLibs.push({
    content:
      'declare const tg: import("@mtcute/web").TelegramClient;\n'
      + 'declare const Long: typeof import("long").default;\n'
      + 'declare const setMiddlewareOptions: (options: import("@mtcute/web").networkMiddlewares.BasicMiddlewaresOptions) => Promise<void>;',
    filePath: 'file:///tg.d.ts',
  })

  languages.typescript.typescriptDefaults.setExtraLibs(extraLibs)

  await wireTmGrammars({ languages } as any, registry, grammars)
}
