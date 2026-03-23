import type { EditorTab } from '../../store/tabs.ts'
import clsx from 'clsx'
import { LucidePlus, LucideX } from 'lucide-solid'
import { nanoid } from 'nanoid'
import { batch, createSignal, For, Show } from 'solid-js'
import { Button } from '../../lib/components/ui/button.tsx'
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from '../../lib/components/ui/tabs.tsx'
import { cn } from '../../lib/utils.ts'
import { $activeTab, $ephemeralTab, $tabs, EPHEMERAL_TAB_ID } from '../../store/tabs.ts'
import { useStore } from '../../store/use-store.ts'

export interface EditorTabsProps {
  class?: string
}

export function EditorTabs(props: EditorTabsProps) {
  const tabs = useStore($tabs)
  const activeTab = useStore($activeTab)
  const ephemeralTab = useStore($ephemeralTab)

  const [renamingTabId, setRenamingTabId] = createSignal<string | undefined>(undefined)

  let root!: HTMLDivElement
  let indicator!: HTMLDivElement

  const updateIndicator = () => {
    // crutch to imperatively update the indicator width
    // based on https://github.com/kobaltedev/kobalte/issues/273#issuecomment-1741962351
    const selected = root.querySelector<HTMLElement>(
      '[role=tab][data-selected]',
    )!

    indicator.style.width = `${selected.clientWidth}px`
    indicator.style.transform = `translateX(${selected.offsetLeft}px)`
  }

  const createNewTab = () => {
    batch(() => {
      const tabs_ = tabs()
      const newTabId = nanoid()
      $tabs.set([
        ...tabs_,
        {
          id: newTabId,
          fileName: `newfile${tabs_.length}.ts`,
          main: false,
        },
      ])
      $activeTab.set(newTabId)
    })
  }

  const closeTab = (tabId: string) => {
    const tabs_ = tabs()
    if (tabs_.length === 1) return
    const nextTabs = tabs_.filter(tab => tab.id !== tabId)
    $tabs.set(nextTabs)
    if (tabId === activeTab()) {
      $activeTab.set(nextTabs[0].id)
    }
    queueMicrotask(updateIndicator)
  }

  const applyRename = (el: HTMLDivElement) => {
    let newName = el.textContent
    if (!newName) return

    if (!newName.endsWith('.ts')) newName += '.ts'
    newName = newName.replace(/[/';!@#$%^&*()\s]/g, '')

    const tabs_ = tabs()
    const ourTabIdx = tabs_.findIndex(tab => tab.id === renamingTabId())
    if (ourTabIdx === -1) return

    $tabs.set([
      ...tabs_.slice(0, ourTabIdx),
      {
        ...tabs_[ourTabIdx],
        fileName: newName,
      },
      ...tabs_.slice(ourTabIdx + 1),
    ])
    setRenamingTabId(undefined)
    setTimeout(updateIndicator, 10)
  }

  const renderTab = (tab: EditorTab) => {
    return (
      <TabsTrigger
        value={tab.id}
        class="flex w-fit flex-row items-center gap-1 pl-2 pr-1"
        onClick={() => $activeTab.set(tab.id)}
      >
        <div
          class={clsx(
            tab.id === renamingTabId() && 'cursor-text outline-none',
          )}
          onClick={(event: MouseEvent) => {
            if (tab.id === renamingTabId()) {
              event.stopPropagation()
              return
            }
            if (tab.id === activeTab() && !tab.main) {
              setRenamingTabId(tab.id)
              event.stopPropagation()
              const target = event.currentTarget as HTMLDivElement
              target.focus()

              const range = document.createRange()
              range.selectNodeContents(target)
              // range.collapse(false)

              const sel = window.getSelection()!
              sel.removeAllRanges()
              sel.addRange(range)
            }
          }}
          contentEditable={tab.id === renamingTabId()}
          onKeyDown={(event: KeyboardEvent) => {
            if (tab.id !== renamingTabId()) return
            event.stopPropagation()

            const target = event.currentTarget as HTMLDivElement
            if (event.key === 'Enter') {
              applyRename(target)
              target.blur()
            }

            if (event.key === 'Escape') {
              // cancel rename
              setRenamingTabId(undefined)
              target.textContent = tab.fileName
              target.blur()
              window.getSelection()?.removeAllRanges()
            }
          }}
          onBlur={(event: FocusEvent) => {
            if (tab.id === renamingTabId()) {
              applyRename(event.currentTarget as HTMLDivElement)
            }
          }}
        >
          {tab.fileName}
        </div>
        {!tab.main && (
          <Button
            variant="ghost"
            size="icon"
            class="size-5"
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              closeTab(tab.id)
            }}
          >
            <LucideX size="0.75rem" />
          </Button>
        )}
      </TabsTrigger>
    )
  }

  return (
    <Tabs
      value={activeTab()}
      // onChange={tab => setTabs('activeTab', tab)}
      class={cn('max-w-full overflow-auto', props.class)}
      ref={root}
    >
      <TabsList class=" rounded-none border-b bg-transparent px-2" style={{ 'align-items': 'stretch' }}>
        <For each={tabs()}>
          {renderTab}
        </For>
        <Show when={ephemeralTab()}>
          {eph => (
            <TabsTrigger
              value={EPHEMERAL_TAB_ID}
              class="flex w-fit flex-row items-center gap-1 pl-2 pr-1 italic opacity-75"
              onClick={() => $activeTab.set(EPHEMERAL_TAB_ID)}
            >
              <div>{eph().fileName}</div>
              <Button
                variant="ghost"
                size="icon"
                class="size-5"
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  $ephemeralTab.set(null)
                  if (activeTab() === EPHEMERAL_TAB_ID) {
                    $activeTab.set(tabs()[0].id)
                  }
                }}
              >
                <LucideX size="0.75rem" />
              </Button>
            </TabsTrigger>
          )}
        </Show>
        <Button
          variant="ghost"
          size="icon"
          class="ml-1 size-6 shrink-0"
          onClick={createNewTab}
        >
          <LucidePlus size="0.75rem" />
        </Button>
        <TabsIndicator
          variant="underline"
          ref={indicator}
        />
        <div class="flex grow" onDblClick={createNewTab} />
      </TabsList>
    </Tabs>
  )
}
