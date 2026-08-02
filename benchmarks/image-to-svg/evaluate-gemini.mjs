import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const SIZE = 512
const REFERENCE_THRESHOLD = 170
const CANDIDATE_THRESHOLD = 128
const MODEL_ID = 'gemini-3.6-flash'
const PIPELINE_NAME = 'gemini-3.6-flash-one-shot'
const PIPELINE_VERSION = '1.0.0'
const PROMPT_TEMPLATE_ID = 'semantic-image-to-svg-one-shot'
const PROMPT_TEMPLATE_VERSION = '1.0.0'
const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing'
const TERMS_URL = 'https://ai.google.dev/gemini-api/terms'
const INPUT_USD_PER_MILLION = 1.5
const OUTPUT_USD_PER_MILLION = 7.5
const ENDPOINTS = [
  'https://generativelanguage.googleapis.com/v1beta2/interactions',
  'https://generativelanguage.googleapis.com/v1beta/interactions',
]
const PILOT_CASES = [
  'procedural-003-flying-bird',
  'external-openclipart-rabbit-line-art',
  'existing-easter-bunny-gold',
]
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
const SYSTEM_PROMPT = 'You are an expert vector illustrator reconstructing fabrication-ready monochrome artwork from a raster reference.'
const USER_PROMPT = `Recreate the attached monochrome line-art image as a clean, editable, self-contained SVG. Infer the intended vector design rather than tracing antialiased pixels or noise. Preserve every distinct object, its placement, proportions, overlaps, repeated motifs, line-weight hierarchy, silhouettes, negative spaces, and any artwork crossing an image edge. Use viewBox="0 0 512 512", explicit black fills or strokes, and only basic SVG geometry such as paths, groups, circles, ellipses, polygons, polylines, lines, and rectangles. Prefer smooth, economical geometry, but do not omit meaningful small details. Do not embed the raster, use text, scripts, external resources, CSS, filters, gradients, masks, clip paths, or reusable external definitions. Return only one complete <svg xmlns="http://www.w3.org/2000/svg">...</svg> document, with no Markdown or explanation.`

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_DIR = join(BENCHMARK_DIR, '..', '..')
const MANIFEST_PATH = join(BENCHMARK_DIR, 'manifest.json')
const BASELINE_PATH = join(BENCHMARK_DIR, 'baseline', 'report.json')
const RUNS_DIR = join(BENCHMARK_DIR, 'runs')
const SCHEMA_PATH = join(BENCHMARK_DIR, 'run-record.schema.json')

function usage() {
  return `Usage:
  node benchmarks/image-to-svg/evaluate-gemini.mjs --pilot
  node benchmarks/image-to-svg/evaluate-gemini.mjs --case <id> [--case <id> ...]
  node benchmarks/image-to-svg/evaluate-gemini.mjs --split development [--split validation]

Options:
  --pilot                 Run the three fixed development pilot cases.
  --case <id>             Select one case; repeat to select more.
  --split <name>          Select development or validation cases.
  --allow-test            Explicitly permit selecting the policy-held-out test split.
  --max-cost-usd <value>  Stop before the next case after this estimated paid-tier cost (default: 5).
  --dry-run               Validate selection and print the request plan without calling Gemini.
  --help                  Show this help.
`
}

function parseArgs(argv) {
  const options = {
    allowTest: false,
    cases: [],
    dryRun: false,
    maxCostUsd: 5,
    pilot: false,
    splits: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--pilot') options.pilot = true
    else if (argument === '--allow-test') options.allowTest = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--help') options.help = true
    else if (argument === '--case') options.cases.push(requiredValue(argv, ++index, argument))
    else if (argument === '--split') options.splits.push(requiredValue(argv, ++index, argument))
    else if (argument === '--max-cost-usd') {
      options.maxCostUsd = Number(requiredValue(argv, ++index, argument))
      if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
        throw new Error('--max-cost-usd must be a positive number.')
      }
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }
  return options
}

