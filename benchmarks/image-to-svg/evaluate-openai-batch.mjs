import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { env } from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { BinaryImageConverter } from 'vectortracer'

const SIZE = 512
const REFERENCE_THRESHOLD = 170
const CANDIDATE_THRESHOLD = 128
const MODEL_ID = 'gpt-5.6-sol'
const REASONING_EFFORT = 'high'
const MAX_OUTPUT_TOKENS = 65_536
const ENDPOINT = '/v1/responses'
const API_BASE = 'https://api.openai.com/v1'
const COMPLETION_WINDOW = '24h'
const PRICING_URL = 'https://developers.openai.com/api/docs/guides/batch'
const TERMS_URL = 'https://openai.com/policies/services-agreement/'
const BATCH_INPUT_USD_PER_MILLION = 2.5
const BATCH_CACHED_INPUT_USD_PER_MILLION = 0.25
const BATCH_OUTPUT_USD_PER_MILLION = 15
const DIRECT_PIPELINE = 'openai-gpt-5.6-sol-one-shot'
const HYBRID_PIPELINE = 'openai-gpt-5.6-sol-hybrid-refactor'
const PIPELINE_VERSION = '1.0.1'
const PILOT_CASES = [
  'procedural-003-flying-bird',
  'external-openclipart-rabbit-line-art',
  'existing-easter-bunny-gold',
]
const TRACE_SETTINGS = Object.freeze({
  mode: 'spline',
  filterSpeckle: 16,
  segmentLength: 5,
  cornerThresholdDegrees: 45,
  spliceThresholdDegrees: 45,
  maxIterations: 10,
  pathPrecision: 2,
})
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'line',
  'rect',
])
const DIRECT_SYSTEM_PROMPT = 'You are an expert vector illustrator reconstructing fabrication-ready monochrome artwork from a raster reference.'
const DIRECT_USER_PROMPT = `Recreate the attached monochrome line-art image as a clean, editable, self-contained SVG. Infer the intended vector design rather than tracing antialiased pixels or noise. Preserve every distinct object, its placement, proportions, overlaps, repeated motifs, line-weight hierarchy, silhouettes, negative spaces, and any artwork crossing an image edge. Use viewBox="0 0 512 512", explicit black fills or strokes, and only basic SVG geometry such as paths, groups, circles, ellipses, polygons, polylines, lines, and rectangles. Prefer smooth, economical geometry, but do not omit meaningful small details. Do not embed the raster, use text, scripts, external resources, CSS, filters, gradients, masks, clip paths, or reusable external definitions. Return only one complete <svg xmlns="http://www.w3.org/2000/svg">...</svg> document, with no Markdown or explanation.`
const HYBRID_SYSTEM_PROMPT = 'You are an expert SVG refactoring engineer preserving fabrication geometry exactly while simplifying editable monochrome artwork.'
const FALLBACK_USER_PROMPT = 'Retain the exact production classical trace because the model refactor failed one or more hard acceptance gates.'

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_DIR = join(BENCHMARK_DIR, '..', '..')
const MANIFEST_PATH = join(BENCHMARK_DIR, 'manifest.json')
const BASELINE_PATH = join(BENCHMARK_DIR, 'baseline', 'report.json')
const RUNS_DIR = join(BENCHMARK_DIR, 'runs')
const BATCHES_DIR = join(RUNS_DIR, 'batches')
const SUMMARIES_DIR = join(RUNS_DIR, 'summaries')
const SCHEMA_PATH = join(BENCHMARK_DIR, 'run-record.schema.json')
const DEFAULT_ENV_PATH = join(REPOSITORY_DIR, '..', '..', 'heretic', '.env')

function usage() {
  return `Usage:
  node benchmarks/image-to-svg/evaluate-openai-batch.mjs prepare
  node benchmarks/image-to-svg/evaluate-openai-batch.mjs submit [--batch <local-id>]
  node benchmarks/image-to-svg/evaluate-openai-batch.mjs status [--batch <local-id>]
  node benchmarks/image-to-svg/evaluate-openai-batch.mjs collect [--batch <local-id>]
  node benchmarks/image-to-svg/evaluate-openai-batch.mjs rescore [--batch <local-id>]

The fixed pilot sends six gpt-5.6-sol requests in one Batch job: the exact
three-case Gemini one-shot comparison plus three trace-constrained refactors.
The test split is never selected. OPENAI_API_KEY is read from the environment,
or from the sibling heretic/.env file without copying it into this repository.
`
}

function parseArgs(argv) {
  const options = { command: argv[0], batch: null }
  if (!options.command || options.command === '--help' || options.command === 'help') {
    return { ...options, help: true }
  }
  if (!['prepare', 'submit', 'status', 'collect', 'rescore'].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`)
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--batch') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('--batch requires a local batch ID.')
      options.batch = value
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }
  return options
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function promptHash(system, user) {
  return createHash('sha256').update(system).update('\0').update(user).digest('hex')
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').toLowerCase()
}

function repositoryPath(path) {
  return relative(REPOSITORY_DIR, path).split('\\').join('/')
}

function artifact(path, bytes, mediaType) {
  return {
    path: repositoryPath(path),
    sha256: sha256(bytes),
    media_type: mediaType,
    bytes: bytes.byteLength,
  }
}

function benchmarkArtifact(source) {
  return {
    path: source.path,
    sha256: source.sha256,
    media_type: source.media_type,
    bytes: source.bytes,
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

async function writeNew(path, bytes) {
  await writeFile(path, bytes, { flag: 'wx' })
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function parseEnvValue(contents, name) {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = normalized.indexOf('=')
    if (separator < 1 || normalized.slice(0, separator).trim() !== name) continue
    let value = normalized.slice(separator + 1).trim()
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    return value
  }
  return null
}

async function openAiApiKey() {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY
  let contents
  try {
    contents = await readFile(DEFAULT_ENV_PATH, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`OPENAI_API_KEY is not set and ${DEFAULT_ENV_PATH} does not exist.`)
    }
    throw error
  }
  const value = parseEnvValue(contents, 'OPENAI_API_KEY')
  if (!value) throw new Error(`OPENAI_API_KEY is missing from ${DEFAULT_ENV_PATH}.`)
  return value
}

async function apiJson(path, apiKey, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(180_000),
  })
  const bodyText = await response.text()
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    body = { unparseable_response: bodyText }
  }
  if (!response.ok) {
    const message = body?.error?.message ?? bodyText.slice(0, 500) ?? `HTTP ${response.status}`
    throw new Error(`OpenAI API request failed (${response.status} ${path}): ${message}`)
  }
  return body
}

async function apiFile(path, apiKey) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) {
    const bodyText = await response.text()
    throw new Error(`OpenAI file download failed (${response.status} ${path}): ${bodyText.slice(0, 500)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function gitState() {
  const run = promisify(execFile)
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_DIR }),
    run('git', ['status', '--porcelain'], { cwd: REPOSITORY_DIR }),
  ])
  return { commit: commit.trim(), dirty: status.trim().length > 0 }
}

async function packageVersion(name) {
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_DIR, 'node_modules', name, 'package.json'), 'utf8'))
  return packageJson.version
}

function luminance(pixels, pixel) {
  const offset = pixel * 4
  return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
}

