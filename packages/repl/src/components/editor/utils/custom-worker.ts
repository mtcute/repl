import type { Diagnostic, ExportDeclaration, ModifierLike, VariableStatement } from 'typescript'
import { initialize, ts, TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/ts.worker'
import { blankSourceFile } from 'ts-blank-space'

class CustomTypeScriptWorker extends TypeScriptWorker {
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