function requiredValue(argv, index, option) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`)
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function promptHash(system, user) {
  return createHash('sha256').update(system).update('\0').update(user).digest('hex')
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

function selectCases(manifest, options) {
  const ids = new Set(options.cases)
  if (options.pilot) PILOT_CASES.forEach((id) => ids.add(id))
  const allowedSplits = new Set(['development', 'validation', 'test'])
  for (const split of options.splits) {
    if (!allowedSplits.has(split)) throw new Error(`Unknown split: ${split}`)
    manifest.cases.filter((item) => item.split === split).forEach((item) => ids.add(item.id))
  }
  if (ids.size === 0) throw new Error('Select --pilot, at least one --case, or at least one --split.')
  const casesById = new Map(manifest.cases.map((item) => [item.id, item]))
  const missing = [...ids].filter((id) => !casesById.has(id))
  if (missing.length > 0) throw new Error(`Unknown case ID(s): ${missing.join(', ')}`)
  const selected = [...ids].map((id) => casesById.get(id))
  if (!options.allowTest && selected.some((item) => item.split === 'test')) {
    throw new Error('The test split is policy-held-out. Pass --allow-test only after fixing the pipeline.')
  }
  return selected
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').toLowerCase()
}

async function gitState() {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_DIR }),
    run('git', ['status', '--porcelain'], { cwd: REPOSITORY_DIR }),
  ])
  return { commit: commit.trim(), dirty: status.trim().length > 0 }
}

async function rendererVersion() {
  const packageJson = JSON.parse(
    await readFile(join(REPOSITORY_DIR, 'node_modules', '@resvg', 'resvg-js', 'package.json'), 'utf8'),
  )
  return packageJson.version
}

function buildRequest(inputPng) {
  return {
    model: MODEL_ID,
    system_instruction: SYSTEM_PROMPT,
    input: [
      {
        type: 'image',
        mime_type: 'image/png',
        data: inputPng.toString('base64'),
      },
      { type: 'text', text: USER_PROMPT },
    ],
    store: false,
    generation_config: {
      max_output_tokens: 32768,
      seed: 0,
      thinking_level: 'medium',
      thinking_summaries: 'none',
    },
  }
}

async function createInteraction(request, apiKey) {
  let lastError
  for (const [index, endpoint] of ENDPOINTS.entries()) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180_000),
    })
    const bodyText = await response.text()
    let body
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = { unparseable_response: bodyText }
    }
    if (response.ok) return { body, endpoint }
    const message = body?.error?.message ?? `HTTP ${response.status}`
    lastError = new Error(`Gemini request failed (${response.status}): ${message}`)
    if (response.status !== 404 || index === ENDPOINTS.length - 1) throw lastError
  }
  throw lastError ?? new Error('Gemini request failed without a response.')
}

function modelText(response) {
  if (response.status !== 'completed') {
    throw new Error(`Interaction ended with status ${String(response.status)}.`)
  }
  const chunks = []
  for (const step of response.steps ?? []) {
    if (step.type !== 'model_output') continue
    for (const content of step.content ?? []) {
      if (content.type === 'text' && typeof content.text === 'string') chunks.push(content.text)
    }
  }
  if (chunks.length === 0) throw new Error('Gemini returned no model-output text.')
  return chunks.join('\n')
}

function providerUsage(response) {
  const source = response.usage ?? {}
  const inputTokens = Number(source.total_input_tokens ?? 0)
  const visibleOutputTokens = Number(source.total_output_tokens ?? 0)
  const reasoningTokens = Number(source.total_thought_tokens ?? 0)
  const outputTokens = visibleOutputTokens + reasoningTokens
  const totalTokens = inputTokens + outputTokens
  for (const value of [inputTokens, visibleOutputTokens, reasoningTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Gemini returned invalid usage data.')
  }
  return {
    input_tokens: inputTokens,
    cached_input_tokens: Number(source.total_cached_tokens ?? 0),
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
  }
}

function estimatedCost(usageRecord) {
  const usd = (
    usageRecord.input_tokens * INPUT_USD_PER_MILLION
    + usageRecord.output_tokens * OUTPUT_USD_PER_MILLION
  ) / 1_000_000
  return {
    usd: Number(usd.toFixed(9)),
    estimated: true,
    pricing_source_url: PRICING_URL,
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

function decodePng(png) {
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="100%" height="100%" fill="#fff"/><image width="${SIZE}" height="${SIZE}" href="${dataUrl}"/></svg>`
  const rendered = new Resvg(wrapper, { background: '#ffffff', shapeRendering: 2 }).render()
  return {
    pixels: new Uint8ClampedArray(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
  }
}

function luminance(pixels, pixel) {
  const offset = pixel * 4
  return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
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

function benchmarkArtifact(source) {
  return {
    path: source.path,
    sha256: source.sha256,
    media_type: source.media_type,
    bytes: source.bytes,
  }
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
      terms_version: 'Gemini API Additional Terms effective 2026-03-23; updated 2026-04-28',
      terms_effective_at: '2026-03-23',
      notes: 'Not cleared for distillation: the provider terms restrict using the service to develop models that compete with Gemini. Retained for evaluation only.',
    },
    reviewed_at: '2026-07-22',
    notes: 'Both source and provider-output rights must be cleared before training; provider-output rights are not cleared for this run.',
  }
}

