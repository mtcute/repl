import type { BaseTelegramClient, tl } from '@mtcute/web'

import { assert } from '@fuman/utils'
import { createSignal, onMount, Show } from 'solid-js'
import { CountryIcon } from '../../lib/components/country-icon.tsx'
import { TextField, TextFieldFrame } from '../../lib/components/ui/text-field.tsx'
import { cn } from '../../lib/utils.ts'

interface ChosenCode {
  patterns?: string[]
  countryCode: string
  iso2: string
}

function mapCountryCode(country: tl.help.RawCountry, code: tl.help.RawCountryCode): ChosenCode {
  return {
    patterns: code.patterns,
    countryCode: code.countryCode,
    iso2: country.iso2,
  }
}

interface PhoneInputProps {
  class?: string
  phone?: string
  onChange?: (phone: string) => void
  onSubmit?: () => void
  client: BaseTelegramClient
  disabled?: boolean
  ref?: (el: HTMLInputElement) => void
}

export function PhoneInput(props: PhoneInputProps) {
  const [countriesList, setCountriesList] = createSignal<tl.help.RawCountry[]>([])
  const [chosenCode, setChosenCode] = createSignal<ChosenCode | undefined>()
  const [inputValue, setInputValue] = createSignal('+')

  onMount(() => {
    Promise.all([
      props.client.call({ _: 'help.getCountriesList', langCode: 'en', hash: 0 }),
      props.client.call({ _: 'help.getNearestDc' }),
    ]).then(([countriesList, nearestDc]) => {
      assert(countriesList._ === 'help.countriesList') // todo caching
      setCountriesList(countriesList.countries)

      if (inputValue() === '+') {
        // guess the country code
        for (const country of countriesList.countries) {
          if (country.iso2 === nearestDc.country.toUpperCase()) {
            setChosenCode(mapCountryCode(country, country.countryCodes[0]))
            setInputValue(`+${country.countryCodes[0].countryCode} `)
            break
          }
        }
      }
    })
  })

  const handleInput = (e: InputEvent) => {
    const el = e.currentTarget as HTMLInputElement
    const value = el.value

    if (value === '' || value === '+') {
      // country code was removed
      setInputValue('+')
      el.value = '+'
      setChosenCode(undefined)
      props.onChange?.('')
      return
    } else {
      setInputValue(value)
    }

    // try to find matching country code
    // first sanitize input
    const rawPhone = value.slice(1).replace(/\D/g, '')
    el.value = `+${value.replace(/[^\d ]/g, '')}`

    // pass 1: find matching countries by country code
    const matching: [tl.help.RawCountry, tl.help.RawCountryCode][] = []
    let hasPrefixes = false

    for (const country of countriesList()) {
      for (const code of country.countryCodes) {
        if (rawPhone.startsWith(code.countryCode)) {
          matching.push([country, code])
        }
        if (code.prefixes) {
          hasPrefixes = true
        }
      }
    }

    let chosenCode: ChosenCode | undefined

    // if we have a prefix in some of the items, try to find matching countries by prefix
    // (e.g. russia: +7<any>, kazakhstan: +77<any>)
    if (hasPrefixes && matching.length > 1) {
      // 1: find a match without a prefix
      let match = matching.find(it => it[1].prefixes === undefined)
      // 2: try to refine the match by prefix
      let foundByPrefix = false
      for (const item of matching) {
        const code = item[1]

        if (code.prefixes === undefined) continue
        for (const prefix of code.prefixes) {
          const fullPrefix = code.countryCode + prefix
          if (rawPhone.startsWith(fullPrefix)) {
            match = item
            foundByPrefix = true
            break
          }
        }
      }

      // 3: if we couldnt refine and the country code is the same as countryCode, do nothing
      if (!foundByPrefix && match && match[1].countryCode === rawPhone) {
        match = undefined
      }

      chosenCode = match ? mapCountryCode(match[0], match[1]) : undefined
    } else if (matching.length === 1) {
      chosenCode = mapCountryCode(matching[0][0], matching[0][1])
    }

    setChosenCode(chosenCode)
    props.onChange?.(rawPhone)

    if (chosenCode && chosenCode.patterns) {
      // format the number
      const numberWithoutCode = rawPhone.slice(chosenCode.countryCode.length)

      for (const pattern of chosenCode.patterns) {
        let numberIdx = 0
        let formatted = ''
        for (let i = 0; i < pattern.length; i++) {
          const patternChar = pattern[i]
          const numberChar = numberWithoutCode[numberIdx]
          if (numberChar === undefined) break

          if (patternChar.match(/\d/)) {
            // these patterns are not supported (yet?)
            break
          } else if (patternChar === ' ') {
            formatted += '-'
          } else if (patternChar === 'X') {
            formatted += numberChar
            numberIdx++
          } else {
            console.warn('Unexpected pattern char %s in %s', patternChar, pattern)
            break
          }
        }

        if (formatted && numberIdx === numberWithoutCode.length) {
          el.value = `+${chosenCode.countryCode} ${formatted}`
          break
        }
      }
    }
  }

  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && chosenCode() !== undefined) {
      props.onSubmit?.()
    }
  }

  return (
    <TextFieldFrame class={cn('flex items-center', props.class)}>
      <Show
        when={chosenCode()}
        fallback={(
          <div class="w-6">
            🏳️
          </div>
        )}
      >
        <CountryIcon class="mt-0.5 w-6 select-none" country={chosenCode()!.iso2} />
      </Show>
      <TextField
        class="ml-0.5 w-full"
        value={inputValue()}
        onInput={handleInput}
        onKeyPress={handleKeyPress}
        autocomplete="off"
        disabled={props.disabled}
        ref={props.ref}
      />
    </TextFieldFrame>
  )
}
