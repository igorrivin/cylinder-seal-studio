import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { formatFlatSvg } from '../../src/lib/svg'
import { DEFAULT_TRACE_SETTINGS } from '../../src/lib/tracing'
import { traceImageData } from '../../src/lib/vector-tracer'

const RASTER_SIZE = 1024
const METRIC_BINARY_THRESHOLD = 128
const PHYSICAL_WIDTH_MM = 39.89823
const PHYSICAL_HEIGHT_MM = 40
const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))
const GOLD_PATH = join(BENCHMARK_DIR, 'gold-standard.svg')
const OUTPUT_DIR = join(BENCHMARK_DIR, 'output')
const WRITE_ARTIFACTS = env.SVG_BENCHMARK_WRITE === '1'

const QUALITY_GATES = Object.freeze({
  iou: 0.84,
  precision: 0.9,
  recall: 0.91,
  disagreement: 0.03,
})

/**
 * Neutral production-style preprocessing isolates tracing quality from UI
 * transformations. `soften` is zero, so the thresholded raster remains binary.
 */
const PREPROCESSING_PROFILE = Object.freeze({
  threshold: 170,
  soften: 0,
  invert: false,
  mirror: false,
  seamBand: false,
})

interface PixelRaster {
  width: number
  height: number
  pixels: Uint8ClampedArray<ArrayBuffer>
}

interface RenderedRaster extends PixelRaster {
  png: Uint8Array
}

interface BinaryMetrics {
  iou: number
  precision: number
  recall: number
  disagreement: number
  grayscaleMae: number
  falsePositivePixels: number
  falseNegativePixels: number
}

interface TopologyMetrics {
  foregroundComponents: number
  backgroundHoles: number
}

interface SvgMetrics {
  bytes: number
  paths: number
  subpaths: number
  closes: number
  cubicCurves: number
  commands: number
  sha256: string
}

function canonicalPixelViewport(svg: string, width: number, height: number): string {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root) throw new Error('Benchmark input does not contain an SVG root element.')
  const withoutDimensions = root.replace(
    /\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  )
  const replacement = withoutDimensions.replace(/>$/, ` width="${width}" height="${height}">`)
  return svg.replace(root, replacement)
}

function renderSvg(
  svg: string,
  width: number,
  height: number,
  loadSystemFonts = false,
): RenderedRaster {
  const rendered = new Resvg(canonicalPixelViewport(svg, width, height), {
    background: '#ffffff',
    shapeRendering: 2,
    font: { loadSystemFonts },
  }).render()

  if (rendered.width !== width || rendered.height !== height) {
    throw new Error(
      `SVG renderer produced ${rendered.width}×${rendered.height}; expected ${width}×${height}.`,
    )
  }

  return {
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8ClampedArray(rendered.pixels),
    png: rendered.asPng(),
  }
}

function toImageData(raster: PixelRaster): ImageData {
  return {
    data: new Uint8ClampedArray(raster.pixels),
    width: raster.width,
    height: raster.height,
    colorSpace: 'srgb',
  } as ImageData
}

function luminance(pixels: Uint8ClampedArray<ArrayBuffer>, pixel: number): number {
  const offset = pixel * 4
  return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
}

function preprocessSourceRaster(source: PixelRaster): PixelRaster {
  if (PREPROCESSING_PROFILE.soften !== 0) {
    throw new Error('The semantic gold benchmark only supports neutral zero-softening preprocessing.')
  }
  const pixelCount = source.width * source.height
  if (source.pixels.length !== pixelCount * 4) {
    throw new Error('Semantic source raster dimensions do not match its RGBA data.')
  }

  const pixels = new Uint8ClampedArray(source.pixels.length)
  for (let destination = 0; destination < pixelCount; destination += 1) {
    const x = destination % source.width
    const y = Math.floor(destination / source.width)
    const sourceX = PREPROCESSING_PROFILE.mirror ? source.width - 1 - x : x
    const sourcePixel = y * source.width + sourceX
    let foreground = luminance(source.pixels, sourcePixel) < PREPROCESSING_PROFILE.threshold
    if (PREPROCESSING_PROFILE.invert) foreground = !foreground
    const value = foreground ? 0 : 255
    const offset = destination * 4
    pixels[offset] = value
    pixels[offset + 1] = value
    pixels[offset + 2] = value
    pixels[offset + 3] = 255
  }

  if (PREPROCESSING_PROFILE.seamBand) {
    throw new Error('The semantic gold benchmark neutral profile must not add seam bands.')
  }
  return { width: source.width, height: source.height, pixels }
}