function nullRatings() {
  const rating = {
    score: null,
    scale: '1-5',
    reviewer: 'unreviewed',
    notes: 'No human rating has been assigned.',
  }
  return { fidelity: rating, manufacturability: { ...rating } }
}

function validateRecordAgainstManifest(record, manifest, manifestBytes, corpusCase, schemaValidator) {
  if (!schemaValidator(record)) {
    const messages = schemaValidator.errors.map((item) => `${item.instancePath || '$'} ${item.message}`).join('\n')
    throw new Error(`Run record failed JSON Schema validation:\n${messages}`)
  }
  const benchmark = record.benchmark
  const expectedManifestHash = sha256(manifestBytes)
  if (benchmark.manifest_sha256 !== expectedManifestHash) throw new Error('Run record has the wrong manifest hash.')
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

async function runCase(context, corpusCase) {
  const runId = `${PIPELINE_NAME}-v1-${context.batchTimestamp}-${corpusCase.id}`
  const runDir = join(RUNS_DIR, runId)
  await mkdir(runDir)
  const inputPng = await readFile(join(REPOSITORY_DIR, corpusCase.input.path))
  if (sha256(inputPng) !== corpusCase.input.sha256) throw new Error(`${corpusCase.id}: input hash mismatch.`)
  const started = new Date()
  const startClock = performance.now()
  const { body: response, endpoint } = await createInteraction(buildRequest(inputPng), context.apiKey)
  const finished = new Date()
  const latencyMs = Math.round(performance.now() - startClock)
  const rawOutput = modelText(response)
  const usageRecord = providerUsage(response)
  const cost = estimatedCost(usageRecord)
  const providerResponseBytes = Buffer.from(`${JSON.stringify(response, null, 2)}\n`)
  const rawOutputBytes = Buffer.from(rawOutput)
  const providerResponsePath = join(runDir, 'provider-response.json')
  const rawOutputPath = join(runDir, 'model-output.txt')
  let candidateSvg
  let candidatePng
  let candidateValidation
  let metrics = {}
  let extractionError
  try {
    const extracted = extractSvg(rawOutput)
    candidateSvg = Buffer.from(extracted.svg)
    candidateValidation = validateSvg(extracted.svg, extracted.hadExtraneousText)
    if (candidateValidation.passed) {
      const rendered = renderSvg(extracted.svg)
      candidatePng = rendered.png
      const referencePng = await readFile(join(REPOSITORY_DIR, corpusCase.reference.render.path))
      const pixelMetrics = compareRasters(decodePng(referencePng), rendered)
      const structure = structuralMetrics(extracted.svg, candidateValidation.elements)
      const baselineIou = context.baselineById.get(corpusCase.id)?.iou ?? null
      metrics = {
        ...pixelMetrics,
        ...structure,
        baseline_iou: baselineIou,
        delta_iou_vs_classical: baselineIou === null ? null : pixelMetrics.iou - baselineIou,
      }
    }
  } catch (error) {
    extractionError = error instanceof Error ? error.message : String(error)
    candidateValidation ??= {
      passed: false,
      failures: [{ code: 'invalid_model_output', severity: 'error', message: extractionError }],
      elements: [],
    }
  }
  const passed = candidateValidation.passed && candidatePng !== undefined
  const validationFailures = [...candidateValidation.failures]
  if (!passed && extractionError && !validationFailures.some((item) => item.message === extractionError)) {
    validationFailures.push({ code: 'render_or_metric_error', severity: 'error', message: extractionError })
  }
  const validationReport = {
    schema_version: '1.0.0',
    case_id: corpusCase.id,
    run_id: runId,
    passed,
    failures: validationFailures,
    metrics,
    provider: {
      endpoint,
      interaction_id: response.id ?? null,
      model: response.model ?? MODEL_ID,
      status: response.status,
    },
    thresholds: {
      reference_luminance: REFERENCE_THRESHOLD,
      candidate_luminance: CANDIDATE_THRESHOLD,
    },
  }
  const validationBytes = Buffer.from(`${JSON.stringify(validationReport, null, 2)}\n`)
  const validationPath = join(runDir, 'validation.json')
  const candidatePath = join(runDir, 'candidate.svg')
  const renderPath = join(runDir, 'render.png')
  const writes = [
    writeFile(providerResponsePath, providerResponseBytes, { flag: 'wx' }),
    writeFile(rawOutputPath, rawOutputBytes, { flag: 'wx' }),
    writeFile(validationPath, validationBytes, { flag: 'wx' }),
  ]
  if (candidateSvg) writes.push(writeFile(candidatePath, candidateSvg, { flag: 'wx' }))
  if (candidatePng) writes.push(writeFile(renderPath, candidatePng, { flag: 'wx' }))
  await Promise.all(writes)
  const artifacts = {
    provider_response: artifact(providerResponsePath, providerResponseBytes, 'application/json'),
    raw_model_output: artifact(rawOutputPath, rawOutputBytes, 'text/plain'),
    validation_report: artifact(validationPath, validationBytes, 'application/json'),
  }
  if (candidateSvg) artifacts.candidate_svg = artifact(candidatePath, candidateSvg, 'image/svg+xml')
  if (candidatePng) artifacts.rendered_png = artifact(renderPath, candidatePng, 'image/png')
  const acceptedArtifact = passed ? artifacts.candidate_svg : null
  const record = {
    schema_version: '1.0.0',
    run_id: runId,
    recorded_at: finished.toISOString(),
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
      name: PIPELINE_NAME,
      version: PIPELINE_VERSION,
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
        },
      },
    },
    attempts: [{
      index: 0,
      kind: 'generation',
      status: passed ? 'completed' : 'failed',
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      latency_ms: latencyMs,
      model: {
        provider: 'Google',
        id: MODEL_ID,
        version: response.model ?? MODEL_ID,
        settings: {
          api: 'interactions',
          endpoint,
          store: false,
          max_output_tokens: 32768,
          seed: 0,
          thinking_level: 'medium',
          thinking_summaries: 'none',
        },
      },
      prompt: {
        template_id: PROMPT_TEMPLATE_ID,
        template_version: PROMPT_TEMPLATE_VERSION,
        system: SYSTEM_PROMPT,
        user: USER_PROMPT,
        sha256: promptHash(SYSTEM_PROMPT, USER_PROMPT),
      },
      usage: usageRecord,
      cost,
      artifacts,
      validation: {
        passed,
        failures: validationFailures,
        metrics,
      },
      ...(passed ? {} : { error: extractionError ?? 'Candidate failed SVG safety validation.' }),
    }],
    aggregate: {
      latency_ms: latencyMs,
      usage: usageRecord,
      cost,
      metrics,
      ratings: nullRatings(),
    },
    outcome: {
      status: passed ? 'accepted' : 'rejected',
      accepted_attempt: passed ? 0 : null,
      final_svg: acceptedArtifact,
      notes: passed
        ? 'Accepted automatically after SVG safety checks, rendering, and metric computation; human quality rating remains pending.'
        : 'Rejected because the single model output did not pass technical SVG validation.',
    },
    output_training_rights: trainingRights(corpusCase),
  }
  validateRecordAgainstManifest(
    record,
    context.manifest,
    context.manifestBytes,
    corpusCase,
    context.schemaValidator,
  )
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  await writeFile(join(runDir, 'record.json'), recordBytes, { flag: 'wx' })
  return {
    run_id: runId,
    case_id: corpusCase.id,
    split: corpusCase.split,
    profile: corpusCase.input.profile,
    difficulty: corpusCase.difficulty,
    accepted: passed,
    latency_ms: latencyMs,
    usage: usageRecord,
    estimated_cost_usd: cost.usd,
    metrics,
    artifacts: {
      record: repositoryPath(join(runDir, 'record.json')),
      render: candidatePng ? repositoryPath(renderPath) : null,
    },
  }
}

