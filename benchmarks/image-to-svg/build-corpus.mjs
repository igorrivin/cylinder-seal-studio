import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'

const CORPUS_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_DIR = resolve(CORPUS_DIR, '../..')
const FRAGMENTS_DIR = join(CORPUS_DIR, 'fragments')
const INPUT_DIR = join(CORPUS_DIR, 'inputs')
const REFERENCE_RENDER_DIR = join(CORPUS_DIR, 'reference-renders')
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json')
const SPLITS_PATH = join(CORPUS_DIR, 'splits', 'v1.json')
const ATTRIBUTIONS_PATH = join(CORPUS_DIR, 'ATTRIBUTIONS.md')
const RASTER_SIZE = 512
const CREATED_AT = '2026-07-22T00:00:00Z'
const ACCESSED_ON = '2026-07-22'
const CHECK_MODE = process.argv.includes('--check')

const EXPECTED_COUNTS = Object.freeze({ development: 24, validation: 8, test: 8 })
const PROFILE_QUOTAS = Object.freeze({
  clean: 20,
  pixelated: 5,
  softened: 5,
  'faint-scan': 5,
  speckled: 5,
})
const SPLIT_PROFILE_QUOTAS = Object.freeze({
  development: Object.freeze({ clean: 12, pixelated: 3, softened: 3, 'faint-scan': 3, speckled: 3 }),
  validation: Object.freeze({ clean: 4, pixelated: 1, softened: 1, 'faint-scan': 1, speckled: 1 }),
  test: Object.freeze({ clean: 4, pixelated: 1, softened: 1, 'faint-scan': 1, speckled: 1 }),
})
const LICENSE_POLICIES = Object.freeze({
  'CC0-1.0': Object.freeze({
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    redistributionAllowed: true,
    adaptationAllowed: true,
  }),
  ISC: Object.freeze({
    url: 'https://opensource.org/license/isc-license-txt',
    redistributionAllowed: true,
    adaptationAllowed: true,
  }),
  MIT: Object.freeze({
    url: 'https://opensource.org/license/mit',
    redistributionAllowed: true,
    adaptationAllowed: true,
  }),
})
const EXTERNAL_GROUP_SPLITS = Object.freeze({
  'lucide-lucide-icons-and-contributors': 'development',
  'open-doodles-pablo-stanley': 'validation',
  'openclipart-gdj': 'development',
  'openclipart-frankes': 'development',
  'openclipart-child-of-light': 'test',
  'openclipart-printerkiller': 'test',
  'openclipart-siddymcbill': 'test',
})
const CASE_SPLIT_OVERRIDES = Object.freeze({
  'procedural-007-leaf-sprig': 'development',
})
const BANNED_SVG = /<(?:audio|embed|filter|foreignObject|iframe|image|object|script|video)\b/i
const BANNED_SVG_MARKUP = /<!DOCTYPE|<!ENTITY|\son[a-z]+\s*=/i
const CRC_TABLE = makeCrcTable()

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function slashPath(path) {
  return path.split('\\').join('/')
}

function repositoryRelative(path) {
  const output = slashPath(relative(REPOSITORY_DIR, path))
  if (output === '..' || output.startsWith('../')) {
    throw new Error(`Artifact is outside the repository: ${path}`)
  }
  return output
}

function displayPath(path) {
  return repositoryRelative(path)
}

function makeCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function crc32(data) {
  let value = 0xffffffff
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function encodeRgbaPng(width, height, pixels) {
  if (pixels.length !== width * height * 4) {
    throw new Error(`Cannot encode ${pixels.length} RGBA bytes as ${width}×${height}.`)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const output = y * (stride + 1)
    raw[output] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, output + 1)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function canonicalViewport(svg) {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root || !/<\/svg\s*>/i.test(svg)) throw new Error('Missing complete SVG root element.')
  if (BANNED_SVG.test(svg)) throw new Error('SVG contains an unsafe or non-deterministic element.')
  if (BANNED_SVG_MARKUP.test(svg)) throw new Error('SVG contains unsafe active markup.')
  if (/@(?:font-face|import)\b|\burl\s*\(\s*["']?(?!#)/i.test(svg)) {
    throw new Error('SVG contains an external CSS resource.')
  }
  const references = [...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gis)].map(
    (match) => match[2],
  )
  if (references.some((reference) => !reference.startsWith('#'))) {
    throw new Error('SVG contains an external reference.')
  }
  const withoutDimensions = root.replace(
    /\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  )
  const replacement = withoutDimensions.replace(
    />$/,
    ` width="${RASTER_SIZE}" height="${RASTER_SIZE}">`,
  )
  return svg.replace(root, replacement)
}

function renderSvg(svg, sourcePath) {
  let rendered
  try {
    rendered = new Resvg(canonicalViewport(svg), {
      background: '#ffffff',
      shapeRendering: 2,
      font: { loadSystemFonts: false },
    }).render()
  } catch (error) {
    throw new Error(`Could not render ${sourcePath}: ${error instanceof Error ? error.message : error}`)
  }
  if (rendered.width !== RASTER_SIZE || rendered.height !== RASTER_SIZE) {
    throw new Error(`${sourcePath} rendered at ${rendered.width}×${rendered.height}.`)
  }
  const pixels = new Uint8ClampedArray(rendered.pixels)
  let darkPixels = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const luminance = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
    if (luminance < 224) darkPixels += 1
  }
  if (darkPixels < RASTER_SIZE) throw new Error(`${sourcePath} contains too little visible artwork.`)
  return { pixels, png: Buffer.from(rendered.asPng()), darkPixels }
}

function copyPixels(pixels) {
  return new Uint8ClampedArray(pixels)
}

function pixelate(pixels, blockSize = 4) {
  const output = copyPixels(pixels)
  for (let y = 0; y < RASTER_SIZE; y += blockSize) {
    for (let x = 0; x < RASTER_SIZE; x += blockSize) {
      const totals = [0, 0, 0]
      let samples = 0
      for (let dy = 0; dy < blockSize && y + dy < RASTER_SIZE; dy += 1) {
        for (let dx = 0; dx < blockSize && x + dx < RASTER_SIZE; dx += 1) {
          const offset = ((y + dy) * RASTER_SIZE + x + dx) * 4
          totals[0] += pixels[offset]
          totals[1] += pixels[offset + 1]
          totals[2] += pixels[offset + 2]
          samples += 1
        }
      }
      for (let dy = 0; dy < blockSize && y + dy < RASTER_SIZE; dy += 1) {
        for (let dx = 0; dx < blockSize && x + dx < RASTER_SIZE; dx += 1) {
          const offset = ((y + dy) * RASTER_SIZE + x + dx) * 4
          output[offset] = Math.round(totals[0] / samples)
          output[offset + 1] = Math.round(totals[1] / samples)
          output[offset + 2] = Math.round(totals[2] / samples)
          output[offset + 3] = 255
        }
      }
    }
  }
  return output
}

function soften(pixels) {
  const output = copyPixels(pixels)
  for (let y = 1; y < RASTER_SIZE - 1; y += 1) {
    for (let x = 1; x < RASTER_SIZE - 1; x += 1) {
      const totals = [0, 0, 0]
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const offset = ((y + dy) * RASTER_SIZE + x + dx) * 4
          totals[0] += pixels[offset]
          totals[1] += pixels[offset + 1]
          totals[2] += pixels[offset + 2]
        }
      }
      const offset = (y * RASTER_SIZE + x) * 4
      output[offset] = Math.round(totals[0] / 9)
      output[offset + 1] = Math.round(totals[1] / 9)
      output[offset + 2] = Math.round(totals[2] / 9)
      output[offset + 3] = 255
    }
  }
  return output
}

function randomGenerator(seedText) {
  let state = Number.parseInt(sha256(seedText).slice(0, 8), 16) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function faintScan(pixels, id) {
  const output = copyPixels(pixels)
  const random = randomGenerator(`${id}:faint-scan:v1`)
  for (let y = 0; y < RASTER_SIZE; y += 1) {
    const band = Math.sin((y / RASTER_SIZE) * Math.PI * 5) * 4
    for (let x = 0; x < RASTER_SIZE; x += 1) {
      const offset = (y * RASTER_SIZE + x) * 4
      const gray = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
      const noise = (random() - 0.5) * 12
      const value = Math.max(0, Math.min(255, Math.round(gray * 0.75 + 60 + band + noise)))
      output[offset] = value
      output[offset + 1] = value
      output[offset + 2] = Math.min(255, value + 2)
      output[offset + 3] = 255
    }
  }
  return output
}

function addSpeckles(pixels, id) {
  const output = copyPixels(pixels)
  const random = randomGenerator(`${id}:speckled:v1`)
  const speckles = Math.round(RASTER_SIZE * RASTER_SIZE * 0.003)
  for (let index = 0; index < speckles; index += 1) {
    const x = Math.floor(random() * RASTER_SIZE)
    const y = Math.floor(random() * RASTER_SIZE)
    const radius = random() < 0.85 ? 0 : 1
    const value = random() < 0.72 ? 24 : 245
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const px = x + dx
        const py = y + dy
        if (px < 0 || py < 0 || px >= RASTER_SIZE || py >= RASTER_SIZE) continue
        const offset = (py * RASTER_SIZE + px) * 4
        output[offset] = value
        output[offset + 1] = value
        output[offset + 2] = value
        output[offset + 3] = 255
      }
    }
  }
  return output
}