function binaryMask(pixels: Uint8ClampedArray<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const mask = new Uint8Array(pixels.length / 4)
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = luminance(pixels, pixel) < METRIC_BINARY_THRESHOLD ? 1 : 0
  }
  return mask
}

function compareRasters(
  gold: Uint8ClampedArray<ArrayBuffer>,
  traced: Uint8ClampedArray<ArrayBuffer>,
): BinaryMetrics {
  if (gold.length !== traced.length || gold.length % 4 !== 0) {
    throw new Error('Benchmark rasters must have identical RGBA dimensions.')
  }

  let intersection = 0
  let union = 0
  let expectedForeground = 0
  let predictedForeground = 0
  let disagreements = 0
  let falsePositivePixels = 0
  let falseNegativePixels = 0
  let absoluteGrayError = 0
  const pixelCount = gold.length / 4

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const expected = luminance(gold, pixel) < METRIC_BINARY_THRESHOLD
    const predicted = luminance(traced, pixel) < METRIC_BINARY_THRESHOLD
    if (expected) expectedForeground += 1
    if (predicted) predictedForeground += 1
    if (expected && predicted) intersection += 1
    if (expected || predicted) union += 1
    if (expected !== predicted) disagreements += 1
    if (!expected && predicted) falsePositivePixels += 1
    if (expected && !predicted) falseNegativePixels += 1
    absoluteGrayError += Math.abs(luminance(gold, pixel) - luminance(traced, pixel))
  }

  if (union === 0 || expectedForeground === 0 || predictedForeground === 0) {
    throw new Error('Gold benchmark and traced result must both contain foreground artwork.')
  }

  return {
    iou: intersection / union,
    precision: intersection / predictedForeground,
    recall: intersection / expectedForeground,
    disagreement: disagreements / pixelCount,
    grayscaleMae: absoluteGrayError / (pixelCount * 255),
    falsePositivePixels,
    falseNegativePixels,
  }
}

function componentCounts(
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  foreground: boolean,
): { components: number; enclosed: number } {
  if (mask.length !== width * height) throw new Error('Topology mask dimensions do not match.')
  const wanted = foreground ? 1 : 0
  const visited = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  let components = 0
  let enclosed = 0

  for (let start = 0; start < mask.length; start += 1) {
    if (visited[start] || mask[start] !== wanted) continue
    components += 1
    let head = 0
    let tail = 0
    let touchesBorder = false
    queue[tail] = start
    tail += 1
    visited[start] = 1

    while (head < tail) {
      const current = queue[head]
      head += 1
      const x = current % width
      const y = Math.floor(current / width)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true

      if (x > 0) tail = enqueue(current - 1, wanted, mask, visited, queue, tail)
      if (x + 1 < width) tail = enqueue(current + 1, wanted, mask, visited, queue, tail)
      if (y > 0) tail = enqueue(current - width, wanted, mask, visited, queue, tail)
      if (y + 1 < height) tail = enqueue(current + width, wanted, mask, visited, queue, tail)
    }

    if (!touchesBorder) enclosed += 1
  }

  return { components, enclosed }
}

function enqueue(
  index: number,
  wanted: number,
  mask: Uint8Array<ArrayBuffer>,
  visited: Uint8Array<ArrayBuffer>,
  queue: Int32Array<ArrayBuffer>,
  tail: number,
): number {
  if (visited[index] || mask[index] !== wanted) return tail
  visited[index] = 1
  queue[tail] = index
  return tail + 1
}

