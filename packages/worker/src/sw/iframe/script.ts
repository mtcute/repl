import type { BaseTelegramClientOptions, ConnectionState } from '@mtcute/web'
import { asNonNull } from '@fuman/utils'
import { FileLocation, Long, networkMiddlewares, TelegramClient } from '@mtcute/web'
import { nanoid } from 'nanoid'
import { swInvokeMethodInner } from '../client-inner.ts'
import { createFileDownload } from '../download/client.ts'

const HOST_ORIGIN = import.meta.env.VITE_HOST_ORIGIN

declare const chobitsu: any

declare const window: typeof globalThis & {
  __currentScript: any
  __handleScriptEnd: (error: any) => void
  tg: import('@mtcute/web').TelegramClient
  setMiddlewareOptions: (options: networkMiddlewares.BasicMiddlewaresOptions) => Promise<void>
}

Object.defineProperty(globalThis, 'Long', { value: Long })

function sendToDevtools(message: any) {
  window.parent.postMessage({ event: 'TO_DEVTOOLS', value: message }, HOST_ORIGIN)
}

function sendToChobitsu(message: any) {
  message.id = `__chobitsu_manual__${Date.now()}`
  chobitsu.sendRawMessage(JSON.stringify(message))
}

chobitsu.setOnMessage((message: string) => {
  if (message.includes('__chobitsu_manual__')) return
  sendToDevtools(message)
})

let lastAccountId: string | undefined
let lastConnectionState: ConnectionState | undefined
let lastMiddlewareOptions: networkMiddlewares.BasicMiddlewaresOptions | undefined
let currentScriptId: string | undefined
let logUpdates = false
let verboseLogs = false

Object.defineProperty(globalThis, 'setMiddlewareOptions', {
  value: async (options: networkMiddlewares.BasicMiddlewaresOptions) => {
    if (JSON.stringify(options) === JSON.stringify(lastMiddlewareOptions)) return
    lastMiddlewareOptions = options
    if (window.tg) {
      await window.tg.destroy()
      initClient(lastAccountId!, verboseLogs)
      if (lastConnectionState !== 'offline') {
        await window.tg.connect()
      }
    }
  },
})

function initTgProxy() {
  const handler: ProxyHandler<object> = {
    get(_, prop) {
      if (prop === Symbol.toPrimitive || prop === Symbol.toStringTag || prop === 'toString' || prop === 'valueOf') {
        return undefined
      }
      throw new Error('You need to log in to use `tg`. Go to Settings > Accounts to add an account.')
    },
  }
  window.tg = new Proxy({}, handler) as any
}

function initClient(accountId: string, verbose: boolean) {
  lastAccountId = accountId

  const extraConfig: Partial<BaseTelegramClientOptions> = {}

  const storedAccounts = localStorage.getItem('repl:accounts')
  if (storedAccounts) {
    const accounts = JSON.parse(storedAccounts)
    const ourAccount = accounts.find((it: any) => it.id === accountId)
    if (!ourAccount) return

    if (ourAccount && ourAccount.testMode) {
      extraConfig.testMode = true
    }
  }

  if (lastMiddlewareOptions) {
    extraConfig.network = {
      middlewares: networkMiddlewares.basic(lastMiddlewareOptions),
    }
  }

  window.tg = new TelegramClient({
    apiId: import.meta.env.VITE_API_ID,
    apiHash: import.meta.env.VITE_API_HASH,
    storage: `mtcute:${accountId}`,
    logLevel: verbose ? 5 : 2,
    ...extraConfig,
  })
  window.tg.onConnectionState.add((state) => {
    lastConnectionState = state
    window.parent.postMessage({ event: 'CONNECTION_STATE', value: state }, HOST_ORIGIN)
  })
  window.tg.onUpdate.add((update) => {
    if (!logUpdates) return
    // eslint-disable-next-line no-console
    console.log('%c[UPDATE]%c %s: %o', 'color: #8d7041', 'color: unset', update.name, update.data)
  })

  window.tg.downloadToFile = async (filename, input, params) => {
    // todo: there should probably be a better way than this
    let fileSize = params?.fileSize
    if (!fileSize) {
      if (input instanceof FileLocation) {
        let locationInner = input.location

        if (typeof locationInner === 'function') {
          locationInner = locationInner()
        }

        if (ArrayBuffer.isView(locationInner)) {
          fileSize = locationInner.byteLength
        } else {
          fileSize = input.fileSize
        }
      }
    }

    const abortController = new AbortController()
    const writable = createFileDownload(
      {
        filename,
        size: fileSize,
      },
      reason => abortController.abort(reason),
    )

    await window.tg.downloadAsStream(input, params).pipeTo(writable)
  }
}

