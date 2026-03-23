import { asNonNull, asyncPool, utf8 } from '@fuman/utils'
import { wireTmGrammars } from 'monaco-editor-textmate'
import { editor, languages } from 'monaco-editor/esm/vs/editor/editor.api.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import {
  getTypeScriptWorker,
  javascriptDefaults,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults,
} from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js'
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

const compilerOptions = {
  strict: true,
  target: ScriptTarget.ESNext,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.NodeJs,
  moduleDetection: 3, // force
  jsx: JsxEmit.Preserve,
  allowNonTsExtensions: true,
  allowImportingTsExtensions: true,
  noErrorTruncation: true,
}

typescriptDefaults.setCompilerOptions(compilerOptions)
javascriptDefaults.setCompilerOptions(compilerOptions)

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

  typescriptDefaults.setExtraLibs(extraLibs)

  registerImportCompletions(libs)
  registerAutoImportProvider()

  await wireTmGrammars({ languages } as any, registry, grammars)
}

function registerAutoImportProvider() {
  languages.registerCompletionItemProvider('typescript', {
    async provideCompletionItems(model, position) {
      const workerFactory = await getTypeScriptWorker()
      const worker = await workerFactory(model.uri)
      const offset = model.getOffsetAt(position)
      const info = await worker.getAutoImportCompletions(model.uri.toString(), offset)
      if (!info) return

      const wordInfo = model.getWordUntilPosition(position)
      const wordRange = {
        startLineNumber: position.lineNumber,
        startColumn: wordInfo.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: wordInfo.endColumn,
      }

      // dedupe by name+kind, preferring @mtcute/web > @mtcute/core > rest
      const bestByKey = new Map<string, any>()
      for (const entry of info.entries) {
        const src = entry.source ?? ''
        if (!isAllowedAutoImportPackage(src)) continue

        const key = `${entry.name}\0${entry.kind}`
        const existing = bestByKey.get(key)
        if (existing && autoImportSourcePriority(existing.source) <= autoImportSourcePriority(src)) continue
        bestByKey.set(key, entry)
      }

      const importState = parseImports(model)

      const suggestions: languages.CompletionItem[] = []
      for (const entry of bestByKey.values()) {
        let range = wordRange
        if (entry.replacementSpan) {
          const p1 = model.getPositionAt(entry.replacementSpan.start)
          const p2 = model.getPositionAt(entry.replacementSpan.start + entry.replacementSpan.length)
          range = {
            startLineNumber: p1.lineNumber,
            startColumn: p1.column,
            endLineNumber: p2.lineNumber,
            endColumn: p2.column,
          }
        }

        const sourceText = entry.sourceDisplay
          ? entry.sourceDisplay.map((p: any) => p.text).join('')
          : entry.source

        suggestions.push({
          label: { label: entry.name, description: sourceText },
          insertText: entry.name,
          sortText: entry.sortText,
          kind: convertTsKind(entry.kind),
          range,
          additionalTextEdits: [buildImportEdit(importState, entry.name, entry.source)],
        } as any)
      }

      return { suggestions }
    },
  })
}

interface ParsedImport {
  module: string
  startLine: number
  endLine: number
  names: string[]
  fullText: string
}

interface ImportState {
  imports: ParsedImport[]
  insertLine: number
}

function parseImports(model: editor.ITextModel): ImportState {
  const imports: ParsedImport[] = []
  let insertLine = 1
  let i = 1
  while (i <= model.getLineCount()) {
    const line = model.getLineContent(i)

    // skip blank lines and comments
    if (line.trim() === '' || /^\s*\/\//u.test(line)) {
      i++
      continue
    }

    if (!/^\s*import\s/u.test(line)) break

    // collect the full import statement (may span multiple lines)
    const startLine = i
    let full = ''
    while (i <= model.getLineCount()) {
      full += `${model.getLineContent(i)}\n`
      if (/['"][^'"]*['"]/u.test(model.getLineContent(i))) break
      i++
    }
    const endLine = i
    i++
    insertLine = endLine + 1

    // extract module specifier
    const modMatch = full.match(/from\s+['"]([^'"]+)['"]/u)
      ?? full.match(/import\s+['"]([^'"]+)['"]/u)
    if (!modMatch) continue

    // extract named imports
    const names: string[] = []
    const braceMatch = full.match(/\{([^}]*)\}/u)
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/u).pop()?.trim()
        if (name) names.push(name)
      }
    }

    imports.push({
      module: modMatch[1],
      startLine,
      endLine,
      names,
      fullText: full.trimEnd(),
    })
  }

  return { imports, insertLine }
}