function summarize(results, batchId) {
  const accepted = results.filter((item) => item.accepted)
  const mean = (field) => accepted.length === 0
    ? null
    : accepted.reduce((sum, item) => sum + item.metrics[field], 0) / accepted.length
  return {
    schema_version: '1.0.0',
    batch_id: batchId,
    pipeline: `${PIPELINE_NAME}@${PIPELINE_VERSION}`,
    model: MODEL_ID,
    policy: 'one model call per case; no repair loop; test split excluded',
    cases: results.length,
    accepted: accepted.length,
    estimated_cost_usd: Number(results.reduce((sum, item) => sum + item.estimated_cost_usd, 0).toFixed(9)),
    total_latency_ms: results.reduce((sum, item) => sum + item.latency_ms, 0),
    usage: {
      input_tokens: results.reduce((sum, item) => sum + item.usage.input_tokens, 0),
      cached_input_tokens: results.reduce((sum, item) => sum + item.usage.cached_input_tokens, 0),
      output_tokens: results.reduce((sum, item) => sum + item.usage.output_tokens, 0),
      reasoning_tokens: results.reduce((sum, item) => sum + item.usage.reasoning_tokens, 0),
      total_tokens: results.reduce((sum, item) => sum + item.usage.total_tokens, 0),
    },
    metrics: {
      mean_iou: mean('iou'),
      mean_precision: mean('precision'),
      mean_recall: mean('recall'),
      mean_disagreement: mean('disagreement'),
      mean_delta_iou_vs_classical: mean('delta_iou_vs_classical'),
    },
    results,
  }
}

