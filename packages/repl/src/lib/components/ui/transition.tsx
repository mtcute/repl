import type { JSX } from 'solid-js'
import { Transition } from 'solid-transition-group'

// solid-transition-group relies on transitionend/animationend to advance state;
// transition-none would stall mode="outin" forever, so bypass entirely.
const prefersReducedMotion = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function TransitionSlideLtr(props: { mode?: 'outin' | 'inout', onAfterExit?: (element: Element) => void, children: JSX.Element }) {
  if (prefersReducedMotion) {
    return <>{props.children}</>
  }
  return (
    <Transition
      mode={props.mode}
      enterActiveClass="transition-[transform,opacity] duration-150 ease-in-out"
      exitActiveClass="transition-[transform,opacity] duration-150 ease-in-out"
      enterClass="translate-x-5 opacity-0"
      exitToClass="-translate-x-5 opacity-0"
      onAfterExit={props.onAfterExit}
    >
      {props.children}
    </Transition>
  )
}
