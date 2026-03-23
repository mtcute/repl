import type { Diagnostic, ExportDeclaration, ModifierLike, VariableStatement } from 'typescript'
import { initialize, ts, TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/ts.worker'
import { blankSourceFile } from 'ts-blank-space'

class CustomTypeScriptWorker extends TypeScriptWorker {
  constructor(ctx: any, createData: any) {
    super(ctx, createData)
    ;(this as any)._extraLibs = this._normalizeExtraLibs((this as any)._extraLibs ?? {})
    ;(this as any)._languageService = this._wrapLanguageService((this as any)._languageService)
  }

  private _decodePath(path: string): string {
    try {
      return decodeURIComponent(path)
    } catch {
      return path
    }
  }

  private _normalizeExtraLibs(extraLibs: Record<string, any>): Record<string, any> {
    const normalized = Object.create(null)

    for (const [fileName, value] of Object.entries(extraLibs)) {
      normalized[this._decodePath(fileName)] = value
    }

    return normalized
  }

  private _wrapLanguageService(languageService: any): any {
    const normalizeFirstArg = new Set([
      'getSyntacticDiagnostics',
      'getSemanticDiagnostics',
      'getSuggestionDiagnostics',
      'getCompletionsAtPosition',
      'getCompletionEntryDetails',
      'getSignatureHelpItems',
      'getQuickInfoAtPosition',
      'getDocumentHighlights',
      'getDefinitionAtPosition',
      'getReferencesAtPosition',
      'getNavigationTree',
      'getFormattingEditsForDocument',
      'getFormattingEditsForRange',
      'getFormattingEditsAfterKeystroke',
      'findRenameLocations',
      'getRenameInfo',
      'getEmitOutput',
      'getCodeFixesAtPosition',
      'provideInlayHints',
    ])

    return new Proxy(languageService, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value

        return (...args: any[]) => {
          if (normalizeFirstArg.has(String(prop)) && typeof args[0] === 'string') {
            args[0] = this._normalizePath(args[0])
          }

          if (prop === 'getDocumentHighlights' && Array.isArray(args[2])) {
            args[2] = args[2].map((it: any) => typeof it === 'string' ? this._normalizePath(it) : it)
          }

          return value.apply(target, args)
        }
      },
    })
  }

  // extra libs keep raw `@`, while Monaco serializes scoped package URIs as `%40`.
  // keep extra libs raw for TS module specifiers, and normalize Monaco lookups back to that form.
  private _normalizePath(path: string): string {
    const decoded = this._decodePath(path)
    return this._resolveExtraLib(decoded) ? decoded : path
  }

  private _resolveText(path: string): string | undefined {
    return (this as any)._getScriptText(path)
      ?? (this as any)._getScriptText(this._decodePath(path))
  }

  private _resolveExtraLib(path: string): any {
    const libs = (this as any)._extraLibs ?? {}
    return libs[path] ?? libs[this._decodePath(path)]
  }

  getScriptFileNames(): string[] {
    const extraLibKeys: string[] = Object.keys((this as any)._extraLibs ?? {})
    const extraLibSet = new Set(extraLibKeys)

    const allModels = (this as any)._ctx.getMirrorModels().map((m: any) => m.uri)
    const models: string[] = allModels
      .filter((uri: any) => !uri.path?.startsWith('/lib.'))
      .map((uri: any) => uri.toString())
      .filter((fileName: string) => !extraLibSet.has(this._normalizePath(fileName)))

    return [...models, ...extraLibKeys]
  }

  getScriptVersion(fileName: string): string {
    fileName = this._normalizePath(fileName)
    const model = (this as any)._getModel(fileName)
    if (model) return model.version.toString()
    if (this.isDefaultLibFileName(fileName)) return '1'
    const lib = this._resolveExtraLib(fileName)
    if (lib) return String(lib.version)
    return ''
  }

  getScriptSnapshot(fileName: string): any {
    fileName = this._normalizePath(fileName)
    const text = this._resolveText(fileName)
    if (text === undefined) return undefined
    return {
      getText: (start: number, end: number) => text.substring(start, end),
      getLength: () => text.length,
      getChangeRange: () => undefined,
    }
  }

  fileExists(path: string): boolean {
    path = this._normalizePath(path)
    return this._resolveText(path) !== undefined
  }

  readFile(path: string): string | undefined {
    path = this._normalizePath(path)
    return this._resolveText(path)
  }

  // follow through import declarations in .d.ts files to the actual definition
  async getDeepDefinition(fileName: string, position: number) {
    fileName = this._normalizePath(fileName)
    try {
      const ls = this.getLanguageService()
      let results = ls.getDefinitionAtPosition(fileName, position)

      // follow through up to 5 levels of re-exports
      for (let depth = 0; results?.length && depth < 5; depth++) {
        const sameFile = results.every((r: any) => r.fileName === fileName)
        if (!sameFile) break

        let found = false
        for (const result of results) {
          const deeper = ls.getDefinitionAtPosition(result.fileName, result.textSpan.start)
          if (deeper?.some((d: any) => d.fileName !== fileName)) {
            results = deeper
            found = true
            break
          }
        }
        if (!found) break
      }

      if (!results?.length) return null

      return results.map((r: any) => {
        const sf = ls.getProgram()?.getSourceFile(r.fileName)
        if (!sf) return null
        const start = sf.getLineAndCharacterOfPosition(r.textSpan.start)
        const end = sf.getLineAndCharacterOfPosition(r.textSpan.start + r.textSpan.length)
        return {
          fileName: r.fileName,
          startLine: start.line + 1,
          startCol: start.character + 1,
          endLine: end.line + 1,
          endCol: end.character + 1,
        }
      }).filter(Boolean)
    } catch {
      return null
    }
  }

  // built-in SuggestAdapter uses this, local completions only
  async getCompletionsAtPosition(fileName: string, position: number) {
    fileName = this._normalizePath(fileName)
    return this.getLanguageService().getCompletionsAtPosition(fileName, position, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForImportStatements: true,
    })
  }

  // custom provider uses these for auto-import completions
  async getAutoImportCompletions(fileName: string, position: number) {
    fileName = this._normalizePath(fileName)
    const result = this.getLanguageService().getCompletionsAtPosition(fileName, position, {
      includeCompletionsForModuleExports: true,
      includeCompletionsWithInsertText: true,
      includeCompletionsForImportStatements: true,
    })
    if (!result) return undefined
    return {
      ...result,
      entries: result.entries.filter((e: any) => e.source),
    }
  }

  async getAutoImportDetails(fileName: string, position: number, name: string, source: string, data: any) {
    fileName = this._normalizePath(fileName)
    return this.getLanguageService().getCompletionEntryDetails(
      fileName,
      position,
      name,
      undefined,
      source,
      { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
      data,
    )
  }

  async processFile(uri: string, withExports?: boolean) {
    uri = this._normalizePath(uri)
    const sourceFile = this.getLanguageService().getProgram()?.getSourceFile(uri)
    if (!sourceFile) throw new Error(`File not found: ${uri}`)

    const transformed = blankSourceFile(sourceFile)
    const exports: string[] = []
    if (withExports) {
      for (const statement of sourceFile.statements) {
        if (statement.kind === ts.typescript.SyntaxKind.ExportDeclaration) {
          const exportDeclaration = statement as ExportDeclaration
          const clause = exportDeclaration.exportClause
          if (!clause || clause.kind !== ts.typescript.SyntaxKind.NamedExports) {
            throw new Error('Invalid export declaration (export * is not supported)')
          }

          for (const element of clause.elements) {
            if (element.kind === ts.typescript.SyntaxKind.ExportSpecifier) {
              exports.push(element.name.getText())
            }
          }
        } else if (
          statement.kind === ts.typescript.SyntaxKind.VariableStatement
          && statement.modifiers?.some((it: ModifierLike) => it.kind === ts.typescript.SyntaxKind.ExportKeyword)) {
          for (const declaration of (statement as VariableStatement).declarationList.declarations) {
            exports.push(declaration.name.getText())
          }
        }
      }
    }

    return {
      transformed,
      exports,
    }
  }

  async getSyntacticDiagnostics(fileName: string): Promise<Diagnostic[]> {
    const parent = await super.getSyntacticDiagnostics(fileName)

    fileName = this._normalizePath(fileName)
    const sourceFile = this.getLanguageService().getProgram()?.getSourceFile(fileName)
    if (!sourceFile) return parent

    // there's probably a better way but ts-blank-space's own playground does this,
    // and ts-blank-space is fast enough for this to not really matter (it basically just traverses the AST once)
    blankSourceFile(sourceFile, (errorNode) => {
      parent.push({
        start: errorNode.getStart(),
        length: errorNode.getWidth(),
        messageText: `[ts-blank-space] Unsupported syntax: ${errorNode.getText()}`,
        category: ts.typescript.DiagnosticCategory.Error,
        code: 9999,
      })
    })
    return parent
  }

  async updateExtraLibs(extraLibs: Record<string, any>) {
    return super.updateExtraLibs(this._normalizeExtraLibs(extraLibs))
  }
}

export type { CustomTypeScriptWorker }

// eslint-disable-next-line no-restricted-globals
self.onmessage = () => {
  initialize((ctx: any, createData: any) => {
    return new CustomTypeScriptWorker(ctx, createData)
  })
}