function summaryMarkdown(summary) {
  const number = (value, digits = 4) => value === null ? 'n/a' : value.toFixed(digits)
  const rows = summary.results.map((item) => (
    `| ${item.case_id} | ${item.difficulty} | ${item.profile} | ${item.accepted ? 'yes' : 'no'} | ${number(item.metrics.iou)} | ${number(item.metrics.baseline_iou)} | ${number(item.metrics.delta_iou_vs_classical)} | ${item.usage.total_tokens.toLocaleString('en-US')} | $${item.estimated_cost_usd.toFixed(4)} | ${(item.latency_ms / 1000).toFixed(1)} s |`
  )).join('\n')
  return `# Gemini one-shot image-to-SVG evaluation

- Batch: \`${summary.batch_id}\`
- Model: \`${summary.model}\`
- Policy: ${summary.policy}
- Accepted: ${summary.accepted}/${summary.cases}
- Estimated paid-tier cost: $${summary.estimated_cost_usd.toFixed(4)}
- Mean IoU: ${number(summary.metrics.mean_iou)}
- Mean delta versus classical tracer: ${number(summary.metrics.mean_delta_iou_vs_classical)}

| Case | Difficulty | Profile | Accepted | IoU | Classical IoU | Delta | Tokens | Est. cost | Latency |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
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
  const schemaValidator = ajv.compile(schema)
  const selected = selectCases(manifest, options)
  process.stdout.write(`Selected ${selected.length} case(s): ${selected.map((item) => item.id).join(', ')}\n`)
  if (options.dryRun) {
    process.stdout.write(`Dry run only. Model=${MODEL_ID}, calls=${selected.length}, test cases=0.\n`)
    return
  }
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.')
  const context = {
    apiKey,
    batchTimestamp: timestampId(),
    baselineById: new Map(baseline.results.map((item) => [item.id, item])),
    git: await gitState(),
    manifest,
    manifestBytes,
    resvgVersion: await rendererVersion(),
    schemaValidator,
  }
  const batchId = `${PIPELINE_NAME}-v1-${context.batchTimestamp}`
  const results = []
  for (const [index, corpusCase] of selected.entries()) {
    const spent = results.reduce((sum, item) => sum + item.estimated_cost_usd, 0)
    if (spent >= options.maxCostUsd) {
      process.stdout.write(`Stopping before ${corpusCase.id}: estimated batch cost reached $${spent.toFixed(4)}.\n`)
      break
    }
    process.stdout.write(`[${index + 1}/${selected.length}] ${corpusCase.id}: calling ${MODEL_ID}...\n`)
    const result = await runCase(context, corpusCase)
    results.push(result)
    process.stdout.write(
      `  ${result.accepted ? 'accepted' : 'rejected'}; IoU=${result.metrics.iou?.toFixed(4) ?? 'n/a'}; delta=${result.metrics.delta_iou_vs_classical?.toFixed(4) ?? 'n/a'}; tokens=${result.usage.total_tokens}; est. $${result.estimated_cost_usd.toFixed(4)}; ${(result.latency_ms / 1000).toFixed(1)}s\n`,
    )
  }
  const summary = summarize(results, batchId)
  const summariesDir = join(RUNS_DIR, 'summaries')
  await mkdir(summariesDir, { recursive: true })
  const jsonPath = join(summariesDir, `${batchId}.json`)
  const markdownPath = join(summariesDir, `${batchId}.md`)
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' }),
    writeFile(markdownPath, summaryMarkdown(summary), { flag: 'wx' }),
  ])
  process.stdout.write(`Summary: ${repositoryPath(markdownPath)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
