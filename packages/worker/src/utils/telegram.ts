import type { tl } from '@mtcute/web'
import type { CustomApiFields, TelegramAccount } from '../store/accounts.ts'
import { asNonNull } from '@fuman/utils'
import { BaseTelegramClient, IdbStorage, TransportError } from '@mtcute/web'
import { getMe } from '@mtcute/web/methods.js'
import { type InputStringSessionData, jsonToTlJson } from '@mtcute/web/utils.js'
import { nanoid } from 'nanoid'

export function createInternalClient(
  accountId: string,
  testMode?: boolean,
  apiOptions?: CustomApiFields,
) {
  let initConnectionOptions: Partial<tl.RawInitConnectionRequest> | undefined
  if (apiOptions) {
    initConnectionOptions = {}
    if (apiOptions.deviceModel) {
      initConnectionOptions.deviceModel = apiOptions.deviceModel
    }
    if (apiOptions.systemVersion) {
      initConnectionOptions.systemVersion = apiOptions.systemVersion
    }
    if (apiOptions.appVersion) {
      initConnectionOptions.appVersion = apiOptions.appVersion
    }
    if (apiOptions.langCode) {
      initConnectionOptions.langCode = apiOptions.langCode
    }
    if (apiOptions.langPack) {
      initConnectionOptions.langPack = apiOptions.langPack
    }
    if (apiOptions.systemLangCode) {
      initConnectionOptions.systemLangCode = apiOptions.systemLangCode
    }
    if (apiOptions.extraJson) {
      initConnectionOptions.params = jsonToTlJson(JSON.parse(apiOptions.extraJson))
    }
  }

  return new BaseTelegramClient({
    apiId: Number(apiOptions?.apiId ?? import.meta.env.VITE_API_ID),
    apiHash: apiOptions?.apiHash ?? import.meta.env.VITE_API_HASH,
    storage: new IdbStorage(`mtcute:${accountId}`),
    testMode,
    logLevel: import.meta.env.DEV ? 5 : 2,
    initConnectionOptions,
  })
}

export async function deleteAccount(accountId: string) {
  const req = indexedDB.deleteDatabase(`mtcute:${accountId}`)
  return new Promise<void>((resolve, reject) => {
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function importAccount(
  session: InputStringSessionData,
  abortSignal: AbortSignal,
  apiOptions?: CustomApiFields,
): Promise<TelegramAccount> {
  const accountId = nanoid()
  const client = createInternalClient(accountId, session.primaryDcs?.main.testMode, apiOptions)

  let is404 = false

  try {
    await client.importSession(session)
    if (abortSignal.aborted) throw abortSignal.reason

    // verify auth_key is valid (i.e. we don't get -404)
    client.onError.add((err) => {
      if (err instanceof TransportError && err.code === 404) {
        is404 = true
        client.destroy()
      }
    })
    await client.connect()

    const self = await getMe(client)
    if (abortSignal.aborted) throw abortSignal.reason

    await client.destroy()

    return {
      id: accountId,
      name: self.displayName,
      telegramId: self.id,
      bot: self.isBot,
      testMode: asNonNull(session.primaryDcs).main.testMode ?? false,
      dcId: asNonNull(session.primaryDcs).main.id,
    }
  } catch (e) {
    await client.destroy()
    await deleteAccount(accountId)
    if (is404) {
      throw new Error('Invalid session (auth key not found)')
    }
    throw e
  }
}