function buildImportEdit(state: ImportState, name: string, module: string): languages.TextEdit {
  const existing = state.imports.find(imp => imp.module === module)

  if (existing) {
    // add to existing import — rebuild the named imports
    const allNames = [...existing.names, name]
    const newImport = `import { ${allNames.join(', ')} } from "${module}"`
    return {
      range: {
        startLineNumber: existing.startLine,
        startColumn: 1,
        endLineNumber: existing.endLine,
        endColumn: existing.fullText.split('\n').pop()!.length + 1,
      },
      text: newImport,
    }
  }

  // insert new import line
  return {
    range: {
      startLineNumber: state.insertLine,
      startColumn: 1,
      endLineNumber: state.insertLine,
      endColumn: 1,
    },
    text: `import { ${name} } from "${module}"\n`,
  }
}

function isAllowedAutoImportPackage(pkg: string): boolean {
  return pkg.startsWith('@fuman/') || pkg.startsWith('@mtcute/') || pkg === 'long'
}

function autoImportSourcePriority(source: string): number {
  if (source === '@mtcute/web') return 0
  if (source === '@mtcute/core') return 1
  return 2
}

function convertTsKind(kind: string): languages.CompletionItemKind {
  switch (kind) {
    case 'primitive type':
    case 'keyword':
      return languages.CompletionItemKind.Keyword
    case 'var':
    case 'local var':
      return languages.CompletionItemKind.Variable
    case 'property':
    case 'getter':
    case 'setter':
      return languages.CompletionItemKind.Field
    case 'function':
    case 'method':
    case 'construct':
    case 'call':
    case 'index':
      return languages.CompletionItemKind.Function
    case 'enum':
      return languages.CompletionItemKind.Enum
    case 'enum member':
      return languages.CompletionItemKind.EnumMember
    case 'module':
      return languages.CompletionItemKind.Module
    case 'class':
      return languages.CompletionItemKind.Class
    case 'interface':
    case 'type':
      return languages.CompletionItemKind.Interface
    default:
      return languages.CompletionItemKind.Property
  }
}

function registerImportCompletions(packageNames: string[]) {
  languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ['"', "'", '/'],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber)
      const textUntilPosition = line.substring(0, position.column - 1)

      // eslint-disable-next-line regexp/no-super-linear-backtracking
      const importMatch = textUntilPosition.match(/(?:from|import\s*\(?)\s*(['"])([^'"]*)$/)
      if (!importMatch) return

      const quoteChar = importMatch[1]
      const typed = importMatch[2] ?? ''

      const stringStart = textUntilPosition.lastIndexOf(quoteChar)
      const startCol = stringStart + 2 // 1-indexed, after opening quote
      const afterCursor = line.substring(position.column - 1)
      const closingIdx = afterCursor.indexOf(quoteChar)
      const endCol = closingIdx >= 0 ? position.column + closingIdx : position.column

      const range = {
        startLineNumber: position.lineNumber,
        startColumn: startCol,
        endLineNumber: position.lineNumber,
        endColumn: endCol,
      }

      const suggestions: languages.CompletionItem[] = []

      // package completions
      for (const pkg of packageNames) {
        if (!pkg.startsWith(typed)) continue
        if (!isAllowedAutoImportPackage(pkg)) continue
        suggestions.push({
          label: pkg,
          kind: languages.CompletionItemKind.Module,
          insertText: pkg,
          range,
        })
      }

      // relative path completions for other playground files
      const currentUri = model.uri.toString()
      for (const m of editor.getModels()) {
        if (m.uri.toString() === currentUri) continue
        if (m.uri.scheme !== 'file' || m.uri.path.includes('node_modules')) continue
        const name = m.uri.path.replace(/^\//, '')
        const rel = `./${name}`
        if (!rel.startsWith(typed)) continue
        suggestions.push({
          label: rel,
          kind: languages.CompletionItemKind.File,
          insertText: rel,
          range,
        })
      }

      return { suggestions }
    },
  })
}
