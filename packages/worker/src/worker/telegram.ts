import type { BaseTelegramClient, SentCode, User } from '@mtcute/web'
import type { StringSessionData } from '@mtcute/web/utils.js'
import type { CustomApiFields, TelegramAccount } from '../store/accounts.ts'
import { assert, hex } from '@fuman/utils'
import { DC_MAPPING_PROD, DC_MAPPING_TEST } from '@mtcute/convert'
import { tl } from '@mtcute/web'
import { checkPassword, downloadAsBuffer, getMe, resendCode, sendCode, signIn, signInBot, signInQr } from '@mtcute/web/methods.js'
import { readStringSession } from '@mtcute/web/utils.js'
import { nanoid } from 'nanoid'
import { renderSVG } from 'uqr'
import { $accounts, $activeAccountId } from '../store/accounts.ts'
import { createInternalClient, deleteAccount, importAccount } from '../utils/telegram.ts'
import { emitEvent } from './utils.ts'

export type StringSessionLibName =
  | 'mtcute'
  | 'pyrogram'
  | 'telethon'
  | 'mtkruto'
  | 'gramjs'

const clients = new Map<string, BaseTelegramClient>()
function getClient(accountId: string) {
  const client = clients.get(accountId)
  if (!client) throw new Error('Client not found')
  return client
}

function getTmpClient(accountId: string): [BaseTelegramClient, () => Promise<void>] {
  const client = clients.get(accountId)
  if (!client) {
    const accountInfo = $accounts.get().find(it => it.id === accountId)
    if (!accountInfo) throw new Error('Account not found')
    const tmpClient = createInternalClient(accountId, accountInfo.testMode, accountInfo.apiOptions)
    return [tmpClient, () => tmpClient.destroy()]
  } else {
    return [client, () => Promise.resolve()]
  }
}

let avatarCache: Cache | undefined

async function handleAuthSuccess(accountId: string, user: User) {
  const client = getClient(accountId)
  const dcs = await client.mt.storage.dcs.fetch()
  const dcId = dcs?.main.id ?? 2
  const testMode = client.params.testMode ?? false

  if ($accounts.get().some(it => it.telegramId === user.id)) {
    await client.destroy()
    await deleteAccount(accountId)
    throw new Error(`Account already exists (user ID: ${user.id})`)
  }

  const account: TelegramAccount = {
    id: accountId,
    name: user.displayName,
    telegramId: user.id,
    bot: user.isBot,
    testMode,
    dcId,
  }
  $accounts.set([
    ...$accounts.get(),
    account,
  ])
  $activeAccountId.set(accountId)

  await client.destroy()

  return account
}

export class ReplWorkerTelegram {
  async createClient(params: {
    accountId: string
    testMode?: boolean
    apiOptions?: CustomApiFields
  }) {
    const client = createInternalClient(params.accountId, params.testMode, params.apiOptions)
    clients.set(params.accountId, client)
  }

  async disposeClient(params: {
    accountId: string
    forget?: boolean
  }) {
    const client = clients.get(params.accountId)
    if (!client) return
    await client.destroy()
    clients.delete(params.accountId)

    if (params.forget) {
      await deleteAccount(params.accountId)
    }
  }

  async loadCountries(params: {
    accountId: string
  }): Promise<{ countries: tl.help.RawCountry[], countryByIp: string }> {
    const client = getClient(params.accountId)

    const [
      countries,
      nearestDc,
    ] = await Promise.all([
      client.call({ _: 'help.getCountriesList', langCode: 'en', hash: 0 }),
      client.call({ _: 'help.getNearestDc' }),
    ])

    assert(countries._ === 'help.countriesList') // todo caching

    return {
      countries: countries.countries,
      countryByIp: nearestDc.country.toUpperCase(),
    }
  }