function topology(mask: Uint8Array<ArrayBuffer>, width: number, height: number): TopologyMetrics {
  return {
    foregroundComponents: componentCounts(mask, width, height, true).components,
    backgroundHoles: componentCounts(mask, width, height, false).enclosed,
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function pathTags(svg: string): string[] {
  return svg.match(/<path\b[^>]*>/gis) ?? []
}

function svgMetrics(svg: string): SvgMetrics {
  const paths = pathTags(svg)
  const pathData = paths.flatMap((path) => {
    const data = path.match(/\bd\s*=\s*(["'])(.*?)\1/is)?.[2]
    return data === undefined ? [] : [data]
  })
  const count = (pattern: RegExp) =>
    pathData.reduce((total, data) => total + (data.match(pattern)?.length ?? 0), 0)

  return {
    bytes: Buffer.byteLength(svg),
    paths: paths.length,
    subpaths: count(/[Mm]/g),
    closes: count(/[Zz]/g),
    cubicCurves: count(/[Cc]/g),
    commands: count(/[AaCcHhLlMmQqSsTtVvZz]/g),
    sha256: sha256(svg),
  }
}

function isCompleteSvg(svg: string): boolean {
  return /<svg\b[^>]*>[\s\S]*<\/svg\s*>/i.test(svg)
}

function isSelfContainedSemanticSvg(svg: string): boolean {
  const references = [...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gis)].map(
    (match) => match[2],
  )
  return (
    isCompleteSvg(svg) &&
    /<symbol\b/i.test(svg) &&
    /<use\b/i.test(svg) &&
    !/<(?:embed|filter|foreignObject|iframe|image|mask|object|script)\b/i.test(svg) &&
    !/@(?:font-face|import)\b|\burl\s*\(/i.test(svg) &&
    references.length > 0 &&
    references.every((reference) => reference.startsWith('#'))
  )
}

function hasStroke(path: string): boolean {
  if (/\bstroke(?:-[\w:-]+)?\s*=/i.test(path)) return true
  const style = path.match(/\bstyle\s*=\s*(["'])(.*?)\1/is)?.[2] ?? ''
  return /(?:^|;)\s*stroke(?:-[\w-]+)?\s*:/i.test(style)
}

function isWhitePaint(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, '')
  if (normalized === 'white' || normalized === '#fff' || normalized === '#ffffff') return true
  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (!rgb) return false
  const channels = rgb[1].split(',').slice(0, 3)
  return channels.length === 3 && channels.every((channel) => channel === '255' || channel === '100%')
}

function hasWhiteFill(path: string): boolean {
  const fill = path.match(/\bfill\s*=\s*(["'])(.*?)\1/is)?.[2]
  if (fill && isWhitePaint(fill)) return true
  const style = path.match(/\bstyle\s*=\s*(["'])(.*?)\1/is)?.[2] ?? ''
  for (const declaration of style.split(';')) {
    const match = declaration.match(/^\s*fill\s*:\s*(.*?)\s*$/i)
    if (match && isWhitePaint(match[1])) return true
  }
  return false
}

function binaryRasterSvg(mask: Uint8Array<ArrayBuffer>): string {
  if (mask.length !== RASTER_SIZE * RASTER_SIZE) {
    throw new Error('Processed gold mask dimensions do not match the benchmark viewport.')
  }
  let foregroundPath = ''
  for (let y = 0; y < RASTER_SIZE; y += 1) {
    let x = 0
    while (x < RASTER_SIZE) {
      while (x < RASTER_SIZE && mask[y * RASTER_SIZE + x] === 0) x += 1
      if (x === RASTER_SIZE) break
      const start = x
      while (x < RASTER_SIZE && mask[y * RASTER_SIZE + x] === 1) x += 1
      foregroundPath += `M${start} ${y}h${x - start}v1H${start}Z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_SIZE}" height="${RASTER_SIZE}" viewBox="0 0 ${RASTER_SIZE} ${RASTER_SIZE}"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${foregroundPath}"/></svg>\n`
}

function diffSvg(gold: Uint8Array<ArrayBuffer>, traced: Uint8Array<ArrayBuffer>): string {
  let falsePositivePath = ''
  let falseNegativePath = ''

  for (let y = 0; y < RASTER_SIZE; y += 1) {
    let x = 0
    while (x < RASTER_SIZE) {
      const index = y * RASTER_SIZE + x
      const kind = gold[index] === traced[index] ? 0 : traced[index] ? 1 : 2
      if (kind === 0) {
        x += 1
        continue
      }
      const start = x
      x += 1
      while (x < RASTER_SIZE) {
        const next = y * RASTER_SIZE + x
        const nextKind = gold[next] === traced[next] ? 0 : traced[next] ? 1 : 2
        if (nextKind !== kind) break
        x += 1
      }
      const run = `M${start} ${y}h${x - start}v1H${start}Z`
      if (kind === 1) falsePositivePath += run
      else falseNegativePath += run
    }
  }

  const falsePositives = falsePositivePath ? `<path fill="#2563eb" d="${falsePositivePath}"/>` : ''
  const falseNegatives = falseNegativePath ? `<path fill="#dc2626" d="${falseNegativePath}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_SIZE}" height="${RASTER_SIZE}" viewBox="0 0 ${RASTER_SIZE} ${RASTER_SIZE}"><rect width="100%" height="100%" fill="#fff"/>${falsePositives}${falseNegatives}</svg>\n`
}

function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

function comparisonSvg(
  processedGoldPng: Uint8Array,
  tracedPng: Uint8Array,
  differencePng: Uint8Array,
  metrics: BinaryMetrics,
): { svg: string; width: number; height: number } {
  const padding = 24
  const gap = 24
  const header = 48
  const footer = 54
  const width = padding * 2 + RASTER_SIZE * 3 + gap * 2
  const height = padding * 2 + header + RASTER_SIZE + footer
  const firstX = padding
  const secondX = firstX + RASTER_SIZE + gap
  const thirdX = secondX + RASTER_SIZE + gap
  const imageY = padding + header
  const labelY = padding + 30
  const footerY = imageY + RASTER_SIZE + 34
  const labelStyle = 'font:600 22px sans-serif;fill:#111827'
  const detailStyle = 'font:18px monospace;fill:#374151'

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f3f4f6"/>
  <text x="${firstX}" y="${labelY}" style="${labelStyle}">Processed gold (exact tracer input)</text>
  <text x="${secondX}" y="${labelY}" style="${labelStyle}">Production VTracer result</text>
  <text x="${thirdX}" y="${labelY}" style="${labelStyle}">Difference: blue + / red −</text>
  <image x="${firstX}" y="${imageY}" width="${RASTER_SIZE}" height="${RASTER_SIZE}" href="${pngDataUrl(processedGoldPng)}"/>
  <image x="${secondX}" y="${imageY}" width="${RASTER_SIZE}" height="${RASTER_SIZE}" href="${pngDataUrl(tracedPng)}"/>
  <image x="${thirdX}" y="${imageY}" width="${RASTER_SIZE}" height="${RASTER_SIZE}" href="${pngDataUrl(differencePng)}"/>
  <text x="${firstX}" y="${footerY}" style="${detailStyle}">IoU ${metrics.iou.toFixed(6)} · precision ${metrics.precision.toFixed(6)} · recall ${metrics.recall.toFixed(6)} · disagreement ${metrics.disagreement.toFixed(6)} · gray MAE ${metrics.grayscaleMae.toFixed(6)}</text>
</svg>\n`
  return { svg, width, height }
}

function markdownReport(report: BenchmarkReport): string {
  const pass = (value: boolean) => (value ? 'pass' : 'FAIL')
  return `# Semantic SVG gold benchmark

The semantic SVG is rendered at ${RASTER_SIZE} × ${RASTER_SIZE}, passed through the documented neutral preprocessing profile, and the production tracer is measured against that exact opaque black/white input raster.

Preprocessing: threshold **${report.preprocessing.threshold}**, soften **${report.preprocessing.soften}**, invert **${report.preprocessing.invert}**, mirror **${report.preprocessing.mirror}**, seam band **${report.preprocessing.seamBand}**.

| Visual metric | Result | Gate | Status |
| --- | ---: | ---: | --- |
| Foreground IoU | ${report.visual.iou.toFixed(6)} | ≥ ${QUALITY_GATES.iou} | ${pass(report.gates.iou)} |
| Precision | ${report.visual.precision.toFixed(6)} | ≥ ${QUALITY_GATES.precision} | ${pass(report.gates.precision)} |
| Recall | ${report.visual.recall.toFixed(6)} | ≥ ${QUALITY_GATES.recall} | ${pass(report.gates.recall)} |
| Pixel disagreement | ${report.visual.disagreement.toFixed(6)} | ≤ ${QUALITY_GATES.disagreement} | ${pass(report.gates.disagreement)} |
| Normalized grayscale MAE | ${report.visual.grayscaleMae.toFixed(6)} | diagnostic | — |

## Topology

| Raster | Foreground components | Background holes |
| --- | ---: | ---: |
| Processed gold (tracer input) | ${report.topology.processedGold.foregroundComponents} | ${report.topology.processedGold.backgroundHoles} |
| Traced | ${report.topology.traced.foregroundComponents} | ${report.topology.traced.backgroundHoles} |

## SVG structure

| SVG | Bytes | Paths | Subpaths | Cubic curves | Commands | SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Gold source | ${report.svg.gold.bytes} | ${report.svg.gold.paths} | ${report.svg.gold.subpaths} | ${report.svg.gold.cubicCurves} | ${report.svg.gold.commands} | \`${report.svg.gold.sha256}\` |
| Raw trace | ${report.svg.rawTrace.bytes} | ${report.svg.rawTrace.paths} | ${report.svg.rawTrace.subpaths} | ${report.svg.rawTrace.cubicCurves} | ${report.svg.rawTrace.commands} | \`${report.svg.rawTrace.sha256}\` |
| Normalized trace | ${report.svg.normalizedTrace.bytes} | ${report.svg.normalizedTrace.paths} | ${report.svg.normalizedTrace.subpaths} | ${report.svg.normalizedTrace.cubicCurves} | ${report.svg.normalizedTrace.commands} | \`${report.svg.normalizedTrace.sha256}\` |

The gold source remained self-contained semantic SVG: **${report.gates.semanticGold ? 'yes' : 'no'}**. The trace was deterministic: **${report.deterministic ? 'yes' : 'no'}**. Overall quality gate: **${report.gates.all ? 'PASS' : 'FAIL'}**.
`
}

interface BenchmarkReport {
  schemaVersion: 1
  raster: { width: number; height: number; metricBinaryThreshold: number }
  preprocessing: typeof PREPROCESSING_PROFILE
  physicalOutputMm: { width: number; height: number }
  traceSettings: typeof DEFAULT_TRACE_SETTINGS
  deterministic: boolean
  visual: BinaryMetrics
  topology: { processedGold: TopologyMetrics; traced: TopologyMetrics }
  svg: { gold: SvgMetrics; rawTrace: SvgMetrics; normalizedTrace: SvgMetrics }
  rasterHashes: {
    sourcePng: string
    processedGoldRgba: string
    processedGoldPng: string
    tracedPng: string
  }
  gates: {
    iou: boolean
    precision: boolean
    recall: boolean
    disagreement: boolean
    validSvg: boolean
    semanticGold: boolean
    deterministic: boolean
    all: boolean
  }
}

async function writeArtifacts(
  source: RenderedRaster,
  processedGold: RenderedRaster,
  normalizedTrace: string,
  traced: RenderedRaster,
  processedGoldMask: Uint8Array<ArrayBuffer>,
  tracedMask: Uint8Array<ArrayBuffer>,
  report: BenchmarkReport,
): Promise<void> {
  const differenceSvg = diffSvg(processedGoldMask, tracedMask)
  const difference = renderSvg(differenceSvg, RASTER_SIZE, RASTER_SIZE)
  const comparison = comparisonSvg(processedGold.png, traced.png, difference.png, report.visual)
  const comparisonRaster = renderSvg(comparison.svg, comparison.width, comparison.height, true)

  await mkdir(OUTPUT_DIR, { recursive: true })
  await Promise.all([
    writeFile(join(OUTPUT_DIR, 'source-raster.png'), source.png),
    writeFile(join(OUTPUT_DIR, 'processed-gold-raster.png'), processedGold.png),
    writeFile(join(OUTPUT_DIR, 'traced.svg'), normalizedTrace),
    writeFile(join(OUTPUT_DIR, 'traced-raster.png'), traced.png),
    writeFile(join(OUTPUT_DIR, 'diff.svg'), differenceSvg),
    writeFile(join(OUTPUT_DIR, 'diff.png'), difference.png),
    writeFile(join(OUTPUT_DIR, 'comparison.svg'), comparison.svg),
    writeFile(join(OUTPUT_DIR, 'comparison.png'), comparisonRaster.png),
    writeFile(join(OUTPUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(OUTPUT_DIR, 'report.md'), markdownReport(report)),
  ])
}

describe('semantic SVG gold benchmark', () => {
  it('keeps the production trace deterministic and above the visual quality floor', { timeout: 30_000 }, async () => {
    const goldSvg = await readFile(GOLD_PATH, 'utf8')
    const source = renderSvg(goldSvg, RASTER_SIZE, RASTER_SIZE)
    const processedGold = preprocessSourceRaster(source)
    const processedGoldMask = binaryMask(processedGold.pixels)
    const processedGoldArtifact = renderSvg(
      binaryRasterSvg(processedGoldMask),
      RASTER_SIZE,
      RASTER_SIZE,
    )
    const processedArtifactExact = byteArraysEqual(
      processedGold.pixels,
      processedGoldArtifact.pixels,
    )
    const firstRawTrace = traceImageData(toImageData(processedGold), { ...DEFAULT_TRACE_SETTINGS })
    const secondRawTrace = traceImageData(toImageData(processedGold), { ...DEFAULT_TRACE_SETTINGS })
    const deterministic = firstRawTrace === secondRawTrace
    const semanticGold = isSelfContainedSemanticSvg(goldSvg)
    const normalizedTrace = formatFlatSvg(
      firstRawTrace,
      RASTER_SIZE,
      RASTER_SIZE,
      PHYSICAL_WIDTH_MM,
      PHYSICAL_HEIGHT_MM,
    )
    const traced = renderSvg(normalizedTrace, RASTER_SIZE, RASTER_SIZE)
    const tracedMask = binaryMask(traced.pixels)
    const visual = compareRasters(processedGold.pixels, traced.pixels)
    const normalizedPaths = pathTags(normalizedTrace)
    const validSvg =
      isCompleteSvg(normalizedTrace) &&
      !/NaN|Infinity/.test(normalizedTrace) &&
      normalizedPaths.length > 0 &&
      normalizedPaths.every((path) => !hasStroke(path) && !hasWhiteFill(path))

    const gates = {
      iou: visual.iou >= QUALITY_GATES.iou,
      precision: visual.precision >= QUALITY_GATES.precision,
      recall: visual.recall >= QUALITY_GATES.recall,
      disagreement: visual.disagreement <= QUALITY_GATES.disagreement,
      validSvg,
      semanticGold,
      deterministic,
      all: false,
    }
    gates.all = Object.entries(gates).every(([name, passed]) => name === 'all' || passed)

    const report: BenchmarkReport = {
      schemaVersion: 1,
      raster: {
        width: RASTER_SIZE,
        height: RASTER_SIZE,
        metricBinaryThreshold: METRIC_BINARY_THRESHOLD,
      },
      preprocessing: PREPROCESSING_PROFILE,
      physicalOutputMm: { width: PHYSICAL_WIDTH_MM, height: PHYSICAL_HEIGHT_MM },
      traceSettings: DEFAULT_TRACE_SETTINGS,
      deterministic,
      visual,
      topology: {
        processedGold: topology(processedGoldMask, RASTER_SIZE, RASTER_SIZE),
        traced: topology(tracedMask, RASTER_SIZE, RASTER_SIZE),
      },
      svg: {
        gold: svgMetrics(goldSvg),
        rawTrace: svgMetrics(firstRawTrace),
        normalizedTrace: svgMetrics(normalizedTrace),
      },
      rasterHashes: {
        sourcePng: sha256(source.png),
        processedGoldRgba: sha256(processedGold.pixels),
        processedGoldPng: sha256(processedGoldArtifact.png),
        tracedPng: sha256(traced.png),
      },
      gates,
    }

    if (WRITE_ARTIFACTS) {
      await writeArtifacts(
        source,
        processedGoldArtifact,
        normalizedTrace,
        traced,
        processedGoldMask,
        tracedMask,
        report,
      )
    }

    expect(deterministic).toBe(true)
    expect(semanticGold).toBe(true)
    expect(processedArtifactExact).toBe(true)
    expect(normalizedTrace).toContain(`width="${PHYSICAL_WIDTH_MM}mm"`)
    expect(normalizedTrace).toContain(`height="${PHYSICAL_HEIGHT_MM}mm"`)
    expect(normalizedTrace).toContain(`viewBox="0 0 ${RASTER_SIZE} ${RASTER_SIZE}"`)
    expect(validSvg).toBe(true)
    expect(visual.iou).toBeGreaterThanOrEqual(QUALITY_GATES.iou)
    expect(visual.precision).toBeGreaterThanOrEqual(QUALITY_GATES.precision)
    expect(visual.recall).toBeGreaterThanOrEqual(QUALITY_GATES.recall)
    expect(visual.disagreement).toBeLessThanOrEqual(QUALITY_GATES.disagreement)
  })
})
