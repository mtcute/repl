import { unknownToError } from '@fuman/utils'
import { IS_SAFARI } from '../lib/env.ts'
import { handleAvatarRequest } from './avatar.ts'
import { requestCache } from './cache.ts'
import { clearCache, forgetScript, handleRuntimeRequest, uploadScript } from './runtime.ts'

declare const self: ServiceWorkerGlobalScope

async function handleSwRequest(req: Request, url: URL): Promise<Response> {
  if (url.pathname.startsWith('/sw/avatar/')) {
    const accountId = url.pathname.split('/')[3]
    return handleAvatarRequest(accountId)
  }

  if (url.pathname.startsWith('/sw/runtime/')) {
    return handleRuntimeRequest(url)
  }

  return new Response('Not Found', { status: 404 })
}

function onFetch(event: FetchEvent) {
  const req = event.request
  const url = new URL(req.url)

  if (
    import.meta.env.PROD
      && !IS_SAFARI
      && event.request.url.indexOf(`${location.origin}/`) === 0
      && event.request.url.match(/\.(js|css|jpe?g|json|wasm|png|mp3|svg|tgs|ico|woff2?|ttf|webmanifest?)(?:\?.*)?$/)
  ) {
    return event.respondWith(requestCache(event))
  }

  if (url.pathname.startsWith('/sw/')) {
    event.respondWith(
      handleSwRequest(req, url)
        .catch((err) => {
          console.error(err)
          return new Response(err.message || err.toString(), { status: 500 })
        }),
    )
  }
}

function register() {
  self.onfetch = onFetch
}

register()
self.onoffline = self.ononline = () => {
  register()
}

export type SwMessage =
  | { event: 'UPLOAD_SCRIPT', name: string, files: Record<string, string> }
  | { event: 'FORGET_SCRIPT', name: string }
  | { event: 'CLEAR_CACHE' }

function handleMessage(msg: SwMessage) {
  switch (msg.event) {
    case 'UPLOAD_SCRIPT': {
      uploadScript(msg.name, msg.files)
      break
    }
    case 'FORGET_SCRIPT': {
      forgetScript(msg.name)
      break
    }
    case 'CLEAR_CACHE': {
      clearCache()
      break
    }
  }
}

self.onmessage = async (event) => {
  const msg = event.data as SwMessage & { id: number }
  try {
    const result = await handleMessage(msg)
    event.source!.postMessage({ id: msg.id, result })
  } catch (e) {
    event.source!.postMessage({ id: msg.id, error: unknownToError(e).message })
  }
}