  async signInQr(params: {
    accountId: string
    abortSignal: AbortSignal
  }): Promise<TelegramAccount | 'need_password'> {
    const { accountId, abortSignal } = params
    const client = getClient(accountId)

    try {
      const user = await signInQr(client, {
        abortSignal,
        onUrlUpdated: qr => emitEvent('QrCodeUpdate', { accountId, qrCode: renderSVG(qr) }),
        onQrScanned: () => emitEvent('QrCodeScanned', { accountId }),
      })

      return await handleAuthSuccess(accountId, user)
    } catch (e) {
      if (tl.RpcError.is(e, 'SESSION_PASSWORD_NEEDED')) {
        return 'need_password'
      } else {
        throw e
      }
    }
  }

  async sendCode(params: {
    accountId: string
    phone: string
    abortSignal: AbortSignal
  }): Promise<SentCode> {
    const { accountId, phone, abortSignal } = params

    const code = await sendCode(getClient(accountId), {
      phone,
      abortSignal,
    })

    return (code as any).toJSON()
  }

  async resendCode(params: {
    accountId: string
    phone: string
    phoneCodeHash: string
    abortSignal: AbortSignal
  }): Promise<SentCode> {
    const { accountId, phone, phoneCodeHash, abortSignal } = params

    const code = await resendCode(getClient(accountId), {
      phone,
      phoneCodeHash,
      abortSignal,
    })

    return (code as any).toJSON()
  }

  async signIn(params: {
    accountId: string
    phone: string
    phoneCodeHash: string
    phoneCode: string
    abortSignal?: AbortSignal
  }): Promise<TelegramAccount | 'need_password'> {
    const { accountId, phone, phoneCodeHash, phoneCode, abortSignal } = params
    try {
      const user = await signIn(getClient(accountId), {
        phone,
        phoneCodeHash,
        phoneCode,
        abortSignal,
      })

      return await handleAuthSuccess(accountId, user)
    } catch (e) {
      if (tl.RpcError.is(e, 'SESSION_PASSWORD_NEEDED')) {
        return 'need_password'
      } else {
        throw e
      }
    }
  }

  async checkPassword(params: {
    accountId: string
    password: string
    abortSignal: AbortSignal
  }): Promise<TelegramAccount> {
    const { accountId, password, abortSignal } = params

    try {
      const user = await checkPassword(getClient(accountId), {
        password,
        abortSignal,
      })
      return await handleAuthSuccess(accountId, user)
    } catch (e) {
      if (tl.RpcError.is(e, 'PASSWORD_HASH_INVALID')) {
        throw new Error('Incorrect password')
      } else {
        throw e
      }
    }
  }

  async fetchAvatar(accountId: string) {
    if (!avatarCache) {
      avatarCache = await caches.open('mtcute-repl-avatars')
    }
    const req = new Request(`/${accountId}.jpg`)
    const cached = await avatarCache.match(req)

    if (cached) {
      if (!cached.ok) return null
      return new Uint8Array(await cached.arrayBuffer())
    }

    const [client, cleanup] = getTmpClient(accountId)
    const self = await getMe(client)

    let response: Response
    let result: Uint8Array | null = null
    if (!self.photo) {
      response = new Response('No photo', { status: 404 })
      result = null
    } else {
      const buf = await downloadAsBuffer(client, self.photo.big)
      response = new Response(buf)
      result = buf
    }

    await cleanup()
    await avatarCache.put(req, response)
    return result
  }

  async importAuthKey(params: {
    hexAuthKey: string
    dcId: number
    testMode: boolean
    abortSignal: AbortSignal
    apiOptions?: CustomApiFields
  }) {
    const { hexAuthKey, dcId, testMode, abortSignal, apiOptions } = params

    const authKey = hex.decode(hexAuthKey)
    if (authKey.length !== 256) {
      throw new Error('Invalid auth key (must be 256 bytes long)')
    }

    const account = await importAccount({
      authKey,
      testMode,
      primaryDcs: (testMode ? DC_MAPPING_TEST : DC_MAPPING_PROD)[dcId],
    }, abortSignal, apiOptions)

    if ($accounts.get().some(it => it.telegramId === account.telegramId)) {
      await deleteAccount(account.id)
      throw new Error(`Account already exists (user ID: ${account.telegramId})`)
    }

    $accounts.set([
      ...$accounts.get(),
      account,
    ])
    $activeAccountId.set(account.id)

    return account
  }

