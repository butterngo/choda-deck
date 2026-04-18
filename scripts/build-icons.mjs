#!/usr/bin/env node
// Generate branded icons from build/icon.svg:
//   build/icon.png       (1024x1024, Linux target + source for electron-builder)
//   build/icon.ico       (multi-size Windows icon: 16, 24, 32, 48, 64, 128, 256)
//   resources/icon.png   (512x512, used by src/main/index.ts as BrowserWindow icon fallback)
// Usage: node scripts/build-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const svgPath = join(root, 'build', 'icon.svg')
const buildPng = join(root, 'build', 'icon.png')
const buildIco = join(root, 'build', 'icon.ico')
const resourcesPng = join(root, 'resources', 'icon.png')

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

try {
  const svg = readFileSync(svgPath)
  console.log('[build-icons] reading', svgPath)

  await sharp(svg).resize(1024, 1024).png().toFile(buildPng)
  console.log('[build-icons] wrote', buildPng)

  await sharp(svg).resize(512, 512).png().toFile(resourcesPng)
  console.log('[build-icons] wrote', resourcesPng)

  const pngBuffers = await Promise.all(
    ICO_SIZES.map((size) => sharp(svg).resize(size, size).png().toBuffer())
  )
  const icoBuffer = await pngToIco(pngBuffers)
  writeFileSync(buildIco, icoBuffer)
  console.log('[build-icons] wrote', buildIco, `(${ICO_SIZES.join(',')} px)`)
} catch (err) {
  console.error('[build-icons] failed:', err)
  process.exit(1)
}
