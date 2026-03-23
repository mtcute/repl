declare module 'monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js' {
  import typescript from 'typescript'

  export { typescript }
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker' {
  import type typescript from 'typescript'

  export class TypeScriptWorker {
    constructor(ctx: any, createData: any)
    getCompilationSettings(): ts.CompilerOptions
    getLanguageService(): ts.LanguageService
    isDefaultLibFileName(fileName: string): boolean
    getSyntacticDiagnostics(fileName: string): Promise<ts.Diagnostic[]>
    updateExtraLibs(extraLibs: Record<string, any>): Promise<void>
  }

  export function initialize(callback: (ctx: any, createData: any) => TypeScriptWorker): void
  export const ts: { typescript: typeof typescript }
}

declare module 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js' {
  export const typescriptDefaults: {
    setCompilerOptions: (options: any) => void
    setExtraLibs: (libs: { content: string, filePath?: string }[]) => void
  }
  export const javascriptDefaults: {
    setCompilerOptions: (options: any) => void
  }
  export function getTypeScriptWorker(): Promise<(uri: any) => Promise<any>>

  export const ScriptTarget: { ESNext: number }
  export const ModuleKind: { ESNext: number }
  export const JsxEmit: { Preserve: number }
}