function applyProfile(pixels, profile, id) {
  if (profile === 'clean') return copyPixels(pixels)
  if (profile === 'pixelated') return pixelate(pixels)
  if (profile === 'softened') return soften(pixels)
  if (profile === 'faint-scan') return faintScan(pixels, id)
  if (profile === 'speckled') return addSpeckles(pixels, id)
  throw new Error(`Unknown raster profile: ${profile}`)
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonLines(path) {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : error}`)
      }
    })
}

function resolveSourcePath(sourcePath) {
  if (sourcePath.startsWith('benchmarks/')) return resolve(REPOSITORY_DIR, sourcePath)
  return resolve(CORPUS_DIR, sourcePath)
}

function normalizeLicense(row) {
  const license = typeof row.license === 'object' && row.license !== null ? row.license : {}
  const id = typeof row.license === 'string' ? row.license : license.id ?? license.spdx ?? row.licenseId
  const policy = LICENSE_POLICIES[id]
  if (!id || !policy) throw new Error(`${row.id}: unsupported license identifier ${id ?? '(missing)'}.`)
  const url = license.url ?? row.licenseUrl ?? policy.url
  if (!url) throw new Error(`${row.id}: license URL is required.`)
  return { ...policy, id, url }
}

function slug(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

function sourceGroup(row) {
  const family = row.sourceFamily ?? row.source_family
  if (family) return `${slug(family)}-${slug(row.creator ?? 'unknown')}`
  if ((row.sourceKind ?? row.source_kind) === 'procedural') return 'project-procedural'
  if ((row.sourceKind ?? row.source_kind) === 'model-assisted-existing-gold') {
    return 'project-existing-model-assisted-gold'
  }
  return `project-${slug(row.creator ?? 'unknown')}`
}

function normalizeSourceKind(kind) {
  if (kind === 'model-assisted-existing-gold') return 'model_assisted_existing_gold'
  return kind ?? 'external'
}

function caseCategories(tags) {
  const categoryTags = new Set([
    'abstract',
    'animal',
    'botanical',
    'character',
    'cuneiform',
    'frieze',
    'icon',
    'inscription',
    'object',
    'ornament',
    'scene',
    'vehicle',
  ])
  const categories = tags.filter((tag) => categoryTags.has(tag))
  return (categories.length > 0 ? categories : tags.slice(0, 1)).sort()
}

function normalizeFragment(row) {
  const id = row.id
  const sourcePath = row.sourcePath ?? row.source_path
  const sourceFamily = row.sourceFamily ?? row.source_family ?? null
  const groupId = sourceGroup(row)
  const suggestedSplit = row.splitSuggestion ?? row.split_suggestion ?? row.split
  const split = CASE_SPLIT_OVERRIDES[id] ?? EXTERNAL_GROUP_SPLITS[groupId] ?? suggestedSplit
  if (!id || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new Error(`Invalid case id: ${id}`)
  if (!row.title || !sourcePath) throw new Error(`${id}: title and sourcePath are required.`)
  if (!Object.hasOwn(EXPECTED_COUNTS, split)) throw new Error(`${id}: invalid split ${split}.`)
  const license = normalizeLicense(row)
  const trainingAllowed = row.trainingAllowed ?? row.training_allowed ?? false
  if (typeof trainingAllowed !== 'boolean') {
    throw new Error(`${id}: trainingAllowed must be a boolean.`)
  }
  if (trainingAllowed && !license.adaptationAllowed) {
    throw new Error(`${id}: training cannot be allowed when adaptation is forbidden.`)
  }
  const tags = [...new Set(row.tags ?? [])].sort()
  return {
    id,
    title: row.title,
    description: row.description ?? '',
    sourcePath,
    split,
    tags,
    sourceKind: normalizeSourceKind(row.sourceKind ?? row.source_kind),
    sourceTitle: row.sourceTitle ?? row.source_title ?? row.title,
    sourceFamily,
    sourceGroup: groupId,
    creator: row.creator ?? 'Unknown',
    sourcePageUrl: row.sourcePageUrl ?? row.source_page_url ?? row.pageUrl ?? null,
    directUrl:
      row.directAssetUrl ?? row.directUrl ?? row.direct_url ?? row.downloadUrl ?? null,
    accessedAt: row.accessDate ?? row.accessedAt ?? row.accessed_at ?? ACCESSED_ON,
    attribution:
      row.attribution
      ?? [row.copyrightNotice, `${row.creator ?? 'Unknown'} — ${row.title}`]
        .filter(Boolean)
        .join('; '),
    license,
    licenseEvidenceUrl: row.licenseEvidenceUrl ?? row.license_evidence_url ?? null,
    adaptation: row.adaptation ?? null,
    originalSha256: row.originalSha256 ?? row.original_sha256 ?? null,
    expectedSourceSha256: row.sanitizedSha256 ?? row.sanitized_sha256 ?? null,
    trainingAllowed,
    trainingNotes: row.trainingNotes ?? row.training_notes ?? null,
  }
}

async function loadFragments() {
  const files = (await readdir(FRAGMENTS_DIR))
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
  if (files.length < 2) throw new Error('Expected procedural and external manifest fragments.')
  const rows = []
  for (const file of files) rows.push(...(await readJsonLines(join(FRAGMENTS_DIR, file))))
  rows.push({
    id: 'existing-easter-bunny-gold',
    title: 'Existing Easter bunny semantic gold',
    sourcePath: 'benchmarks/svg-gold/gold-standard.svg',
    tags: ['dense', 'existing-gold', 'multi-object', 'ornament', 'repeated-motif'],
    splitSuggestion: 'development',
    license: { id: 'MIT', url: 'https://opensource.org/license/mit' },
    creator: 'Cylinder Seal Studio contributors with OpenAI Codex assistance',
    sourceKind: 'model-assisted-existing-gold',
    trainingAllowed: false,
    trainingNotes: 'Evaluation-only unless provider-output training rights are separately cleared.',
  })
  return rows.map(normalizeFragment)
}

function assignProfiles(rows) {
  const assignments = new Map()
  for (const [split, quotas] of Object.entries(SPLIT_PROFILE_QUOTAS)) {
    const splitRows = rows
      .filter((row) => row.split === split)
      .sort((left, right) => sha256(`profile-case:${left.id}`).localeCompare(sha256(`profile-case:${right.id}`)))
    const slots = Object.entries(quotas)
      .flatMap(([profile, count]) =>
        Array.from({ length: count }, (_, index) => ({
          profile,
          key: sha256(`profile-slot:${split}:${profile}:${index}`),
        })),
      )
      .sort((left, right) => left.key.localeCompare(right.key))

    const existingIndex = splitRows.findIndex((row) => row.id === 'existing-easter-bunny-gold')
    if (existingIndex >= 0) {
      const [existing] = splitRows.splice(existingIndex, 1)
      const cleanIndex = slots.findIndex((slot) => slot.profile === 'clean')
      if (cleanIndex < 0) throw new Error(`${split}: no clean profile slot for existing gold.`)
      slots.splice(cleanIndex, 1)
      assignments.set(existing.id, 'clean')
    }
    if (splitRows.length !== slots.length) {
      throw new Error(`${split}: ${splitRows.length} cases cannot fill ${slots.length} profile slots.`)
    }
    for (let index = 0; index < splitRows.length; index += 1) {
      assignments.set(splitRows[index].id, slots[index].profile)
    }
  }
  return assignments
}

function difficulty(tags, profile) {
  if (profile === 'faint-scan' || tags.some((tag) => ['dense', 'historical', 'noisy'].includes(tag))) {
    return 'hard'
  }
  if (profile === 'clean' && tags.some((tag) => ['icon', 'simple', 'silhouette'].includes(tag))) {
    return 'easy'
  }
  return 'medium'
}

function splitSummary(cases) {
  const result = { development: [], validation: [], test: [] }
  for (const item of cases) result[item.split].push(item.id)
  for (const ids of Object.values(result)) ids.sort()
  return result
}

function attributionsMarkdown(cases) {
  const external = cases.filter((item) =>
    ['external', 'open_license', 'public_domain'].includes(item.source.kind),
  )
  const entries = external
    .map((item) => {
      const sourceLink = item.source.page_url ? `[source](${item.source.page_url})` : 'source retained in repository'
      return `- **${item.title}** — ${item.rights.attribution}; ${item.rights.license_spdx} ([license](${item.rights.license_url})); ${sourceLink}; accessed ${item.source.accessed_at}.`
    })
    .join('\n')
  return `# Benchmark asset attributions

This file covers externally sourced assets in corpus version 1. The complete ISC notice required for the Lucide sources is retained in [sources/external/LUCIDE-LICENSE.txt](sources/external/LUCIDE-LICENSE.txt). Procedural fixtures are deterministic project test geometry created with coding-agent assistance, and both they and the existing semantic gold are conservatively marked evaluation-only for model training.

${entries}
`
}

async function materializeCase(row, profile) {
  const absoluteSource = resolveSourcePath(row.sourcePath)
  if (!(await pathExists(absoluteSource))) throw new Error(`${row.id}: missing ${absoluteSource}`)
  const sourceBytes = await readFile(absoluteSource)
  const sourceSha256 = sha256(sourceBytes)
  if (row.expectedSourceSha256 && row.expectedSourceSha256 !== sourceSha256) {
    throw new Error(
      `${row.id}: retained source hash ${sourceSha256} does not match fragment ${row.expectedSourceSha256}.`,
    )
  }
  const sourceSvg = sourceBytes.toString('utf8')
  const reference = renderSvg(sourceSvg, row.sourcePath)
  const inputPixels = applyProfile(reference.pixels, profile, row.id)
  const inputPng = profile === 'clean' ? reference.png : encodeRgbaPng(RASTER_SIZE, RASTER_SIZE, inputPixels)
  const inputPath = join(INPUT_DIR, `${row.id}.png`)
  const referenceRenderPath = join(REFERENCE_RENDER_DIR, `${row.id}.png`)

  const caseRecord = {
    id: row.id,
    title: row.title,
    split: row.split,
    split_frozen: true,
    categories: caseCategories(row.tags),
    tags: row.tags,
    difficulty: difficulty(row.tags, profile),
    input: {
      path: repositoryRelative(inputPath),
      media_type: 'image/png',
      sha256: sha256(inputPng),
      dimensions: { width: RASTER_SIZE, height: RASTER_SIZE, unit: 'px' },
      bytes: inputPng.length,
      profile,
      profile_version: '1.0.0',
    },
    reference: {
      kind: row.sourceKind === 'model_assisted_existing_gold' ? 'expert_reconstruction' : 'vector_oracle',
      path: repositoryRelative(absoluteSource),
      sha256: sourceSha256,
      media_type: 'image/svg+xml',
      dimensions: { width: RASTER_SIZE, height: RASTER_SIZE, unit: 'viewBox' },
      bytes: sourceBytes.length,
      render: {
        path: repositoryRelative(referenceRenderPath),
        sha256: sha256(reference.png),
        media_type: 'image/png',
        dimensions: { width: RASTER_SIZE, height: RASTER_SIZE, unit: 'px' },
        bytes: reference.png.length,
      },
    },
    source: {
      kind: row.sourceKind,
      title: row.sourceTitle,
      creator: row.creator,
      group_id: row.sourceGroup,
      page_url: row.sourcePageUrl,
      direct_url: row.directUrl,
      accessed_at: row.accessedAt,
      sha256: row.originalSha256 ?? sourceSha256,
      transformation: row.adaptation,
    },
    rights: {
      license_spdx: row.license.id,
      license_url: row.license.url,
      attribution: row.attribution,
      license_evidence_url: row.licenseEvidenceUrl ?? row.license.url,
      redistribution_allowed: row.license.redistributionAllowed,
      adaptation_allowed: row.license.adaptationAllowed,
      training_allowed: row.trainingAllowed,
      notes: row.trainingNotes ?? '',
    },
    notes: row.description,
  }
  return { caseRecord, inputPath, inputPng, referenceRenderPath, referencePng: reference.png }
}

function validateCorpus(cases) {
  if (cases.length !== 40) throw new Error(`Expected exactly 40 cases; found ${cases.length}.`)
  const ids = new Set()
  const counts = { development: 0, validation: 0, test: 0 }
  const externalGroupSplits = new Map()
  const profiles = Object.fromEntries(Object.keys(PROFILE_QUOTAS).map((profile) => [profile, 0]))
  const splitProfiles = Object.fromEntries(
    Object.keys(SPLIT_PROFILE_QUOTAS).map((split) => [
      split,
      Object.fromEntries(Object.keys(PROFILE_QUOTAS).map((profile) => [profile, 0])),
    ]),
  )
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate case id: ${item.id}`)
    ids.add(item.id)
    counts[item.split] += 1
    profiles[item.input.profile] += 1
    splitProfiles[item.split][item.input.profile] += 1
    if (['external', 'open_license', 'public_domain'].includes(item.source.kind)) {
      const priorSplit = externalGroupSplits.get(item.source.group_id)
      if (priorSplit && priorSplit !== item.split) {
        throw new Error(
          `External source group ${item.source.group_id} crosses ${priorSplit} and ${item.split}.`,
        )
      }
      externalGroupSplits.set(item.source.group_id, item.split)
    }
  }
  for (const [split, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (counts[split] !== expected) throw new Error(`Expected ${expected} ${split} cases; found ${counts[split]}.`)
  }
  for (const [profile, expected] of Object.entries(PROFILE_QUOTAS)) {
    if (profiles[profile] !== expected) throw new Error(`Expected ${expected} ${profile} cases; found ${profiles[profile]}.`)
  }
  for (const [split, quotas] of Object.entries(SPLIT_PROFILE_QUOTAS)) {
    for (const [profile, expected] of Object.entries(quotas)) {
      const actual = splitProfiles[split][profile]
      if (actual !== expected) {
        throw new Error(`Expected ${expected} ${split}/${profile} cases; found ${actual}.`)
      }
    }
  }
}