function decodePng(png) {
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="100%" height="100%" fill="#fff"/><image width="${SIZE}" height="${SIZE}" href="${dataUrl}"/></svg>`
  const rendered = new Resvg(wrapper, { background: '#ffffff', shapeRendering: 2 }).render()
  if (rendered.width !== SIZE || rendered.height !== SIZE) {
    throw new Error(`PNG decoder produced ${rendered.width}x${rendered.height}.`)
  }
  return {
    pixels: new Uint8ClampedArray(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
  }
}

function thresholdRaster(raster, cutoff) {
  const pixels = new Uint8ClampedArray(raster.pixels.length)
  for (let pixel = 0; pixel < raster.width * raster.height; pixel += 1) {
    const value = luminance(raster.pixels, pixel) < cutoff ? 0 : 255
    const offset = pixel * 4
    pixels[offset] = value
    pixels[offset + 1] = value
    pixels[offset + 2] = value
    pixels[offset + 3] = 255
  }
  return { ...raster, pixels }
}

function toImageData(raster) {
  return {
    data: new Uint8ClampedArray(raster.pixels),
    width: raster.width,
    height: raster.height,
    colorSpace: 'srgb',
  }
}

function traceImageData(imageData) {
  const degreesToRadians = (value) => (value * Math.PI) / 180
  const converter = new BinaryImageConverter(imageData, {
    debug: false,
    mode: TRACE_SETTINGS.mode,
    cornerThreshold: degreesToRadians(TRACE_SETTINGS.cornerThresholdDegrees),
    lengthThreshold: TRACE_SETTINGS.segmentLength,
    maxIterations: TRACE_SETTINGS.maxIterations,
    spliceThreshold: degreesToRadians(TRACE_SETTINGS.spliceThresholdDegrees),
    filterSpeckle: TRACE_SETTINGS.filterSpeckle,
    pathPrecision: TRACE_SETTINGS.pathPrecision,
  }, {
    invert: false,
    pathFill: '#000000',
    backgroundColor: 'transparent',
    attributes: '',
    scale: 1,
  })
  let rawSvg
  try {
    converter.init()
    const maxTicks = imageData.width * imageData.height + 1
    let ticks = 0
    while (!converter.tick()) {
      ticks += 1
      if (ticks > maxTicks) throw new Error('SVG tracer exceeded its iteration safety limit.')
    }
    rawSvg = converter.getResult()
  } catch (error) {
    try {
      converter.free()
    } catch {
      // A panicked WASM converter is discarded.
    }
    throw error
  }
  converter.free()
  return rawSvg
}

function formatNumber(value) {
  return value.toFixed(6).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1')
}

function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))
  return match?.[2]?.trim() ?? null
}

function styleValue(tag, name) {
  const style = attributeValue(tag, 'style')
  if (!style) return null
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    if (declaration.slice(0, colon).trim().toLowerCase() === name) {
      return declaration.slice(colon + 1).trim()
    }
  }
  return null
}

function isWhite(color) {
  if (!color) return false
  const normalized = color.toLowerCase().replace(/\s+/g, '')
  if (normalized === 'white' || normalized === '#fff' || normalized === '#ffffff') return true
  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (!rgb) return false
  const channels = rgb[1].split(',').slice(0, 3)
  return channels.length === 3 && channels.every((channel) => channel === '255' || channel === '100%')
}

function removeStrokeAttributes(path) {
  let cleaned = path.replace(/\s+stroke(?:-[\w:-]+)?\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  cleaned = cleaned.replace(/\s+style\s*=\s*(["'])(.*?)\1/gi, (_match, quote, style) => {
    const retained = style
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration && !/^stroke(?:-[\w-]+)?\s*:/i.test(declaration))
    return retained.length > 0 ? ` style=${quote}${retained.join(';')}${quote}` : ''
  })
  return cleaned
}

function compactPath(path) {
  return removeStrokeAttributes(path).replace(/\s+/g, ' ').replace(/\s*\/>\s*$/, '/>').trim()
}

function formatFlatSvg(rawSvg, widthPx, heightPx, widthMm, heightMm) {
  for (const [value, label] of [[widthPx, 'SVG source width'], [heightPx, 'SVG source height'], [widthMm, 'SVG physical width'], [heightMm, 'SVG physical height']]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number.`)
  }
  const root = rawSvg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/i)
  if (!root) throw new Error('Tracer output does not contain a complete SVG root element.')
  const paths = root[1].match(/<path\b[^>]*(?:\/>|>[\s\S]*?<\/path\s*>)/gi) ?? []
  const foregroundPaths = paths
    .filter((path) => !isWhite(attributeValue(path, 'fill') ?? styleValue(path, 'fill')))
    .map(compactPath)
  const body = foregroundPaths.length > 0 ? `\n  ${foregroundPaths.join('\n  ')}\n` : '\n'
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(widthMm)}mm" height="${formatNumber(heightMm)}mm" viewBox="0 0 ${formatNumber(widthPx)} ${formatNumber(heightPx)}" preserveAspectRatio="none">${body}</svg>\n`
}

function forceRenderSize(svg) {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root) throw new Error('Candidate SVG has no root element.')
  const resized = root
    .replace(/\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/>$/, ` width="${SIZE}" height="${SIZE}">`)
  return svg.replace(root, resized)
}

function renderSvg(svg) {
  const rendered = new Resvg(forceRenderSize(svg), {
    background: '#ffffff',
    shapeRendering: 2,
  }).render()
  if (rendered.width !== SIZE || rendered.height !== SIZE) {
    throw new Error(`SVG rendered at ${rendered.width}x${rendered.height}, expected ${SIZE}x${SIZE}.`)
  }
  return {
    png: rendered.asPng(),
    pixels: new Uint8ClampedArray(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
  }
}

function compareRasters(reference, candidate) {
  if (reference.width !== SIZE || reference.height !== SIZE || candidate.width !== SIZE || candidate.height !== SIZE) {
    throw new Error('Metric comparison requires two 512x512 rasters.')
  }
  let intersection = 0
  let union = 0
  let referenceForeground = 0
  let candidateForeground = 0
  let disagreement = 0
  let falsePositivePixels = 0
  let falseNegativePixels = 0
  let grayscaleDifference = 0
  const referenceMask = new Uint8Array(SIZE * SIZE)
  const candidateMask = new Uint8Array(SIZE * SIZE)
  for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
    const referenceLuminance = luminance(reference.pixels, pixel)
    const candidateLuminance = luminance(candidate.pixels, pixel)
    const wanted = referenceLuminance < REFERENCE_THRESHOLD
    const received = candidateLuminance < CANDIDATE_THRESHOLD
    referenceMask[pixel] = wanted ? 1 : 0
    candidateMask[pixel] = received ? 1 : 0
    if (wanted) referenceForeground += 1
    if (received) candidateForeground += 1
    if (wanted && received) intersection += 1
    if (wanted || received) union += 1
    if (wanted !== received) disagreement += 1
    if (!wanted && received) falsePositivePixels += 1
    if (wanted && !received) falseNegativePixels += 1
    grayscaleDifference += Math.abs(referenceLuminance - candidateLuminance) / 255
  }
  if (referenceForeground === 0 || candidateForeground === 0 || union === 0) {
    throw new Error('Metric comparison requires foreground in both rasters.')
  }
  const near = (mask, pixel, radius = 2) => {
    const x = pixel % SIZE
    const y = Math.floor(pixel / SIZE)
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      const candidateY = y + offsetY
      if (candidateY < 0 || candidateY >= SIZE) continue
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue
        const candidateX = x + offsetX
        if (candidateX >= 0 && candidateX < SIZE && mask[candidateY * SIZE + candidateX]) return true
      }
    }
    return false
  }
  let tolerantMatchesFromCandidate = 0
  let tolerantMatchesFromReference = 0
  for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
    if (candidateMask[pixel] && near(referenceMask, pixel)) tolerantMatchesFromCandidate += 1
    if (referenceMask[pixel] && near(candidateMask, pixel)) tolerantMatchesFromReference += 1
  }
  const tolerantPrecision = tolerantMatchesFromCandidate / candidateForeground
  const tolerantRecall = tolerantMatchesFromReference / referenceForeground
  const tolerantF1 = tolerantPrecision + tolerantRecall === 0
    ? 0
    : (2 * tolerantPrecision * tolerantRecall) / (tolerantPrecision + tolerantRecall)
  return {
    metric_version: '1.0.0',
    iou: intersection / union,
    precision: intersection / candidateForeground,
    recall: intersection / referenceForeground,
    disagreement: disagreement / (SIZE * SIZE),
    grayscale_mae: grayscaleDifference / (SIZE * SIZE),
    false_positive_pixels: falsePositivePixels,
    false_negative_pixels: falseNegativePixels,
    reference_foreground_pixels: referenceForeground,
    candidate_foreground_pixels: candidateForeground,
    tolerant_precision_2px: tolerantPrecision,
    tolerant_recall_2px: tolerantRecall,
    tolerant_f1_2px: tolerantF1,
  }
}

function extractSvg(output) {
  const starts = [...output.matchAll(/<svg\b/gi)]
  const ends = [...output.matchAll(/<\/svg\s*>/gi)]
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`Expected exactly one SVG document; found ${starts.length} opening and ${ends.length} closing roots.`)
  }
  const start = starts[0].index
  const end = ends[0].index + ends[0][0].length
  return {
    svg: output.slice(start, end),
    hadExtraneousText: output.slice(0, start).trim().length > 0 || output.slice(end).trim().length > 0,
  }
}

function validateSvg(svg, hadExtraneousText) {
  const failures = []
  const error = (code, message) => failures.push({ code, severity: 'error', message })
  const warning = (code, message) => failures.push({ code, severity: 'warning', message })
  if (Buffer.byteLength(svg) > 2_000_000) error('svg_too_large', 'Candidate SVG exceeds the 2 MB safety limit.')
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) error('xml_entity', 'DOCTYPE and entity declarations are forbidden.')
  if (/<\?(?:php|xml-stylesheet)\b/i.test(svg)) error('processing_instruction', 'Processing instructions are forbidden.')
  if (/\son[a-z][\w:-]*\s*=/i.test(svg)) error('event_handler', 'Event-handler attributes are forbidden.')
  if (/\s(?:href|xlink:href)\s*=/i.test(svg)) error('linked_resource', 'Linked resources are forbidden.')
  if (/\sstyle\s*=|url\s*\(/i.test(svg)) error('css_resource', 'CSS and URL-valued presentation are forbidden.')
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, '')
  const elementMatches = [...withoutComments.matchAll(/<\s*(\/?)\s*([a-z][\w:.-]*)\b/gi)]
  const allElements = elementMatches.map((match) => match[2].toLowerCase())
  const elements = elementMatches
    .filter((match) => match[1] !== '/')
    .map((match) => match[2].toLowerCase())
  const forbidden = [...new Set(allElements.filter((name) => !ALLOWED_ELEMENTS.has(name)))]
  if (forbidden.length > 0) error('forbidden_element', `Forbidden SVG element(s): ${forbidden.join(', ')}.`)
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root) error('missing_root', 'Candidate has no SVG root element.')
  else {
    if (!/\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(root)) {
      error('missing_namespace', 'SVG root must declare the standard SVG namespace.')
    }
    const viewBox = root.match(/\sviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
    const values = viewBox?.trim().split(/[\s,]+/).map(Number)
    if (!values || values.length !== 4 || values.some((value, index) => value !== [0, 0, 512, 512][index])) {
      error('invalid_viewbox', 'SVG root must use viewBox="0 0 512 512".')
    }
  }
  if (hadExtraneousText) warning('extraneous_model_text', 'Text outside the SVG document was removed.')
  return { passed: !failures.some((item) => item.severity === 'error'), failures, elements }
}

