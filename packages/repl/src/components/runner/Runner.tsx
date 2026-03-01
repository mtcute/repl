import type { DropdownMenuTriggerProps } from '@kobalte/core/dropdown-menu'
import type { mtcute } from 'mtcute-repl-worker/client'
import type { Setter } from 'solid-js'
import type { CustomTypeScriptWorker } from '../editor/utils/custom-worker.ts'
import { timers } from '@fuman/utils'
import { persistentAtom } from '@nanostores/persistent'
import { LucideCheck, LucidePlay, LucidePlug, LucideRefreshCw, LucideSettings2, LucideSkull, LucideUnplug } from 'lucide-solid'
import { languages, Uri } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { Button } from '../../lib/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../lib/components/ui/dropdown-menu.tsx'
import { cn } from '../../lib/utils.ts'
import { $activeAccountId } from '../../store/accounts.ts'
import { $tabs } from '../../store/tabs.ts'
import { useStore } from '../../store/use-store.ts'
import { Devtools } from './Devtools.tsx'

const $disconnectAfterSecs = persistentAtom('repl:disconnectAfterSecs', 60, {
  encode: String,
  decode: Number,
})
const $enableUpdates = persistentAtom('repl:enableUpdates', true, {
  encode: String,
  decode: value => value === 'true',
})
const $enableVerbose = persistentAtom('repl:verboseLogs', false, {
  encode: String,
  decode: value => value === 'true',
})

export interface RunnerController {
  run: () => void
}