async function writeOrCheck(path, content) {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)
  if (CHECK_MODE) {
    let current
    try {
      current = await readFile(path)
    } catch {
      throw new Error(`Missing generated corpus artifact: ${displayPath(path)}`)
    }
    if (!current.equals(bytes)) throw new Error(`Stale generated corpus artifact: ${displayPath(path)}`)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function rejectUnexpectedPngs(directory, expectedIds) {
  if (!(await pathExists(directory))) return
  const files = (await readdir(directory)).filter((file) => file.endsWith('.png'))
  const unexpected = files.filter((file) => !expectedIds.has(basename(file, '.png')))
  if (unexpected.length > 0) {
    throw new Error(`Unexpected generated files in ${displayPath(directory)}: ${unexpected.join(', ')}`)
  }
}

async function main() {
  const rows = await loadFragments()
  const profiles = assignProfiles(rows)
  const materialized = []
  for (const row of rows.sort((left, right) => left.id.localeCompare(right.id))) {
    materialized.push(await materializeCase(row, profiles.get(row.id)))
  }
  const cases = materialized.map((item) => item.caseRecord)
  validateCorpus(cases)
  const splits = splitSummary(cases)
  const manifest = {
    schema_version: '1.0.0',
    corpus: {
      id: 'cylinder-seal-image-to-svg',
      version: '1.0.0',
      title: 'Cylinder Seal Studio image-to-SVG evaluation corpus',
      description: 'Rights-tracked vector-oracle and expert-reconstruction cases for evaluating semantic raster-to-SVG systems.',
      created_at: CREATED_AT,
      case_count: cases.length,
    },
    split_policy: {
      strategy: 'frozen',
      frozen_at: CREATED_AT,
      test_is_sealed: true,
      counts: EXPECTED_COUNTS,
    },
    cases,
  }
  const splitManifest = {
    schema_version: '1.0.0',
    corpus_id: manifest.corpus.id,
    corpus_version: manifest.corpus.version,
    frozen_at: CREATED_AT,
    policy: manifest.split_policy,
    ...splits,
  }

  await Promise.all([
    ...materialized.flatMap((item) => [
      writeOrCheck(item.inputPath, item.inputPng),
      writeOrCheck(item.referenceRenderPath, item.referencePng),
    ]),
    writeOrCheck(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`),
    writeOrCheck(SPLITS_PATH, `${JSON.stringify(splitManifest, null, 2)}\n`),
    writeOrCheck(ATTRIBUTIONS_PATH, attributionsMarkdown(cases)),
  ])

  const expectedIds = new Set(cases.map((item) => item.id))
  await Promise.all([
    rejectUnexpectedPngs(INPUT_DIR, expectedIds),
    rejectUnexpectedPngs(REFERENCE_RENDER_DIR, expectedIds),
  ])
  const trainingAllowed = cases.filter((item) => item.rights.training_allowed).length
  const action = CHECK_MODE ? 'Validated' : 'Built'
  console.log(`${action} ${cases.length} cases (${trainingAllowed} training-rights-cleared; 24/8/8 frozen splits).`)
}

await main()