window.addEventListener('message', async ({ data }) => {
  if (data.event === 'INIT') {
    sendToDevtools({
      method: 'Page.frameNavigated',
      params: {
        frame: {
          id: '1',
          mimeType: 'text/html',
          securityOrigin: location.origin,
          url: location.href,
        },
        type: 'Navigation',
      },
    })

    sendToDevtools({ method: 'Runtime.executionContextsCleared' })
    sendToChobitsu({ method: 'Runtime.enable' })
    sendToChobitsu({ method: 'DOMStorage.enable' })
    sendToDevtools({ method: 'DOM.documentUpdated' })

    if (data.accountId != null) {
      initClient(data.accountId, data.verboseLogs)
    } else {
      initTgProxy()
    }
    logUpdates = data.logUpdates

    if (data.accountId != null && window.tg !== undefined) {
      window.tg.connect()
      window.tg.startUpdatesLoop()
    }

    setInterval(() => {
      window.parent.postMessage({ event: 'PING' }, HOST_ORIGIN)
    }, 500)
  } else if (data.event === 'RUN') {
    currentScriptId = nanoid()
    await swInvokeMethodInner({ event: 'UPLOAD_SCRIPT', name: currentScriptId, files: data.files }, asNonNull(navigator.serviceWorker.controller))

    if (lastAccountId != null) {
      if (lastConnectionState === 'offline') {
        await window.tg.connect()
      }
    }

    const el = document.createElement('script')
    el.type = 'module'
    let script = `import * as result from "/sw/runtime/script/${currentScriptId}/main.js";`
    for (const exportName of data.exports ?? []) {
      script += `window.${exportName} = result.${exportName};`
    }
    if (data.exports?.length) {
      script += `console.log("[mtcute-repl] Script ended, exported variables: ${data.exports.join(', ')}");`
    } else {
      script += 'console.log("[mtcute-repl] Script ended");'
    }
    script += 'window.__handleScriptEnd();'

    el.textContent = script
    el.addEventListener('error', e => window.__handleScriptEnd(e.error))
    window.__currentScript = el

    document.body.appendChild(el)
  } else if (data.event === 'FROM_DEVTOOLS') {
    chobitsu.sendRawMessage(data.value)
  } else if (data.event === 'ACCOUNT_CHANGED') {
    if (lastAccountId != null) {
      await window.tg?.destroy()
    }
    if (data.accountId != null) {
      initClient(data.accountId, data.verboseLogs)
      if (lastConnectionState !== 'offline') {
        window.parent.postMessage({ event: 'CONNECTION_STATE', value: 'offline' }, HOST_ORIGIN)
        window.tg.connect()
        window.tg.startUpdatesLoop()
      }
    } else {
      lastAccountId = undefined
      initTgProxy()
      window.parent.postMessage({ event: 'CONNECTION_STATE', value: 'offline' }, HOST_ORIGIN)
    }
  } else if (data.event === 'DISCONNECT') {
    await window.tg?.disconnect()
    window.parent.postMessage({ event: 'CONNECTION_STATE', value: 'offline' }, HOST_ORIGIN)
    lastConnectionState = 'offline'
  } else if (data.event === 'RECONNECT') {
    if (window.tg !== undefined) {
      window.tg.connect()
    }
  } else if (data.event === 'TOGGLE_UPDATES') {
    if (data.value === logUpdates) return
    logUpdates = data.value
  } else if (data.event === 'TOGGLE_VERBOSE') {
    if (data.value === verboseLogs) return
    verboseLogs = data.value;
    (window.tg.log as any).level = verboseLogs ? 5 : 2
  }
})

window.__handleScriptEnd = (error) => {
  if (!window.__currentScript) return
  if (currentScriptId) {
    swInvokeMethodInner({ event: 'FORGET_SCRIPT', name: currentScriptId }, asNonNull(navigator.serviceWorker.controller))
      .catch(console.error)
  }
  window.parent.postMessage({ event: 'SCRIPT_END', error }, HOST_ORIGIN)
  window.__currentScript.remove()
  window.__currentScript = undefined
}

window.addEventListener('error', (e) => {
  if (window.__currentScript) {
    window.__handleScriptEnd(e.error)
  }
})