export function Runner(props: {
  isResizing: boolean
  controllerRef: Setter<RunnerController | undefined>
}) {
  const [devtoolsIframe, setDevtoolsIframe] = createSignal<HTMLIFrameElement | undefined>()
  const [runnerIframe, setRunnerIframe] = createSignal<HTMLIFrameElement>()
  const [runnerLoaded, setRunnerLoaded] = createSignal(false)
  const [running, setRunning] = createSignal(false)
  const [dead, setDead] = createSignal(false)
  const [connectionState, setConnectionState] = createSignal<mtcute.ConnectionState>('offline')
  const currentAccountId = useStore($activeAccountId)
  const disconnectAfterSecs = useStore($disconnectAfterSecs)
  const enableUpdates = useStore($enableUpdates)
  const enableVerbose = useStore($enableVerbose)

  let deadTimer: timers.Timer | undefined
  let inactivityTimer: timers.Timer | undefined
  let iframeContainerRef!: HTMLIFrameElement

  function rescheduleInactivityTimer() {
    if (inactivityTimer) timers.clearTimeout(inactivityTimer)
    if (connectionState() === 'offline') return
    if (disconnectAfterSecs() === -1) return

    inactivityTimer = timers.setTimeout(() => {
      inactivityTimer = undefined
      handleDisconnect()
    }, disconnectAfterSecs() * 1000)
  }

  function setInactivityTimeout(secs: number) {
    $disconnectAfterSecs.set(secs)
    rescheduleInactivityTimer()
  }

  function recreateIframe() {
    runnerIframe()?.remove()

    setRunnerIframe(undefined)
    setRunnerLoaded(false)
    setConnectionState('offline')
    setDead(false)
    setRunning(false)
    timers.clearTimeout(deadTimer)

    const iframe = document.createElement('iframe')
    iframe.className = 'invisible size-0'
    iframe.src = `${import.meta.env.VITE_IFRAME_URL}/sw/runtime/_iframe.html`
    iframe.onload = () => {
      iframe.contentWindow!.postMessage({
        event: 'INIT',
        accountId: currentAccountId(),
        logUpdates: enableUpdates(),
        verboseLogs: enableVerbose(),
      }, '*')
      setRunnerLoaded(true)
      deadTimer = timers.setTimeout(() => {
        setDead(true)
      }, 2000)
    }
    iframeContainerRef.appendChild(iframe)
    setRunnerIframe(iframe)
  }

  onMount(recreateIframe)

  function handleMessage(e: MessageEvent) {
    if (e.source === runnerIframe()?.contentWindow) {
      // event from runner iframe
      switch (e.data.event) {
        case 'TO_DEVTOOLS': {
          devtoolsIframe()?.contentWindow!.postMessage(e.data.value, '*')
          break
        }
        case 'SCRIPT_END': {
          setRunning(false)
          rescheduleInactivityTimer()
          break
        }
        case 'CONNECTION_STATE': {
          setConnectionState(e.data.value)
          if (e.data.value === 'connected') {
            rescheduleInactivityTimer()
          }
          break
        }
        case 'PING': {
          if (deadTimer) {
            timers.clearTimeout(deadTimer)
          }
          break
        }
      }
      return
    }

    if (e.source === devtoolsIframe()?.contentWindow) {
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data

      if (data.method === 'Page.getResourceTree' && !runnerLoaded()) {
        // for some reason, responding to this method is required for console.log to work
        // and since our runner might not be loaded yet, noone will respond to this message
        e.source!.postMessage(JSON.stringify({ id: data.id, result: {} }), '*')
        return
      }

      if (data.method === 'Page.reload') {
        location.reload()
        return
      }

      if (data.method === 'Runtime.evaluate' && data.params.userGesture) {
        rescheduleInactivityTimer()
      }

      runnerIframe()?.contentWindow!.postMessage({ event: 'FROM_DEVTOOLS', value: e.data }, '*')
    }
  }

  onMount(async () => {
    window.addEventListener('message', handleMessage)

    props.controllerRef({
      run: () => handleRun(),
    })
  })
  onCleanup(() => {
    window.removeEventListener('message', handleMessage)
  })

  createEffect(on(currentAccountId, (accountId) => {
    if (!runnerLoaded()) return
    runnerIframe()!.contentWindow!.postMessage({
      event: 'ACCOUNT_CHANGED',
      accountId,
    }, '*')
  }, { defer: true }))

  async function handleRun() {
    const getWorker = await languages.typescript.getTypeScriptWorker()
    const worker = await getWorker(Uri.parse('file:///main.ts')) as unknown as CustomTypeScriptWorker

    const tabs = $tabs.get()
    const processed = await Promise.all(tabs.map(tab => worker.processFile(`file:///${tab.fileName}`, tab.main)))

    const files: Record<string, string> = {}
    let exports: string[] | undefined
    for (let i = 0; i < processed.length; i++) {
      const processedFile = processed[i]
      const tab = tabs[i]
      files[tab.fileName.replace(/\.ts$/, '.js')] = processedFile.transformed
      if (tab.main) {
        exports = processedFile.exports
      }
    }

    runnerIframe()!.contentWindow!.postMessage({
      event: 'RUN',
      files,
      exports,
    }, '*')
    setRunning(true)
    timers.clearTimeout(inactivityTimer)
  }

  function handleDisconnect() {
    runnerIframe()?.contentWindow?.postMessage({ event: 'DISCONNECT' }, '*')
  }

  function handleConnect() {
    runnerIframe()?.contentWindow?.postMessage({ event: 'RECONNECT' }, '*')
  }

  function handleToggleUpdates() {
    const newValue = !enableUpdates()
    $enableUpdates.set(newValue)
    runnerIframe()?.contentWindow?.postMessage({
      event: 'TOGGLE_UPDATES',
      value: newValue,
    }, '*')
  }

  function handleToggleVerbose() {
    const newValue = !enableVerbose()
    $enableVerbose.set(newValue)
    runnerIframe()?.contentWindow?.postMessage({
      event: 'TOGGLE_VERBOSE',
      value: newValue,
    }, '*')
  }

  return (
    <>
      <div class="flex shrink-0 flex-row p-1">
        <div ref={iframeContainerRef} />
        <div class="flex w-full grow-0 flex-row">
          {dead() ? (
            <Button
              variant="ghostDestructive"
              size="xs"
              onClick={recreateIframe}
            >
              <LucideSkull
                class="mr-2 size-3"
              />
              Terminate
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleRun}
              disabled={!runnerLoaded() || running()}
            >
              <LucidePlay
                class="mr-2 size-3"
              />
              Run
            </Button>
          )}
          <div class="flex-1" />
          <div class="mr-2 flex items-center text-xs font-medium">
            {{
              offline: 'Disconnected',
              connecting: 'Connecting...',
              updating: 'Updating...',
              connected: 'Ready',
            }[connectionState()]}
            <div class={cn(
              'ml-2 size-2 rounded-full',
              {
                connected: 'bg-green-500',
                updating: 'bg-yellow-500',
                connecting: 'bg-yellow-500',
                offline: 'bg-neutral-400',
              }[connectionState()],
            )}
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              as={(props: DropdownMenuTriggerProps) => (
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  {...props}
                >
                  <LucideSettings2 class="size-4" />
                </Button>
              )}
            />
            <DropdownMenuContent>
              <DropdownMenuItem
                onClick={connectionState() === 'offline' ? handleConnect : handleDisconnect}
                class="text-xs"
                disabled={currentAccountId() === undefined}
              >
                <Dynamic
                  component={connectionState() === 'offline' ? LucidePlug : LucideUnplug}
                  class="mr-2 size-3"
                />
                {connectionState() === 'offline' ? 'Connect' : 'Disconnect'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={recreateIframe}
                class="text-xs"
              >
                <LucideRefreshCw
                  class="mr-2 size-3"
                />
                Restart runner
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem class="text-xs" checked={enableUpdates()} onClick={handleToggleUpdates}>
                Log updates
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem class="text-xs" checked={enableVerbose()} onClick={handleToggleVerbose}>
                Verbose logs
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel class="text-xs">
                  Auto-disconnect after
                </DropdownMenuGroupLabel>
                <DropdownMenuItem class="text-xs" onClick={() => setInactivityTimeout(60)} closeOnSelect={false}>
                  1 minute
                  {disconnectAfterSecs() === 60 && <LucideCheck class="ml-auto size-3" />}
                </DropdownMenuItem>
                <DropdownMenuItem class="text-xs" onClick={() => setInactivityTimeout(300)} closeOnSelect={false}>
                  5 minutes
                  {disconnectAfterSecs() === 300 && <LucideCheck class="ml-auto size-3" />}
                </DropdownMenuItem>
                <DropdownMenuItem class="text-xs" onClick={() => setInactivityTimeout(1500)} closeOnSelect={false}>
                  15 minutes
                  {disconnectAfterSecs() === 1500 && <LucideCheck class="ml-auto size-3" />}
                </DropdownMenuItem>
                <DropdownMenuItem class="text-xs" onClick={() => setInactivityTimeout(-1)} closeOnSelect={false}>
                  Never
                  {disconnectAfterSecs() === -1 && <LucideCheck class="ml-auto size-3" />}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div class="h-px shrink-0 bg-border" />
      <Devtools
        class={cn('size-full grow-0', props.isResizing && 'pointer-events-none')}
        iframeRef={setDevtoolsIframe}
      />
    </>
  )
}
