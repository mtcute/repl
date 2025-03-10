import type { VfsFile, VfsStorage } from './storage'
import { read, webReadableToFuman } from '@fuman/io'
import { asyncPool, AsyncQueue, utf8 } from '@fuman/utils'
import { ffetch } from '../utils/ffetch.ts'
import { GunzipStream } from './gzip.ts'
import { extractTar, type TarEntry } from './tar.ts'

const PACKAGES_TO_SKIP = new Set([
  '@mtcute/bun',
  '@mtcute/node',
  '@mtcute/crypto-node',
  '@mtcute/deno',
  '@mtcute/create-bot',
  '@mtcute/test',
])

export async function getLatestVersions() {
  const versions = await ffetch(`https://raw.githubusercontent.com/mtcute/mtcute/refs/heads/master/scripts/latest-versions.json?v=${Date.now()}`)
    .json<Record<string, string>>()

  for (const pkg of Object.keys(versions)) {
    if (PACKAGES_TO_SKIP.has(pkg)) {
      delete versions[pkg]
    }
  }
  return versions
}

export async function getPackagesToDownload(latestVersions: Record<string, string>, storage: VfsStorage) {
  const packages: Record<string, string> = {}

  const queue = new AsyncQueue<[string, string]>()
  const queued: [string, string][] = []

  for (const pkg of Object.keys(latestVersions)) {
    if (await storage.getExistingLibVersion(pkg) === latestVersions[pkg]) {
      if (pkg === '@mtcute/tl' && !localStorage.getItem('mtcute:tl-hotfix-200')) {
        // hotfix lol (todo remove once layer 201 is out)
        localStorage.setItem('mtcute:tl-hotfix-200', '1')
      } else {
        continue
      }
    }
    queue.enqueue([pkg, latestVersions[pkg]])
    queued.push([pkg, latestVersions[pkg]])
  }

  if (queue.queue.length === 0) return packages

  let fetched = 0
  let total = queue.queue.length

  await asyncPool(queue, async ([pkg, version]) => {
    let exactVersion: string
    if (version.match(/^\d+\.\d+\.\d+$/)) {
      // version is already exact
      exactVersion = version
    } else {
      const res = await ffetch(`https://data.jsdelivr.com/v1/packages/npm/${pkg}/resolved`, {
        query: { specifier: version },
      }).json<{ version: string }>()

      exactVersion = res.version
    }

    packages[pkg] = exactVersion

    const packageJson = await ffetch(`https://cdn.jsdelivr.net/npm/${pkg}@${exactVersion}/package.json`).json<{ dependencies?: Record<string, string> }>()

    for (const [dep, depVersion_] of Object.entries(packageJson.dependencies ?? {})) {
      const depVersion = depVersion_ as string

      if (queued.some(([pkg]) => pkg === dep)) {
        // already fetched/queued
        continue
      }

      queue.enqueue([dep, depVersion as string])
      queued.push([dep, depVersion as string])
      total += 1
    }

    fetched += 1

    if (fetched === total) {
      // we're done
      queue.end()
    }
  })

  return packages
}

function patchMtcuteTl(file: VfsFile) {
  if (!file.path.match(/\.(js|json)$/)) return
  // @mtcute/tl is currently commonjs-only, so we need to add some shims to make it work with esm
  // based on https://github.com/mtcute/mtcute/blob/master/packages/tl/scripts/build-package.ts
  let text = utf8.decoder.decode(file.contents)
  if (text.includes('export const')) {
    // future-proofing for when we eventually switch to esm
    return
  }

  switch (file.path) {
    case 'index.js': {
      text = [
        'const exports = {};',
        text,
        'export const tl = exports.tl;',
        'export const mtp = exports.mtp;',
      ].join('')
      break
    }
    case 'binary/reader.js': {
      text = [
        'const exports = {};',
        text,
        'export const __tlReaderMap = exports.__tlReaderMap;',
      ].join('')
      break
    }
    case 'compat/reader.js': {
      text = [
        'const exports = {};',
        text,
        'export const __tlReaderMapCompat = exports.__tlReaderMapCompat;',
      ].join('')
      break
    }
    case 'binary/writer.js': {
      text = [
        'const exports = {};',
        text,
        'export const __tlWriterMap = exports.__tlWriterMap;',
      ].join('')
      break
    }
    case 'binary/rsa-keys.js': {
      text = [
        'const exports = {};',
        text,
        'export const __publicKeyIndex = exports.__publicKeyIndex;',
      ].join('')
      break
    }
    case 'package.json': {
      const json = JSON.parse(text)
      json.exports = {
        '.': './index.js',
        './binary/reader.js': './binary/reader.js',
        './compat/reader.js': './compat/reader.js',
        './binary/writer.js': './binary/writer.js',
        './binary/rsa-keys.js': './binary/rsa-keys.js',
      }
      text = JSON.stringify(json, null, 2)
      break
    }
  }

  file.contents = utf8.encoder.encode(text)
}

export async function downloadNpmPackage(params: {
  packageName: string
  version: string
  storage: VfsStorage
  progress: (downloaded: number, total: number, file: string) => void
  filterFiles?: (file: TarEntry) => boolean
}) {
  const {
    packageName,
    version,
    storage,
    progress,
    filterFiles,
  } = params

  const tgzUrl = `https://registry.npmjs.org/${packageName}/-/${packageName.replace(/^.*?\//, '')}-${version}.tgz`

  const response = await fetch(tgzUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download: HTTP ${response.status}`)
  }

  const stream = webReadableToFuman(response.body)
  const gunzipStream = new GunzipStream(stream)

  const total = Number(response.headers.get('content-length') ?? 0)
  const files: VfsFile[] = []
  for await (const file of extractTar(gunzipStream)) {
    if (!file.content || file.header.type !== 'file') {
      continue
    }

    progress(gunzipStream.totalRead, total, file.header.name)

    if (filterFiles && !filterFiles(file)) {
      continue
    }

    const fileName = file.header.name.replace(/^package\//, '')
    const vfsFile: VfsFile = {
      path: fileName,
      contents: await read.async.untilEnd(file.content),
    }
    if (packageName === '@mtcute/tl') {
      patchMtcuteTl(vfsFile)
    }
    files.push(vfsFile)
  }

  await storage.writeLibrary(packageName, version, files)

  progress(total, total, 'Done!')
}
