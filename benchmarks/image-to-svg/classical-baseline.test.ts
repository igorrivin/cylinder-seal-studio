import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { formatFlatSvg } from '../../src/lib/svg'
import { DEFAULT_TRACE_SETTINGS } from '../../src/lib/tracing'
import { traceImageData } from '../../src/lib/vector-tracer'
import { assertCorpusManifest } from './validate'

const SIZE = 512
const PREPROCESS_THRESHOLD = 170
const METRIC_THRESHOLD = 128
const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_DIR = join(BENCHMARK_DIR, '..', '..')
const MANIFEST_PATH = join(BENCHMARK_DIR, 'manifest.json')
const OUTPUT_DIR = join(BENCHMARK_DIR, 'baseline')
const WRITE_ARTIFACTS = env.SVG_CORPUS_WRITE === '1'

interface CorpusCase {
  id: string
  title: string
  split: 'development' | 'validation' | 'test'
  input: { path: string; profile: string }
  reference: { render: { path: string } }
}

interface CorpusManifest {
  schema_version: '1.0.0'
  corpus: { id: string; version: string; case_count: number }
  cases: CorpusCase[]
}

interface Raster {
  width: number
  height: number
  pixels: Uint8ClampedArray<ArrayBuffer>
}

interface Metrics {
  iou: number
  precision: number
  recall: number
  disagreement: number
}

interface CaseResult extends Metrics {
  id: string
  split: CorpusCase['split']
  profile: string
  traceBytes: number
}