  async importStringSession(params: {
    libraryName: StringSessionLibName
    session: string
    abortSignal: AbortSignal
    apiOptions?: CustomApiFields
  }) {
    let session: StringSessionData
    switch (params.libraryName) {
      case 'mtcute': {
        session = readStringSession(params.session)
        break
      }
      case 'telethon': {
        const { convertFromTelethonSession } = await import('@mtcute/convert')
        session = convertFromTelethonSession(params.session)
        break
      }
      case 'gramjs': {
        const { convertFromGramjsSession } = await import('@mtcute/convert')
        session = convertFromGramjsSession(params.session)
        break
      }
      case 'pyrogram': {
        const { convertFromPyrogramSession } = await import('@mtcute/convert')
        session = convertFromPyrogramSession(params.session)
        break
      }
      case 'mtkruto': {
        const { convertFromMtkrutoSession } = await import('@mtcute/convert')
        session = convertFromMtkrutoSession(params.session)
        break
      }
    }

    if (session.self && $accounts.get().some(it => it.telegramId === session.self!.userId)) {
      throw new Error(`Account already exists (user ID: ${session.self.userId})`)
    }

    const account = await importAccount(session, params.abortSignal, params.apiOptions)

    // check if account already exists once again
    if ($accounts.get().some(it => it.telegramId === account.telegramId)) {
      await deleteAccount(account.id)
      throw new Error(`Account already exists (user ID: ${account.telegramId})`)
    }

    $accounts.set([
      ...$accounts.get(),
      account,
    ])
    $activeAccountId.set(account.id)
  }

  async importBotToken(params: {
    botToken: string
    abortSignal: AbortSignal
  }) {
    // todo abort signal
    const { botToken } = params

    const accountId = nanoid()
    const client = createInternalClient(accountId)
    clients.set(accountId, client)
    const self = await signInBot(client, botToken)

    return await handleAuthSuccess(accountId, self)
  }

  async deleteAccount(params: {
    accountId: string
  }) {
    let client = clients.get(params.accountId)
    if (!client) {
      client = createInternalClient(params.accountId)
    }

    const filteredAccounts = $accounts.get().filter(it => it.id !== params.accountId)
    // NB: we change active account first to make sure the runner iframe terminates
    if ($activeAccountId.get() === params.accountId) {
      $activeAccountId.set(filteredAccounts[0]?.id ?? null)
    }

    await client.destroy()
    clients.delete(params.accountId)
    await deleteAccount(params.accountId)

    $accounts.set(filteredAccounts)
  }

  async exportStringSession(params: {
    accountId: string
    libraryName: StringSessionLibName
  }): Promise<string> {
    const { accountId, libraryName } = params

    const [client, cleanup] = getTmpClient(accountId)

    const session = await client.exportSession()
    await cleanup()

    let res: string
    switch (libraryName) {
      case 'mtcute': {
        res = session
        break
      }
      case 'telethon': {
        const { convertToTelethonSession } = await import('@mtcute/convert')
        res = convertToTelethonSession(session)
        break
      }
      case 'gramjs': {
        const { convertToGramjsSession } = await import('@mtcute/convert')
        res = convertToGramjsSession(session)
        break
      }
      case 'pyrogram': {
        const { convertToPyrogramSession } = await import('@mtcute/convert')
        res = convertToPyrogramSession(session)
        break
      }
      case 'mtkruto': {
        const { convertToMtkrutoSession } = await import('@mtcute/convert')
        res = convertToMtkrutoSession(session)
        break
      }
    }

    return res
  }

  async updateInfo(params: {
    accountId: string
  }) {
    const { accountId } = params

    if (!avatarCache) {
      avatarCache = await caches.open('mtcute-repl-avatars')
    }

    await avatarCache.delete(new Request(`/${accountId}.jpg`))

    const [client, cleanup] = getTmpClient(accountId)
    const self = await getMe(client)
    await cleanup()

    $accounts.set($accounts.get().map((it) => {
      if (it.id === accountId) {
        return {
          ...it,
          name: self.displayName,
          telegramId: self.id,
          bot: self.isBot,
        }
      } else {
        return it
      }
    }))
  }
}
