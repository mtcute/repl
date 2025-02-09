import type { PolymorphicProps } from '@kobalte/core/polymorphic'
import type { ValidComponent } from 'solid-js'
import * as ImagePrimitive from '@kobalte/core/image'
import { splitProps } from 'solid-js'

import { cn } from '../../utils'

type AvatarRootProps<T extends ValidComponent = 'span'> = ImagePrimitive.ImageRootProps<T> & {
  class?: string | undefined
}

function Avatar<T extends ValidComponent = 'span'>(props: PolymorphicProps<T, AvatarRootProps<T>>) {
  const [local, others] = splitProps(props as AvatarRootProps, ['class'])
  return (
    <ImagePrimitive.Root
      class={cn('relative flex size-10 shrink-0 overflow-hidden rounded-full', local.class)}
      {...others}
    />
  )
}

type AvatarImageProps<T extends ValidComponent = 'img'> = ImagePrimitive.ImageImgProps<T> & {
  class?: string | undefined
}

function AvatarImage<T extends ValidComponent = 'img'>(props: PolymorphicProps<T, AvatarImageProps<T>>) {
  const [local, others] = splitProps(props as AvatarImageProps, ['class'])
  return <ImagePrimitive.Img class={cn('aspect-square size-full object-cover', local.class)} {...others} />
}

type AvatarFallbackProps<T extends ValidComponent = 'span'> =
  ImagePrimitive.ImageFallbackProps<T> & { class?: string | undefined }

function AvatarFallback<T extends ValidComponent = 'span'>(props: PolymorphicProps<T, AvatarFallbackProps<T>>) {
  const [local, others] = splitProps(props as AvatarFallbackProps, ['class'])
  return (
    <ImagePrimitive.Fallback
      class={cn('flex size-full items-center justify-center rounded-full bg-muted', local.class)}
      {...others}
    />
  )
}

export function makeAvatarFallbackText(displayName: string) {
  let res = ''
  const words = displayName.split(' ')
  res += [...words[0]][0]
  if (words.length > 1) {
    res += ` ${[...words[1]][0]}`
  }
  return res
}

export { Avatar, AvatarFallback, AvatarImage }