function decodePng(png: Uint8Array): Raster {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="100%" height="100%" fill="#fff"/><image width="${SIZE}" height="${SIZE}" href="${dataUrl}"/></svg>`
  const rendered = new Resvg(svg, { background: '#ffffff', shapeRendering: 2 }).render()
  if (rendered.width !== SIZE || rendered.height !== SIZE) {
    throw new Error(`PNG decoder produced ${rendered.width}×${rendered.height}.`)
  }
  return {
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8ClampedArray(rendered.pixels),
  }
}

function renderSvg(svg: string): Raster {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root) throw new Error('Tracer output does not contain an SVG root.')
  const resizedRoot = root
    .replace(/\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/>$/, ` width="${SIZE}" height="${SIZE}">`)
  const rendered = new Resvg(svg.replace(root, resizedRoot), {
    background: '#ffffff',
    shapeRendering: 2,
  }).render()
  return {
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8ClampedArray(rendered.pixels),
  }
}

function luminance(pixels: Uint8ClampedArray<ArrayBuffer>, pixel: number): number {
  const offset = pixel * 4
  return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
}

function threshold(raster: Raster, cutoff: number): Raster {
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

function toImageData(raster: Raster): ImageData {
  return {
    data: new Uint8ClampedArray(raster.pixels),
    width: raster.width,
    height: raster.height,
    colorSpace: 'srgb',
  } as ImageData
}

function compare(expected: Raster, actual: Raster): Metrics {
  if (expected.pixels.length !== actual.pixels.length) {
    throw new Error('Baseline rasters have different dimensions.')
  }
  let intersection = 0
  let union = 0
  let expectedForeground = 0
  let actualForeground = 0
  let disagreements = 0
  const pixelCount = expected.width * expected.height
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const wanted = luminance(expected.pixels, pixel) < METRIC_THRESHOLD
    const received = luminance(actual.pixels, pixel) < METRIC_THRESHOLD
    if (wanted) expectedForeground += 1
    if (received) actualForeground += 1
    if (wanted && received) intersection += 1
    if (wanted || received) union += 1
    if (wanted !== received) disagreements += 1
  }
  if (union === 0 || expectedForeground === 0 || actualForeground === 0) {
    throw new Error('Baseline comparison requires foreground in both rasters.')
  }
  return {
    iou: intersection / union,
    precision: intersection / actualForeground,
    recall: intersection / expectedForeground,
    disagreement: disagreements / pixelCount,
  }
}

function summarize(results: CaseResult[]): Record<string, number> {
  return {
    cases: results.length,
    meanIou: results.reduce((sum, row) => sum + row.iou, 0) / results.length,
    minimumIou: Math.min(...results.map((row) => row.iou)),
    meanPrecision: results.reduce((sum, row) => sum + row.precision, 0) / results.length,
    meanRecall: results.reduce((sum, row) => sum + row.recall, 0) / results.length,
    meanDisagreement:
      results.reduce((sum, row) => sum + row.disagreement, 0) / results.length,
  }
}

function aggregate(
  results: CaseResult[],
  groupBy: 'profile' | 'split',
): Record<string, Record<string, number>> {
  const groups = new Map<string, CaseResult[]>()
  for (const result of results) {
    const rows = groups.get(result[groupBy]) ?? []
    rows.push(result)
    groups.set(result[groupBy], rows)
  }
  return Object.fromEntries(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, rows]) => [
      name,
      summarize(rows),
    ]),
  )
}

function markdownReport(report: {
  corpus: CorpusManifest['corpus']
  preprocessingThreshold: number
  results: CaseResult[]
  overall: Record<string, number>
  byProfile: Record<string, Record<string, number>>
  bySplit: Record<string, Record<string, number>>
}): string {
  const summaryRow = (name: string, metrics: Record<string, number>) =>
    `| ${name} | ${metrics.cases} | ${metrics.meanIou.toFixed(4)} | ${metrics.minimumIou.toFixed(4)} | ${metrics.meanPrecision.toFixed(4)} | ${metrics.meanRecall.toFixed(4)} | ${metrics.meanDisagreement.toFixed(4)} |`
  const profileRows = Object.entries(report.byProfile)
    .map(([profile, metrics]) => summaryRow(profile, metrics))
    .join('\n')
  const splitRows = Object.entries(report.bySplit)
    .map(([split, metrics]) => summaryRow(split, metrics))
    .join('\n')
  const caseRows = report.results
    .map(
      (result) =>
        `| ${result.id} | ${result.split} | ${result.profile} | ${result.iou.toFixed(4)} | ${result.precision.toFixed(4)} | ${result.recall.toFixed(4)} | ${result.disagreement.toFixed(4)} | ${result.traceBytes.toLocaleString('en-US')} |`,
    )
    .join('\n')
  return `# Classical tracer corpus baseline

This diagnostic baseline applies a luminance threshold of ${report.preprocessingThreshold} to each committed raster input, runs the production VTracer adapter, and compares its rendered output with the clean vector oracle. It is not an LLM score and deliberately has no aggregate quality gate; its purpose is to make future semantic-model improvements measurable against the current product.

Each oracle has only one raster profile in v1. Profile and split summaries are descriptive smoke diagnostics, not causal robustness comparisons, because source identity and difficulty are confounded with those groups.

## Overall summary

| Scope | Cases | Mean IoU | Minimum IoU | Mean precision | Mean recall | Mean disagreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${summaryRow('all cases', report.overall)}

## Profile summary

| Input profile | Cases | Mean IoU | Minimum IoU | Mean precision | Mean recall | Mean disagreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${profileRows}

## Split summary

| Split | Cases | Mean IoU | Minimum IoU | Mean precision | Mean recall | Mean disagreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${splitRows}

## Per-case results

| Case | Split | Profile | IoU | Precision | Recall | Disagreement | Trace bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
${caseRows}
`
}

describe('image-to-SVG corpus classical baseline', () => {
  it('processes every frozen case through the production tracer', { timeout: 60_000 }, async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as CorpusManifest
    assertCorpusManifest(manifest)
    expect(manifest.schema_version).toBe('1.0.0')
    expect(manifest.cases).toHaveLength(40)
    expect(manifest.corpus.case_count).toBe(40)

    const results: CaseResult[] = []
    for (const fixture of manifest.cases) {
      const [inputPng, referencePng] = await Promise.all([
        readFile(join(REPOSITORY_DIR, fixture.input.path)),
        readFile(join(REPOSITORY_DIR, fixture.reference.render.path)),
      ])
      const processedInput = threshold(decodePng(inputPng), PREPROCESS_THRESHOLD)
      const expected = threshold(decodePng(referencePng), PREPROCESS_THRESHOLD)
      const rawTrace = traceImageData(toImageData(processedInput), { ...DEFAULT_TRACE_SETTINGS })
      const normalized = formatFlatSvg(rawTrace, SIZE, SIZE, 40, 40)
      const traced = renderSvg(normalized)
      const metrics = compare(expected, traced)
      expect(normalized).toMatch(/<svg\b[\s\S]*<path\b[\s\S]*<\/svg>\s*$/)
      expect(normalized).not.toMatch(/NaN|Infinity|<(?:image|script)\b/i)
      for (const [name, value] of Object.entries(metrics)) {
        expect(Number.isFinite(value), `${fixture.id}/${name}`).toBe(true)
        expect(value, `${fixture.id}/${name}`).toBeGreaterThanOrEqual(0)
        expect(value, `${fixture.id}/${name}`).toBeLessThanOrEqual(1)
      }
      results.push({
        id: fixture.id,
        split: fixture.split,
        profile: fixture.input.profile,
        traceBytes: Buffer.byteLength(normalized),
        ...metrics,
      })
    }

    const overall = summarize(results)
    const byProfile = aggregate(results, 'profile')
    const bySplit = aggregate(results, 'split')
    const report = {
      schemaVersion: '1.0.0',
      corpus: manifest.corpus,
      preprocessingThreshold: PREPROCESS_THRESHOLD,
      traceSettings: DEFAULT_TRACE_SETTINGS,
      results,
      overall,
      byProfile,
      bySplit,
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    const reportMarkdown = markdownReport(report)
    if (WRITE_ARTIFACTS) {
      await mkdir(OUTPUT_DIR, { recursive: true })
      await Promise.all([
        writeFile(join(OUTPUT_DIR, 'report.json'), reportJson),
        writeFile(join(OUTPUT_DIR, 'report.md'), reportMarkdown),
      ])
    } else {
      const [storedJson, storedMarkdown] = await Promise.all([
        readFile(join(OUTPUT_DIR, 'report.json'), 'utf8'),
        readFile(join(OUTPUT_DIR, 'report.md'), 'utf8'),
      ])
      expect(storedJson).toBe(reportJson)
      expect(storedMarkdown).toBe(reportMarkdown)
    }

    expect(Object.values(byProfile).reduce((sum, profile) => sum + profile.cases, 0)).toBe(40)
  })
})