function structuralMetrics(svg, elements) {
  const count = (name) => elements.filter((element) => element === name).length
  return {
    candidate_bytes: Buffer.byteLength(svg),
    element_count: Math.max(0, elements.length - 1),
    path_count: count('path'),
    group_count: count('g'),
    basic_shape_count: ['circle', 'ellipse', 'polygon', 'polyline', 'line', 'rect']
      .reduce((total, name) => total + count(name), 0),
  }
}

function geometryMetrics(svg, elements) {
  let commandCount = 0
  let numericTokenCount = 0
  const numberPattern = /[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi
  const pathTags = svg.match(/<path\b[^>]*>/gi) ?? []
  for (const tag of pathTags) {
    const data = attributeValue(tag, 'd') ?? ''
    commandCount += (data.match(/[AaCcHhLlMmQqSsTtVvZz]/g) ?? []).length
    numericTokenCount += (data.match(numberPattern) ?? []).length
  }
  const geometryAttributes = {
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    polygon: ['points'],
    polyline: ['points'],
    line: ['x1', 'y1', 'x2', 'y2'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  }
  for (const [name, attributes] of Object.entries(geometryAttributes)) {
    for (const tag of svg.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []) {
      commandCount += 1
      for (const attribute of attributes) {
        numericTokenCount += (attributeValue(tag, attribute)?.match(numberPattern) ?? []).length
      }
    }
  }
  let nesting = 0
  let maximumNesting = 0
  for (const match of svg.matchAll(/<\s*(\/?)\s*(svg|g|path|circle|ellipse|polygon|polyline|line|rect)\b[^>]*>/gi)) {
    const tag = match[0]
    if (match[1] === '/') {
      nesting = Math.max(0, nesting - 1)
    } else if (!/\/\s*>$/.test(tag)) {
      nesting += 1
      maximumNesting = Math.max(maximumNesting, nesting)
    }
  }
  let activeStrokeCount = 0
  let nonBlackPaintCount = 0
  const blackPaint = new Set(['black', '#000', '#000000', 'rgb(0,0,0)', 'rgba(0,0,0,1)'])
  const inactivePaint = new Set(['none', 'transparent'])
  const paintStack = [{ name: null, fill: 'black', stroke: 'none' }]
  const paintSvg = svg.replace(/<!--[\s\S]*?-->/g, '')
  for (const match of paintSvg.matchAll(/<\s*(\/?)\s*(svg|g|path|circle|ellipse|polygon|polyline|line|rect)\b[^>]*>/gi)) {
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()
    if (closing) {
      while (paintStack.length > 1) {
        const popped = paintStack.pop()
        if (popped.name === name) break
      }
      continue
    }
    const tag = match[0]
    const parent = paintStack.at(-1)
    const fill = (attributeValue(tag, 'fill') ?? parent.fill).toLowerCase().replace(/\s+/g, '')
    const stroke = (attributeValue(tag, 'stroke') ?? parent.stroke).toLowerCase().replace(/\s+/g, '')
    if (!['svg', 'g'].includes(name)) {
      if (!inactivePaint.has(stroke)) activeStrokeCount += 1
      for (const paint of [fill, stroke]) {
        if (!inactivePaint.has(paint) && !blackPaint.has(paint)) nonBlackPaintCount += 1
      }
    }
    if (!/\/\s*>$/.test(tag)) paintStack.push({ name, fill, stroke })
  }
  return {
    ...structuralMetrics(svg, elements),
    command_count: commandCount,
    numeric_token_count: numericTokenCount,
    maximum_nesting: maximumNesting,
    active_stroke_count: activeStrokeCount,
    non_black_paint_count: nonBlackPaintCount,
  }
}

function hybridUserPrompt(traceSvg, traceHash) {
  return `You are refactoring an existing production SVG, not redrawing or restyling an image.

Inputs, in order:
1. ORIGINAL_IMAGE: the intended monochrome artwork.
2. BASELINE_RENDER: the rendering currently produced by the application.
3. BASELINE_SVG: the exact editable source of BASELINE_RENDER, included below.

Produce a smaller, cleaner, semantically organized SVG while preserving the rendered design.

Non-negotiable requirements:
- Preserve every object, overlap, negative space, edge crossing, repeated motif, relative placement, proportion, and line-weight hierarchy.
- Do not add, omit, reinterpret, or stylize details.
- Treat BASELINE_SVG as the authoritative geometry. Use ORIGINAL_IMAGE only to understand which contours and shapes belong together.
- At 512x512, no meaningful foreground boundary may move by more than two pixels.
- If uncertain about any geometry, retain the baseline geometry.
- Prefer fewer smooth Bezier segments and basic geometric shapes.
- Group clearly related parts with stable descriptive kebab-case IDs where useful, but do not add metadata merely to satisfy this request.
- Use viewBox="0 0 512 512" and explicit black filled geometry.
- Use only svg, g, path, circle, ellipse, polygon, polyline, line, and rect elements.
- Do not use raster images, text, CSS or style attributes, links, scripts, animation, external resources, defs/use, filters, gradients, masks, or clip paths.
- Return exactly one complete SVG document, with no Markdown or explanation.

The result is automatically rejected unless it preserves the image within a strict two-pixel fidelity tolerance and materially reduces geometric complexity.

<BASELINE_SVG sha256="${traceHash}">
${traceSvg}</BASELINE_SVG>`
}

function buildDirectRequest(inputPng) {
  return {
    model: MODEL_ID,
    instructions: DIRECT_SYSTEM_PROMPT,
    input: [{
      role: 'user',
      content: [
        { type: 'input_image', image_url: `data:image/png;base64,${inputPng.toString('base64')}`, detail: 'original' },
        { type: 'input_text', text: DIRECT_USER_PROMPT },
      ],
    }],
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  }
}

function buildHybridRequest(inputPng, traceRenderPng, userPrompt) {
  return {
    model: MODEL_ID,
    instructions: HYBRID_SYSTEM_PROMPT,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'ORIGINAL_IMAGE follows.' },
        { type: 'input_image', image_url: `data:image/png;base64,${inputPng.toString('base64')}`, detail: 'original' },
        { type: 'input_text', text: 'BASELINE_RENDER follows.' },
        { type: 'input_image', image_url: `data:image/png;base64,${traceRenderPng.toString('base64')}`, detail: 'original' },
        { type: 'input_text', text: userPrompt },
      ],
    }],
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  }
}

function requestLine(customId, body) {
  return {
    custom_id: customId,
    method: 'POST',
    url: ENDPOINT,
    body,
  }
}

function requestId(track, caseId) {
  return `gpt56sol-high-${track}-${caseId}`
}

function nullRatings() {
  const rating = {
    score: null,
    scale: '1-5',
    reviewer: 'unreviewed',
    notes: 'No blind human rating has been assigned.',
  }
  return { fidelity: rating, manufacturability: { ...rating } }
}

function trainingRights(corpusCase) {
  const sourceCleared = corpusCase.rights.training_allowed === true
  return {
    training_allowed: false,
    source: {
      cleared: sourceCleared,
      basis: sourceCleared ? 'asset_license' : 'unknown',
      evidence_url: sourceCleared ? corpusCase.rights.license_evidence_url : null,
      notes: sourceCleared
        ? `Corpus source is training-cleared under ${corpusCase.rights.license_spdx}.`
        : `Corpus source is evaluation-only: ${corpusCase.rights.notes || 'training rights are not cleared.'}`,
    },
    provider_output: {
      cleared: false,
      basis: 'provider_terms',
      terms_url: TERMS_URL,
      terms_version: 'OpenAI Services Agreement effective 2026-01-01',
      terms_effective_at: '2026-01-01',
      notes: 'Retained for evaluation only. The Services Agreement assigns output ownership to the customer but restricts using output to develop competing AI models outside its stated exception.',
    },
    reviewed_at: '2026-07-23',
    notes: 'Source and provider-output rights must both be cleared before training; these OpenAI outputs are not marked as distillation-ready.',
  }
}

function validateRecordAgainstManifest(record, manifest, manifestBytes, corpusCase, schemaValidator) {
  if (!schemaValidator(record)) {
    const messages = schemaValidator.errors.map((item) => `${item.instancePath || '$'} ${item.message}`).join('\n')
    throw new Error(`Run record failed JSON Schema validation:\n${messages}`)
  }
  const benchmark = record.benchmark
  if (benchmark.manifest_sha256 !== sha256(manifestBytes)) throw new Error('Run record has the wrong manifest hash.')
  if (benchmark.corpus_id !== manifest.corpus.id || benchmark.corpus_version !== manifest.corpus.version) {
    throw new Error('Run record has the wrong corpus identity.')
  }
  if (benchmark.case_id !== corpusCase.id || benchmark.split !== corpusCase.split) {
    throw new Error('Run record has the wrong case identity.')
  }
  for (const [name, expected] of [['input', corpusCase.input], ['reference', corpusCase.reference]]) {
    for (const field of ['path', 'sha256', 'media_type', 'bytes']) {
      if (benchmark[name][field] !== expected[field]) throw new Error(`Run record ${name}.${field} does not match the manifest.`)
    }
  }
}

