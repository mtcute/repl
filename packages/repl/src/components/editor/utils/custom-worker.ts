import type { Diagnostic, ExportDeclaration, ModifierLike, VariableStatement } from 'typescript'
import { initialize, ts, TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/ts.worker'
import { blankSourceFile } from 'ts-blank-space'

class CustomTypeScriptWorker extends TypeScriptWorker {
  // extra libs use `@` but Monaco URIs use `%40`. TS program uses identity for
  // canonical file names, so both encodings coexist as "different" files.
  // fix: make ALL paths use %40 consistently, and normalize lookups to find @ content.
  private _resolveText(path: string): string | undefined {
    return (this as any)._getScriptText(path)
      ?? (this as any)._getScriptText(decodeURIComponent(path))
  }

  private _resolveExtraLib(path: string): any {
    const libs = (this as any)._extraLibs ?? {}
    return libs[path] ?? libs[decodeURIComponent(path)]
  }

  getScriptFileNames(): string[] {
    const allModels = (this as any)._ctx.getMirrorModels().map((m: any) => m.uri)
    const models: string[] = allModels
      .filter((uri: any) => !uri.path?.startsWith('/lib.'))
      .map((uri: any) => uri.toString())

    // encode extra lib keys to %40 so all paths in the program use the same encoding
    const extraLibKeys: string[] = Object.keys((this as any)._extraLibs ?? {})
    const encodedKeys = extraLibKeys.map((k: string) => k.replace(/\/@/g, '/%40'))

    const modelSet = new Set(models)
    const deduped = encodedKeys.filter((k: string) => !modelSet.has(k))
    return [...models, ...deduped]
  }

  getScriptVersion(fileName: string): string {
    const model = (this as any)._getModel(fileName)
    if (model) return model.version.toString()
    const lib = this._resolveExtraLib(fileName)
    if (lib) return String(lib.version)
    return '1'
  }

  getScriptSnapshot(fileName: string): any {
    const text = this._resolveText(fileName)
    if (text === undefined) return undefined
    return {
      getText: (start: number, end: number) => text.substring(start, end),
      getLength: () => text.length,
      getChangeRange: () => undefined,
    }
  }

  fileExists(path: string): boolean {
    return this._resolveText(path) !== undefined
  }

  readFile(path: string): string | undefined {
    return this._resolveText(path)
  }

  // follow through import declarations in .d.ts files to the actual definition
  async getDeepDefinition(fileName: string, position: number) {
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
    return this.getLanguageService().getCompletionsAtPosition(fileName, position, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForImportStatements: true,
    })
  }

  // custom provider uses these for auto-import completions
  async getAutoImportCompletions(fileName: string, position: number) {
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
}

export type { CustomTypeScriptWorker }

// eslint-disable-next-line no-restricted-globals
self.onmessage = () => {
  initialize((ctx: any, createData: any) => {
    return new CustomTypeScriptWorker(ctx, createData)
  })
}