async function prepareBatch() {
  const createdAt = new Date()
  const localBatchId = `openai-gpt-5.6-sol-dual-pilot-v1-${timestampId(createdAt)}`
  const batchDir = join(BATCHES_DIR, localBatchId)
  await mkdir(BATCHES_DIR, { recursive: true })
  await mkdir(batchDir)
  const [manifestBytes, baselineBytes, runnerBytes, geminiRunnerBytes] = await Promise.all([
    readFile(MANIFEST_PATH),
    readFile(BASELINE_PATH),
    readFile(fileURLToPath(import.meta.url)),
    readFile(join(BENCHMARK_DIR, 'evaluate-gemini.mjs')),
  ])
  const manifest = JSON.parse(manifestBytes)
  const baseline = JSON.parse(baselineBytes)
  const casesById = new Map(manifest.cases.map((item) => [item.id, item]))
  const baselineById = new Map(baseline.results.map((item) => [item.id, item]))
  const git = await gitState()
  const [resvgVersion, vectorTracerVersion] = await Promise.all([
    packageVersion('@resvg/resvg-js'),
    packageVersion('vectortracer'),
  ])
  const requests = []
  const requestLines = []
  for (const caseId of PILOT_CASES) {
    const corpusCase = casesById.get(caseId)
    const expectedBaseline = baselineById.get(caseId)
    if (!corpusCase || !expectedBaseline) throw new Error(`Pilot case ${caseId} is missing from the frozen corpus or baseline.`)
    if (corpusCase.split === 'test') throw new Error(`Refusing to use held-out test case ${caseId}.`)
    const [inputPng, referencePng] = await Promise.all([
      readFile(join(REPOSITORY_DIR, corpusCase.input.path)),
      readFile(join(REPOSITORY_DIR, corpusCase.reference.render.path)),
    ])
    if (sha256(inputPng) !== corpusCase.input.sha256) throw new Error(`${caseId}: input hash mismatch.`)
    const processed = thresholdRaster(decodePng(inputPng), REFERENCE_THRESHOLD)
    const traceSvg = formatFlatSvg(traceImageData(toImageData(processed)), SIZE, SIZE, 40, 40)
    const traceBytes = Buffer.from(traceSvg)
    const traceValidation = validateSvg(traceSvg, false)
    if (!traceValidation.passed) throw new Error(`${caseId}: generated production trace failed SVG validation.`)
    const traceRender = renderSvg(traceSvg)
    const referenceMetrics = compareRasters(decodePng(referencePng), traceRender)
    const inputMetrics = compareRasters(decodePng(inputPng), traceRender)
    const geometry = geometryMetrics(traceSvg, traceValidation.elements)
    if (traceBytes.byteLength !== expectedBaseline.traceBytes) {
      throw new Error(`${caseId}: production trace byte count drifted (${traceBytes.byteLength}, expected ${expectedBaseline.traceBytes}).`)
    }
    if (Math.abs(referenceMetrics.iou - expectedBaseline.iou) > 1e-12) {
      throw new Error(`${caseId}: production trace IoU drifted (${referenceMetrics.iou}, expected ${expectedBaseline.iou}).`)
    }
    const caseDir = join(batchDir, 'classical', caseId)
    await mkdir(caseDir, { recursive: true })
    const tracePath = join(caseDir, 'classical.svg')
    const traceRenderPath = join(caseDir, 'render.png')
    const traceMetadataPath = join(caseDir, 'metrics.json')
    const traceMetadata = {
      schema_version: '1.0.0',
      case_id: caseId,
      generated_at: createdAt.toISOString(),
      source_input: benchmarkArtifact(corpusCase.input),
      trace: artifact(tracePath, traceBytes, 'image/svg+xml'),
      render: artifact(traceRenderPath, traceRender.png, 'image/png'),
      generator: {
        adapter: 'production-equivalent BinaryImageConverter + formatFlatSvg',
        vectortracer_version: vectorTracerVersion,
        trace_settings: TRACE_SETTINGS,
        preprocessing_threshold: REFERENCE_THRESHOLD,
        physical_dimensions_mm: { width: 40, height: 40 },
        git_commit: git.commit,
        worktree_dirty: git.dirty,
        runner_sha256: sha256(runnerBytes),
      },
      renderer: {
        name: '@resvg/resvg-js',
        version: resvgVersion,
        width: SIZE,
        height: SIZE,
        background: '#ffffff',
        shape_rendering: 2,
      },
      reference_metrics: referenceMetrics,
      input_metrics: inputMetrics,
      geometry,
    }
    const traceMetadataBytes = jsonBytes(traceMetadata)
    await Promise.all([
      writeNew(tracePath, traceBytes),
      writeNew(traceRenderPath, traceRender.png),
      writeNew(traceMetadataPath, traceMetadataBytes),
    ])
    const hybridPrompt = hybridUserPrompt(traceSvg, sha256(traceBytes))
    const directId = requestId('direct', caseId)
    const hybridId = requestId('hybrid', caseId)
    requestLines.push(requestLine(directId, buildDirectRequest(inputPng)))
    requestLines.push(requestLine(hybridId, buildHybridRequest(inputPng, traceRender.png, hybridPrompt)))
    requests.push({
      custom_id: directId,
      case_id: caseId,
      track: 'direct',
      pipeline: DIRECT_PIPELINE,
      prompt_sha256: promptHash(DIRECT_SYSTEM_PROMPT, DIRECT_USER_PROMPT),
      input_sha256: sha256(inputPng),
    })
    requests.push({
      custom_id: hybridId,
      case_id: caseId,
      track: 'hybrid',
      pipeline: HYBRID_PIPELINE,
      prompt_sha256: promptHash(HYBRID_SYSTEM_PROMPT, hybridPrompt),
      input_sha256: sha256(inputPng),
      source_trace: artifact(tracePath, traceBytes, 'image/svg+xml'),
      source_trace_render: artifact(traceRenderPath, traceRender.png, 'image/png'),
      source_trace_metadata: artifact(traceMetadataPath, traceMetadataBytes, 'application/json'),
      source_trace_metrics: traceMetadata,
    })
  }
  const requestBytes = Buffer.from(`${requestLines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const requestPath = join(batchDir, 'batch-request.jsonl')
  await writeNew(requestPath, requestBytes)
  const plan = {
    schema_version: '1.0.0',
    local_batch_id: localBatchId,
    created_at: createdAt.toISOString(),
    immutable: true,
    policy: 'six independent one-call arms; three exact direct comparisons and three fail-closed hybrid refactors; held-out test split excluded',
    model: MODEL_ID,
    endpoint: ENDPOINT,
    completion_window: COMPLETION_WINDOW,
    settings: {
      api: 'responses-batch',
      reasoning_effort: REASONING_EFFORT,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      image_detail: 'original',
      store: false,
      batch_discount_percent: 50,
      latency_scope: 'batch_wall_clock_not_model_latency',
    },
    maximum_output_cost_usd: Number((requestLines.length * MAX_OUTPUT_TOKENS * BATCH_OUTPUT_USD_PER_MILLION / 1_000_000).toFixed(6)),
    corpus: {
      id: manifest.corpus.id,
      version: manifest.corpus.version,
      manifest_sha256: sha256(manifestBytes),
    },
    evaluator: {
      metric_version: '1.0.0',
      runner_sha256: sha256(runnerBytes),
      gemini_runner_sha256_before_comparison: sha256(geminiRunnerBytes),
      direct_prompt_sha256: promptHash(DIRECT_SYSTEM_PROMPT, DIRECT_USER_PROMPT),
      reference_threshold: REFERENCE_THRESHOLD,
      candidate_threshold: CANDIDATE_THRESHOLD,
    },
    request_file: artifact(requestPath, requestBytes, 'application/jsonl'),
    requests,
  }
  await writeNew(join(batchDir, 'plan.json'), jsonBytes(plan))
  process.stdout.write(`Prepared ${localBatchId}\n`)
  process.stdout.write(`Requests: ${requestLines.length}; model=${MODEL_ID}; reasoning=${REASONING_EFFORT}; max_output_tokens=${MAX_OUTPUT_TOKENS}\n`)
  process.stdout.write(`Maximum output-token charge at Batch rates: $${plan.maximum_output_cost_usd.toFixed(2)} plus input tokens.\n`)
  return { batchDir, localBatchId, plan }
}

async function pathExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

async function resolveLocalBatch(localBatchId) {
  if (localBatchId && !/^[a-z0-9][a-z0-9._-]*$/.test(localBatchId)) {
    throw new Error('Local batch ID contains unsafe characters.')
  }
  if (!localBatchId) {
    const entries = await readdir(BATCHES_DIR, { withFileTypes: true })
    const candidates = []
    for (const entry of entries) {
      if (entry.isDirectory() && await pathExists(join(BATCHES_DIR, entry.name, 'plan.json'))) {
        candidates.push(entry.name)
      }
    }
    candidates.sort((left, right) => right.localeCompare(left))
    localBatchId = candidates[0]
  }
  if (!localBatchId) throw new Error('No prepared OpenAI batch was found.')
  const batchDir = join(BATCHES_DIR, localBatchId)
  return { batchDir, localBatchId, plan: await readJson(join(batchDir, 'plan.json')) }
}

async function submitBatch(localBatchId) {
  const prepared = localBatchId ? await resolveLocalBatch(localBatchId) : await prepareBatch()
  const submissionPath = join(prepared.batchDir, 'submission.json')
  if (await pathExists(submissionPath)) throw new Error(`${prepared.localBatchId} has already been submitted.`)
  const apiKey = await openAiApiKey()
  const requestBytes = await readFile(join(prepared.batchDir, 'batch-request.jsonl'))
  if (sha256(requestBytes) !== prepared.plan.request_file.sha256) throw new Error('Batch request hash mismatch before upload.')
  const form = new FormData()
  form.append('purpose', 'batch')
  form.append('file', new Blob([requestBytes], { type: 'application/jsonl' }), 'batch-request.jsonl')
  const uploaded = await apiJson('/files', apiKey, { method: 'POST', body: form })
  await writeNew(join(prepared.batchDir, 'file-upload.json'), jsonBytes({ uploaded_at: new Date().toISOString(), response: uploaded }))
  const batch = await apiJson('/batches', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      input_file_id: uploaded.id,
      endpoint: ENDPOINT,
      completion_window: COMPLETION_WINDOW,
      metadata: {
        evaluation: 'cylinder-seal-image-to-svg',
        version: PIPELINE_VERSION,
        local_batch_id: prepared.localBatchId,
      },
    }),
  })
  const submission = {
    schema_version: '1.0.0',
    submitted_at: new Date().toISOString(),
    local_batch_id: prepared.localBatchId,
    input_file_id: uploaded.id,
    remote_batch_id: batch.id,
    response: batch,
  }
  await writeNew(submissionPath, jsonBytes(submission))
  process.stdout.write(`Submitted ${prepared.localBatchId}\n`)
  process.stdout.write(`Remote batch: ${batch.id}; status=${batch.status}\n`)
  return { ...prepared, submission }
}

async function fetchBatchStatus(localBatchId) {
  const prepared = await resolveLocalBatch(localBatchId)
  const submission = await readJson(join(prepared.batchDir, 'submission.json'))
  const apiKey = await openAiApiKey()
  const batch = await apiJson(`/batches/${submission.remote_batch_id}`, apiKey)
  const snapshot = {
    retrieved_at: new Date().toISOString(),
    local_batch_id: prepared.localBatchId,
    response: batch,
  }
  await writeNew(join(prepared.batchDir, `status-${timestampId()}.json`), jsonBytes(snapshot))
  const counts = batch.request_counts ?? {}
  process.stdout.write(
    `${prepared.localBatchId}: ${batch.status}; completed=${counts.completed ?? 0}, failed=${counts.failed ?? 0}, total=${counts.total ?? 0}\n`,
  )
  return { ...prepared, submission, batch, apiKey }
}

function responseText(response) {
  const chunks = []
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text)
    }
  }
  if (chunks.length === 0) throw new Error('OpenAI returned no output_text content.')
  return chunks.join('\n')
}

function providerUsage(response) {
  const source = response?.usage ?? {}
  const inputTokens = Number(source.input_tokens ?? 0)
  const cachedInputTokens = Number(source.input_tokens_details?.cached_tokens ?? 0)
  const outputTokens = Number(source.output_tokens ?? 0)
  const reasoningTokens = Number(source.output_tokens_details?.reasoning_tokens ?? 0)
  const totalTokens = inputTokens + outputTokens
  for (const [name, value] of [
    ['input_tokens', inputTokens],
    ['cached_input_tokens', cachedInputTokens],
    ['output_tokens', outputTokens],
    ['reasoning_tokens', reasoningTokens],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`OpenAI returned invalid ${name}.`)
  }
  if (cachedInputTokens > inputTokens) throw new Error('OpenAI cached input tokens exceed input tokens.')
  if (reasoningTokens > outputTokens) throw new Error('OpenAI reasoning tokens exceed output tokens.')
  if (source.total_tokens !== undefined && Number(source.total_tokens) !== totalTokens) {
    throw new Error(`OpenAI total_tokens ${source.total_tokens} does not equal input + output (${totalTokens}).`)
  }
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
  }
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  }
}

function estimatedCost(usage) {
  const uncachedInputTokens = usage.input_tokens - usage.cached_input_tokens
  const usd = (
    uncachedInputTokens * BATCH_INPUT_USD_PER_MILLION
    + usage.cached_input_tokens * BATCH_CACHED_INPUT_USD_PER_MILLION
    + usage.output_tokens * BATCH_OUTPUT_USD_PER_MILLION
  ) / 1_000_000
  return {
    usd: Number(usd.toFixed(9)),
    estimated: true,
    pricing_source_url: PRICING_URL,
  }
}

function zeroCost() {
  return { usd: 0, estimated: false, pricing_source_url: null }
}

function secondsToIso(seconds, fallback) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : fallback
}

function errorFailure(code, message) {
  return { code, severity: 'error', message }
}

function evaluateHybridGates(candidateMetrics, baselineMetadata) {
  const failures = []
  const baselineReference = baselineMetadata.reference_metrics
  const baselineInput = baselineMetadata.input_metrics
  const baselineGeometry = baselineMetadata.geometry
  const maximum = (value, ratio) => Math.floor(value * ratio)
  const gates = {
    input_tolerant_precision_minimum: 0.985,
    input_tolerant_recall_minimum: 0.985,
    input_tolerant_f1_minimum: baselineInput.tolerant_f1_2px - 0.005,
    reference_iou_minimum: baselineReference.iou - 0.01,
    reference_tolerant_precision_minimum: 0.985,
    reference_tolerant_recall_minimum: 0.985,
    command_count_maximum: maximum(baselineGeometry.command_count, 0.8),
    numeric_token_count_maximum: maximum(baselineGeometry.numeric_token_count, 0.8),
    candidate_bytes_maximum: maximum(baselineGeometry.candidate_bytes, 0.9),
    element_count_maximum: 512,
    maximum_nesting: 8,
    active_stroke_count_maximum: 0,
    non_black_paint_count_maximum: 0,
  }
  const requireAtLeast = (code, actual, minimum, label) => {
    if (actual < minimum) failures.push(errorFailure(code, `${label} ${actual.toFixed(6)} is below ${minimum.toFixed(6)}.`))
  }
  const requireAtMost = (code, actual, maximumValue, label) => {
    if (actual > maximumValue) failures.push(errorFailure(code, `${label} ${actual} exceeds ${maximumValue}.`))
  }
  requireAtLeast('input_tolerant_precision_regression', candidateMetrics.input_tolerant_precision_2px, gates.input_tolerant_precision_minimum, 'Input 2px-tolerant precision')
  requireAtLeast('input_tolerant_recall_regression', candidateMetrics.input_tolerant_recall_2px, gates.input_tolerant_recall_minimum, 'Input 2px-tolerant recall')
  requireAtLeast('input_tolerant_f1_regression', candidateMetrics.input_tolerant_f1_2px, gates.input_tolerant_f1_minimum, 'Input 2px-tolerant F1')
  requireAtLeast('reference_iou_regression', candidateMetrics.iou, gates.reference_iou_minimum, 'Reference IoU')
  requireAtLeast('reference_tolerant_precision_regression', candidateMetrics.tolerant_precision_2px, gates.reference_tolerant_precision_minimum, 'Reference 2px-tolerant precision')
  requireAtLeast('reference_tolerant_recall_regression', candidateMetrics.tolerant_recall_2px, gates.reference_tolerant_recall_minimum, 'Reference 2px-tolerant recall')
  requireAtMost('insufficient_command_reduction', candidateMetrics.command_count, gates.command_count_maximum, 'Path-command count')
  requireAtMost('insufficient_coordinate_reduction', candidateMetrics.numeric_token_count, gates.numeric_token_count_maximum, 'Geometry numeric-token count')
  requireAtMost('insufficient_byte_reduction', candidateMetrics.candidate_bytes, gates.candidate_bytes_maximum, 'Serialized byte count')
  requireAtMost('too_many_elements', candidateMetrics.element_count, gates.element_count_maximum, 'Painted element count')
  requireAtMost('excessive_nesting', candidateMetrics.maximum_nesting, gates.maximum_nesting, 'SVG nesting')
  requireAtMost('stroke_geometry_forbidden', candidateMetrics.active_stroke_count, gates.active_stroke_count_maximum, 'Active stroke count')
  requireAtMost('non_black_paint_forbidden', candidateMetrics.non_black_paint_count, gates.non_black_paint_count_maximum, 'Non-black paint count')
  return { gates, failures }
}

function modelAttemptSettings(track, remoteBatchId, baselineTraceHash = null) {
  return {
    api: 'responses-batch',
    endpoint: ENDPOINT,
    delivery: 'batch',
    remote_batch_id: remoteBatchId,
    reasoning_effort: REASONING_EFFORT,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    image_detail: 'original',
    image_count: track === 'hybrid' ? 2 : 1,
    store: false,
    strategy: track,
    batch_discount_percent: 50,
    latency_scope: 'shared_batch_wall_clock_not_model_latency',
    ...(baselineTraceHash ? { baseline_trace_sha256: baselineTraceHash } : {}),
  }
}

async function createRunRecord(context, requestPlan, rawLine) {
  const corpusCase = context.casesById.get(requestPlan.case_id)
  if (!corpusCase) throw new Error(`${requestPlan.custom_id}: missing corpus case.`)
  const wrapper = JSON.parse(rawLine)
  if (wrapper.custom_id !== requestPlan.custom_id) throw new Error('Batch response custom_id mismatch.')
  const response = wrapper.response?.body ?? null
  const providerError = wrapper.error
    ?? (wrapper.response?.status_code === 200 ? null : { message: `HTTP ${wrapper.response?.status_code ?? 'unknown'}` })
  let rawOutput = ''
  let processingError = providerError?.message ?? null
  if (!processingError && response?.status !== 'completed') {
    processingError = `OpenAI response status was ${response?.status ?? 'missing'}.`
  }
  if (!processingError) {
    try {
      rawOutput = responseText(response)
    } catch (error) {
      processingError = error instanceof Error ? error.message : String(error)
    }
  } else if (response) {
    try {
      rawOutput = responseText(response)
    } catch {
      // Preserve an empty raw output when an incomplete/error response has no text.
    }
  }
  let usage = emptyUsage()
  if (response?.usage) usage = providerUsage(response)
  const cost = estimatedCost(usage)
  const batchTimestamp = context.plan.created_at.replace(/[-:.]/g, '').toLowerCase()
  const runId = `${requestPlan.pipeline}-v${context.pipelineVersion}-${batchTimestamp}-${requestPlan.case_id}`
  const runDir = join(RUNS_DIR, runId)
  await mkdir(runDir)
  const providerResponseBytes = Buffer.from(`${rawLine}\n`)
  const rawOutputBytes = Buffer.from(rawOutput)
  const providerResponsePath = join(runDir, 'provider-response.json')
  const rawOutputPath = join(runDir, 'model-output.txt')
  const candidatePath = join(runDir, 'candidate.svg')
  const renderPath = join(runDir, 'render.png')
  const validationPath = join(runDir, 'validation.json')
  const inputPng = await readFile(join(REPOSITORY_DIR, corpusCase.input.path))
  const referencePng = await readFile(join(REPOSITORY_DIR, corpusCase.reference.render.path))
  const inputRaster = decodePng(inputPng)
  const referenceRaster = decodePng(referencePng)
  const baselineMetadata = requestPlan.track === 'hybrid' ? requestPlan.source_trace_metrics : null
  let candidateSvg
  let candidatePng
  let validation = { passed: false, failures: [], elements: [] }
  let metrics = {}
  let gateDefinition = null
  if (!processingError) {
    try {
      const extracted = extractSvg(rawOutput)
      candidateSvg = Buffer.from(extracted.svg)
      validation = validateSvg(extracted.svg, extracted.hadExtraneousText)
      if (validation.passed) {
        const rendered = renderSvg(extracted.svg)
        candidatePng = rendered.png
        const referenceMetrics = compareRasters(referenceRaster, rendered)
        const inputMetrics = compareRasters(inputRaster, rendered)
        const structure = geometryMetrics(extracted.svg, validation.elements)
        metrics = {
          ...referenceMetrics,
          input_iou: inputMetrics.iou,
          input_precision: inputMetrics.precision,
          input_recall: inputMetrics.recall,
          input_tolerant_precision_2px: inputMetrics.tolerant_precision_2px,
          input_tolerant_recall_2px: inputMetrics.tolerant_recall_2px,
          input_tolerant_f1_2px: inputMetrics.tolerant_f1_2px,
          ...structure,
          baseline_iou: context.baselineById.get(corpusCase.id)?.iou ?? null,
          delta_iou_vs_classical: referenceMetrics.iou - (context.baselineById.get(corpusCase.id)?.iou ?? 0),
          ...(baselineMetadata ? {
            baseline_input_tolerant_f1_2px: baselineMetadata.input_metrics.tolerant_f1_2px,
            byte_ratio_vs_classical: structure.candidate_bytes / baselineMetadata.geometry.candidate_bytes,
            command_ratio_vs_classical: structure.command_count / baselineMetadata.geometry.command_count,
            numeric_token_ratio_vs_classical: structure.numeric_token_count / baselineMetadata.geometry.numeric_token_count,
          } : {}),
        }
        if (requestPlan.track === 'hybrid') {
          const gates = evaluateHybridGates(metrics, baselineMetadata)
          gateDefinition = gates.gates
          validation.failures.push(...gates.failures)
          validation.passed = !validation.failures.some((item) => item.severity === 'error')
        }
      }
    } catch (error) {
      processingError = error instanceof Error ? error.message : String(error)
      validation.failures.push(errorFailure('render_or_metric_error', processingError))
      validation.passed = false
    }
  }
  if (processingError && !validation.failures.some((item) => item.message === processingError)) {
    validation.failures.push(errorFailure('invalid_model_output', processingError))
  }
  const technicallyCompleted = candidateSvg !== undefined && candidatePng !== undefined
  const modelAccepted = technicallyCompleted && validation.passed
  const validationReport = {
    schema_version: '1.0.0',
    case_id: corpusCase.id,
    run_id: runId,
    track: requestPlan.track,
    passed: modelAccepted,
    failures: validation.failures,
    metrics,
    gates: gateDefinition,
    provider: {
      remote_batch_id: context.batch.id,
      batch_request_id: wrapper.id ?? null,
      request_id: wrapper.response?.request_id ?? null,
      response_id: response?.id ?? null,
      model: response?.model ?? MODEL_ID,
      status: response?.status ?? null,
      incomplete_details: response?.incomplete_details ?? null,
    },
    thresholds: {
      reference_luminance: REFERENCE_THRESHOLD,
      candidate_luminance: CANDIDATE_THRESHOLD,
    },
  }
  const validationBytes = jsonBytes(validationReport)
  await Promise.all([
    writeNew(providerResponsePath, providerResponseBytes),
    writeNew(rawOutputPath, rawOutputBytes),
    writeNew(validationPath, validationBytes),
    ...(candidateSvg ? [writeNew(candidatePath, candidateSvg)] : []),
    ...(candidatePng ? [writeNew(renderPath, candidatePng)] : []),
  ])
  const requestBytes = context.requestBytes
  const modelArtifacts = {
    provider_response: artifact(providerResponsePath, providerResponseBytes, 'application/json'),
    batch_request: artifact(context.requestPath, requestBytes, 'application/jsonl'),
    raw_model_output: artifact(rawOutputPath, rawOutputBytes, 'text/plain'),
    validation_report: artifact(validationPath, validationBytes, 'application/json'),
    ...(requestPlan.source_trace ? { source_trace: requestPlan.source_trace } : {}),
    ...(candidateSvg ? { candidate_svg: artifact(candidatePath, candidateSvg, 'image/svg+xml') } : {}),
    ...(candidatePng ? { rendered_png: artifact(renderPath, candidatePng, 'image/png') } : {}),
  }
  const startedAt = secondsToIso(context.batch.in_progress_at ?? context.batch.created_at, context.plan.created_at)
  const finishedAt = secondsToIso(context.batch.completed_at, context.collectedAt)
  const latencyMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
  const systemPrompt = requestPlan.track === 'direct' ? DIRECT_SYSTEM_PROMPT : HYBRID_SYSTEM_PROMPT
  let userPrompt = DIRECT_USER_PROMPT
  if (requestPlan.track === 'hybrid') {
    const traceSvg = await readFile(join(REPOSITORY_DIR, requestPlan.source_trace.path), 'utf8')
    userPrompt = hybridUserPrompt(traceSvg, requestPlan.source_trace.sha256)
  }
  if (promptHash(systemPrompt, userPrompt) !== requestPlan.prompt_sha256) {
    throw new Error(`${requestPlan.custom_id}: reconstructed prompt hash mismatch.`)
  }
  const firstAttempt = {
    index: 0,
    kind: 'generation',
    status: technicallyCompleted ? 'completed' : 'failed',
    started_at: startedAt,
    finished_at: finishedAt,
    latency_ms: latencyMs,
    model: {
      provider: 'OpenAI',
      id: MODEL_ID,
      version: response?.model ?? MODEL_ID,
      settings: modelAttemptSettings(requestPlan.track, context.batch.id, requestPlan.source_trace?.sha256),
    },
    prompt: {
      template_id: requestPlan.track === 'direct' ? 'semantic-image-to-svg-one-shot' : 'trace-constrained-svg-refactor',
      template_version: '1.0.0',
      system: systemPrompt,
      user: userPrompt,
      sha256: promptHash(systemPrompt, userPrompt),
    },
    usage,
    cost,
    artifacts: modelArtifacts,
    ...(technicallyCompleted ? {
      validation: {
        passed: modelAccepted,
        failures: validation.failures,
        metrics,
      },
    } : {
      error: processingError ?? 'Candidate failed SVG safety validation or deterministic rendering.',
    }),
  }
  const attempts = [firstAttempt]
  let outcome
  let aggregateMetrics = metrics
  if (requestPlan.track === 'hybrid' && !modelAccepted) {
    const fallbackStarted = finishedAt
    const fallbackValidation = {
      schema_version: '1.0.0',
      case_id: corpusCase.id,
      run_id: runId,
      passed: true,
      policy: 'fail-closed fallback to the exact production classical trace',
      triggering_failures: validation.failures,
      metrics: {
        ...baselineMetadata.reference_metrics,
        input_iou: baselineMetadata.input_metrics.iou,
        input_tolerant_precision_2px: baselineMetadata.input_metrics.tolerant_precision_2px,
        input_tolerant_recall_2px: baselineMetadata.input_metrics.tolerant_recall_2px,
        input_tolerant_f1_2px: baselineMetadata.input_metrics.tolerant_f1_2px,
        ...baselineMetadata.geometry,
      },
    }
    const fallbackValidationBytes = jsonBytes(fallbackValidation)
    const fallbackValidationPath = join(runDir, 'fallback-validation.json')
    await writeNew(fallbackValidationPath, fallbackValidationBytes)
    const fallbackUsage = emptyUsage()
    const fallbackCost = zeroCost()
    attempts.push({
      index: 1,
      kind: 'fallback',
      status: 'completed',
      started_at: fallbackStarted,
      finished_at: fallbackStarted,
      latency_ms: 0,
      model: {
        provider: 'local',
        id: 'vectortracer',
        version: context.vectorTracerVersion,
        settings: {
          deterministic: true,
          preprocessing_threshold: REFERENCE_THRESHOLD,
          trace_settings: TRACE_SETTINGS,
          policy: 'retain_precomputed_production_trace',
        },
      },
      prompt: {
        template_id: 'classical-trace-fallback',
        template_version: '1.0.0',
        system: '',
        user: FALLBACK_USER_PROMPT,
        sha256: promptHash('', FALLBACK_USER_PROMPT),
      },
      usage: fallbackUsage,
      cost: fallbackCost,
      artifacts: {
        source_trace: requestPlan.source_trace,
        candidate_svg: requestPlan.source_trace,
        rendered_png: requestPlan.source_trace_render,
        validation_report: artifact(fallbackValidationPath, fallbackValidationBytes, 'application/json'),
      },
      validation: {
        passed: true,
        failures: [],
        metrics: fallbackValidation.metrics,
      },
    })
    aggregateMetrics = {
      fallback_used: true,
      model_candidate: metrics,
      final_classical: fallbackValidation.metrics,
    }
    outcome = {
      status: 'fallback',
      accepted_attempt: 1,
      final_svg: requestPlan.source_trace,
      notes: 'The one-call model refactor missed at least one hard safety, fidelity, or complexity gate; the exact production classical trace was retained unchanged.',
    }
  } else if (modelAccepted) {
    outcome = {
      status: 'accepted',
      accepted_attempt: 0,
      final_svg: modelArtifacts.candidate_svg,
      notes: requestPlan.track === 'hybrid'
        ? 'The model refactor passed every hard SVG safety, two-pixel fidelity, oracle, and complexity gate.'
        : 'Accepted after the same technical SVG safety and rendering checks used for the Gemini one-shot pilot; automatic fidelity metrics are descriptive, not an acceptance gate.',
    }
  } else {
    outcome = {
      status: processingError ? 'error' : 'rejected',
      accepted_attempt: null,
      final_svg: null,
      notes: processingError
        ? `The one-shot response could not be accepted: ${processingError}`
        : 'The one-shot response failed technical SVG safety or rendering validation.',
    }
  }
  const record = {
    schema_version: '1.0.0',
    run_id: runId,
    recorded_at: context.collectedAt,
    immutable: true,
    benchmark: {
      corpus_id: context.manifest.corpus.id,
      corpus_version: context.manifest.corpus.version,
      manifest_sha256: sha256(context.manifestBytes),
      case_id: corpusCase.id,
      split: corpusCase.split,
      input: benchmarkArtifact(corpusCase.input),
      reference: benchmarkArtifact(corpusCase.reference),
    },
    pipeline: {
      name: requestPlan.pipeline,
      version: context.pipelineVersion,
      git_commit: context.git.commit,
      worktree_dirty: context.git.dirty,
      renderer: {
        name: '@resvg/resvg-js',
        version: context.resvgVersion,
        settings: {
          width: SIZE,
          height: SIZE,
          background: '#ffffff',
          shape_rendering: 2,
          reference_threshold: REFERENCE_THRESHOLD,
          candidate_threshold: CANDIDATE_THRESHOLD,
          metric_version: '1.0.0',
          collector_sha256: context.collectorSha256,
        },
      },
    },
    attempts,
    aggregate: {
      latency_ms: attempts.reduce((total, attempt) => total + attempt.latency_ms, 0),
      usage: attempts.reduce((total, attempt) => ({
        input_tokens: total.input_tokens + attempt.usage.input_tokens,
        cached_input_tokens: total.cached_input_tokens + attempt.usage.cached_input_tokens,
        output_tokens: total.output_tokens + attempt.usage.output_tokens,
        reasoning_tokens: total.reasoning_tokens + attempt.usage.reasoning_tokens,
        total_tokens: total.total_tokens + attempt.usage.total_tokens,
      }), emptyUsage()),
      cost: {
        usd: Number(attempts.reduce((total, attempt) => total + attempt.cost.usd, 0).toFixed(9)),
        estimated: true,
        pricing_source_url: PRICING_URL,
      },
      metrics: aggregateMetrics,
      ratings: nullRatings(),
    },
    outcome,
    output_training_rights: trainingRights(corpusCase),
  }
  validateRecordAgainstManifest(record, context.manifest, context.manifestBytes, corpusCase, context.schemaValidator)
  await writeNew(join(runDir, 'record.json'), jsonBytes(record))
  return {
    run_id: runId,
    case_id: corpusCase.id,
    track: requestPlan.track,
    outcome: outcome.status,
    model_candidate_accepted: modelAccepted,
    fallback_used: outcome.status === 'fallback',
    latency_scope: 'shared_batch_wall_clock_not_model_latency',
    latency_ms: latencyMs,
    usage,
    estimated_cost_usd: cost.usd,
    metrics,
    failures: validation.failures,
    artifacts: {
      record: repositoryPath(join(runDir, 'record.json')),
      render: candidatePng ? repositoryPath(renderPath) : null,
      final_svg: outcome.final_svg?.path ?? null,
    },
  }
}

function parseJsonl(bytes, label) {
  const records = []
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    records.push({ value, raw: line })
  }
  return records
}

function summarizeTrack(results, track) {
  const rows = results.filter((item) => item.track === track)
  const scored = rows.filter((item) => typeof item.metrics.iou === 'number')
  const mean = (field) => scored.length === 0
    ? null
    : scored.reduce((total, item) => total + item.metrics[field], 0) / scored.length
  return {
    requests: rows.length,
    scored_candidates: scored.length,
    accepted_model_candidates: rows.filter((item) => item.model_candidate_accepted).length,
    fallbacks: rows.filter((item) => item.fallback_used).length,
    estimated_cost_usd: Number(rows.reduce((total, item) => total + item.estimated_cost_usd, 0).toFixed(9)),
    usage: {
      input_tokens: rows.reduce((total, item) => total + item.usage.input_tokens, 0),
      cached_input_tokens: rows.reduce((total, item) => total + item.usage.cached_input_tokens, 0),
      output_tokens: rows.reduce((total, item) => total + item.usage.output_tokens, 0),
      reasoning_tokens: rows.reduce((total, item) => total + item.usage.reasoning_tokens, 0),
      total_tokens: rows.reduce((total, item) => total + item.usage.total_tokens, 0),
    },
    metrics: {
      mean_iou: mean('iou'),
      mean_tolerant_f1_2px: mean('tolerant_f1_2px'),
      mean_delta_iou_vs_classical: mean('delta_iou_vs_classical'),
    },
  }
}

function summaryMarkdown(summary) {
  const number = (value, digits = 4) => typeof value === 'number' ? value.toFixed(digits) : 'n/a'
  const rows = summary.results.map((item) => (
    `| ${item.case_id} | ${item.track} | ${item.outcome} | ${item.model_candidate_accepted ? 'yes' : 'no'} | ${number(item.metrics.iou)} | ${number(item.metrics.baseline_iou)} | ${number(item.metrics.delta_iou_vs_classical)} | ${number(item.metrics.tolerant_f1_2px)} | ${item.usage.total_tokens.toLocaleString('en-US')} | $${item.estimated_cost_usd.toFixed(4)} |`
  )).join('\n')
  return `# GPT-5.6 Sol image-to-SVG Batch pilot

- Local batch: \`${summary.local_batch_id}\`
- Remote batch: \`${summary.remote_batch_id}\`
- Model: \`${summary.model}\`, reasoning effort \`${summary.reasoning_effort}\`
- Delivery: OpenAI Batch API (50% discount; completion within 24 hours)
- Scorer/pipeline version: \`${summary.pipeline_version}\`${summary.supersedes_summary ? ` (supersedes \`${summary.supersedes_summary}\`)` : ''}
- Batch wall time: ${(summary.batch_wall_clock_ms / 1000).toFixed(1)} s (not per-request model latency)
- Estimated API cost: $${summary.estimated_cost_usd.toFixed(4)}
- Direct mean IoU: ${number(summary.tracks.direct.metrics.mean_iou)}
- Hybrid candidates passing every hard gate: ${summary.tracks.hybrid.accepted_model_candidates}/${summary.tracks.hybrid.requests}
- Hybrid fallbacks to unchanged production trace: ${summary.tracks.hybrid.fallbacks}/${summary.tracks.hybrid.requests}

The direct arm uses the exact three PNGs and exact prompt text used by the Gemini pilot, but this is a deliberate high-reasoning, 65,536-output-token sledgehammer rather than a compute-normalized model ranking. Batch wall time is not comparable with the earlier synchronous Gemini request latency. Automatic acceptance in the direct arm means technically valid/renderable, not visually good. Human ratings remain unreviewed.

| Case | Track | Outcome | Model accepted | IoU | Classical IoU | Delta | 2px F1 | Tokens | Est. cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}
`
}

async function collectBatch(localBatchId, { rescore = false } = {}) {
  const current = await fetchBatchStatus(localBatchId)
  if (current.batch.status !== 'completed') {
    const terminal = ['failed', 'expired', 'cancelled'].includes(current.batch.status)
    throw new Error(
      terminal
        ? `Batch ended with status ${current.batch.status}; inspect the archived status snapshot before deciding whether to collect partial results.`
        : `Batch is ${current.batch.status}; collect after it reaches completed.`,
    )
  }
  if (!current.batch.output_file_id) throw new Error('Completed batch has no output_file_id.')
  const resultSuffix = rescore ? `-scorer-v${PIPELINE_VERSION}` : ''
  const collectionPath = join(current.batchDir, `collection${resultSuffix}.json`)
  if (await pathExists(collectionPath)) throw new Error(`${current.localBatchId} has already been collected.`)
  const outputPath = join(current.batchDir, 'batch-output.jsonl')
  const errorPath = join(current.batchDir, 'batch-error.jsonl')
  let outputBytes
  let errorBytes
  if (rescore) {
    if (!await pathExists(outputPath)) throw new Error('Cannot rescore before the exact Batch output has been collected.')
    outputBytes = await readFile(outputPath)
    errorBytes = await pathExists(errorPath) ? await readFile(errorPath) : Buffer.alloc(0)
  } else {
    outputBytes = await apiFile(`/files/${current.batch.output_file_id}/content`, current.apiKey)
    errorBytes = current.batch.error_file_id
      ? await apiFile(`/files/${current.batch.error_file_id}/content`, current.apiKey)
      : Buffer.alloc(0)
    await writeNew(outputPath, outputBytes)
    if (errorBytes.byteLength > 0) await writeNew(errorPath, errorBytes)
  }
  const lines = [
    ...parseJsonl(outputBytes, 'Batch output'),
    ...parseJsonl(errorBytes, 'Batch error output'),
  ]
  const byCustomId = new Map()
  for (const line of lines) {
    const customId = line.value.custom_id
    if (typeof customId !== 'string') throw new Error('Batch result is missing custom_id.')
    if (byCustomId.has(customId)) throw new Error(`Duplicate Batch result custom_id: ${customId}`)
    byCustomId.set(customId, line.raw)
  }
  const expectedIds = new Set(current.plan.requests.map((item) => item.custom_id))
  const unexpected = [...byCustomId.keys()].filter((id) => !expectedIds.has(id))
  const missing = [...expectedIds].filter((id) => !byCustomId.has(id))
  if (unexpected.length > 0) throw new Error(`Unexpected Batch result IDs: ${unexpected.join(', ')}`)
  if (missing.length > 0) throw new Error(`Missing Batch result IDs: ${missing.join(', ')}`)
  const [manifestBytes, baselineBytes, schemaBytes] = await Promise.all([
    readFile(MANIFEST_PATH),
    readFile(BASELINE_PATH),
    readFile(SCHEMA_PATH),
  ])
  const manifest = JSON.parse(manifestBytes)
  const baseline = JSON.parse(baselineBytes)
  const schema = JSON.parse(schemaBytes)
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  addFormats(ajv)
  const context = {
    ...current,
    collectedAt: new Date().toISOString(),
    manifest,
    manifestBytes,
    casesById: new Map(manifest.cases.map((item) => [item.id, item])),
    baselineById: new Map(baseline.results.map((item) => [item.id, item])),
    schemaValidator: ajv.compile(schema),
    git: await gitState(),
    resvgVersion: await packageVersion('@resvg/resvg-js'),
    vectorTracerVersion: await packageVersion('vectortracer'),
    collectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    requestPath: join(current.batchDir, 'batch-request.jsonl'),
    requestBytes: await readFile(join(current.batchDir, 'batch-request.jsonl')),
    pipelineVersion: PIPELINE_VERSION,
  }
  const results = []
  for (const requestPlan of current.plan.requests) {
    process.stdout.write(`Collecting ${requestPlan.track}/${requestPlan.case_id}...\n`)
    results.push(await createRunRecord(context, requestPlan, byCustomId.get(requestPlan.custom_id)))
  }
  const startedAt = secondsToIso(current.batch.in_progress_at ?? current.batch.created_at, current.plan.created_at)
  const finishedAt = secondsToIso(current.batch.completed_at, context.collectedAt)
  const summary = {
    schema_version: '1.0.0',
    local_batch_id: current.localBatchId,
    remote_batch_id: current.batch.id,
    collected_at: context.collectedAt,
    policy: current.plan.policy,
    pipeline_version: PIPELINE_VERSION,
    supersedes_summary: rescore ? `${current.localBatchId}.json` : null,
    model: MODEL_ID,
    reasoning_effort: REASONING_EFFORT,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    delivery: 'batch',
    batch_discount_percent: 50,
    latency_scope: 'batch_wall_clock_not_model_latency',
    batch_wall_clock_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    collector_sha256: context.collectorSha256,
    estimated_cost_usd: Number(results.reduce((total, item) => total + item.estimated_cost_usd, 0).toFixed(9)),
    usage: {
      input_tokens: results.reduce((total, item) => total + item.usage.input_tokens, 0),
      cached_input_tokens: results.reduce((total, item) => total + item.usage.cached_input_tokens, 0),
      output_tokens: results.reduce((total, item) => total + item.usage.output_tokens, 0),
      reasoning_tokens: results.reduce((total, item) => total + item.usage.reasoning_tokens, 0),
      total_tokens: results.reduce((total, item) => total + item.usage.total_tokens, 0),
    },
    tracks: {
      direct: summarizeTrack(results, 'direct'),
      hybrid: summarizeTrack(results, 'hybrid'),
    },
    results,
    caveats: [
      'Three handpicked cases are an illustrative product pilot, not a statistically stable model ranking.',
      'The OpenAI run uses high reasoning while the Gemini run used medium thinking; compute is intentionally not normalized.',
      'The OpenAI maximum output budget is 65,536 tokens versus 32,768 for the Gemini pilot, so truncation headroom is intentionally not normalized.',
      'Two pilot reference assets have OpenAI coding-agent provenance, so provider comparisons may be asymmetric.',
      'IoU rewards coordinate alignment and must be paired with blind human fidelity and manufacturability ratings.',
      'Batch wall time is not per-request inference latency and is not comparable with synchronous Gemini latency.',
      'Provider outputs are archived for evaluation but are not marked as cleared for model distillation.',
    ],
  }
  await mkdir(SUMMARIES_DIR, { recursive: true })
  const summaryId = `${current.localBatchId}${resultSuffix}`
  const summaryJsonPath = join(SUMMARIES_DIR, `${summaryId}.json`)
  const summaryMarkdownPath = join(SUMMARIES_DIR, `${summaryId}.md`)
  await Promise.all([
    writeNew(summaryJsonPath, jsonBytes(summary)),
    writeNew(summaryMarkdownPath, Buffer.from(summaryMarkdown(summary))),
  ])
  const collection = {
    schema_version: '1.0.0',
    collected_at: context.collectedAt,
    output_file: artifact(outputPath, outputBytes, 'application/jsonl'),
    error_file: errorBytes.byteLength > 0 ? artifact(errorPath, errorBytes, 'application/jsonl') : null,
    summary_json: artifact(summaryJsonPath, await readFile(summaryJsonPath), 'application/json'),
    summary_markdown: artifact(summaryMarkdownPath, await readFile(summaryMarkdownPath), 'text/markdown'),
    run_ids: results.map((item) => item.run_id),
    collector_sha256: context.collectorSha256,
    supersedes_collection: rescore ? 'collection.json' : null,
  }
  await writeNew(collectionPath, jsonBytes(collection))
  if (rescore) {
    const erratum = {
      schema_version: '1.0.0',
      recorded_at: context.collectedAt,
      affected_collection: 'collection.json',
      affected_summary: `benchmarks/image-to-svg/runs/summaries/${current.localBatchId}.json`,
      issue: 'Scorer 1.0.0 did not parse newlines inside quoted SVG attributes, undercounting path commands and numeric geometry tokens. It also did not resolve inherited stroke/fill paint for the hybrid fill-only gate.',
      impact: 'Pixel metrics and API usage/cost were unaffected. Hybrid complexity and paint gates required versioned rescoring; no provider calls were repeated.',
      corrected_collection: repositoryPath(collectionPath),
      corrected_summary: repositoryPath(summaryJsonPath),
      corrected_pipeline_version: PIPELINE_VERSION,
      prior_run_ids: results.map((item) => item.run_id.replace(`-v${PIPELINE_VERSION}-`, '-v1-')),
      corrected_run_ids: results.map((item) => item.run_id),
    }
    await writeNew(join(current.batchDir, `scorer-erratum-v${PIPELINE_VERSION}.json`), jsonBytes(erratum))
  }
  process.stdout.write(`Collected ${results.length} run records.\n`)
  process.stdout.write(`Estimated Batch cost: $${summary.estimated_cost_usd.toFixed(4)}\n`)
  process.stdout.write(`Summary: ${repositoryPath(summaryMarkdownPath)}\n`)
  return summary
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (options.command === 'prepare') await prepareBatch()
  else if (options.command === 'submit') await submitBatch(options.batch)
  else if (options.command === 'status') await fetchBatchStatus(options.batch)
  else if (options.command === 'collect') await collectBatch(options.batch)
  else if (options.command === 'rescore') await collectBatch(options.batch, { rescore: true })
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
