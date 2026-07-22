import { describe, expect, it } from 'vitest'
import { formatFlatSvg } from './svg'
import { DEFAULT_TRACE_SETTINGS } from './tracing'
import { toVectorTracerOptions, traceImageData } from './vector-tracer'

function topologyFixture(): ImageData {
  const width = 32
  const height = 32
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const setGray = (x: number, y: number, value: number) => {
    const offset = (y * width + x) * 4
    data[offset] = value
    data[offset + 1] = value
    data[offset + 2] = value
  }

  for (let y = 4; y <= 27; y++) {
    for (let x = 4; x <= 27; x++) setGray(x, y, 0)
  }
  for (let y = 10; y <= 21; y++) {
    for (let x = 10; x <= 21; x++) setGray(x, y, 255)
  }
  setGray(1, 1, 0)

  return { data, width, height, colorSpace: 'srgb' } as unknown as ImageData
}

describe('VTracer option adapter', () => {
  it('converts the human-readable angle settings to radians', () => {
    const result = toVectorTracerOptions({
      ...DEFAULT_TRACE_SETTINGS,
      cornerThresholdDegrees: 60,
      spliceThresholdDegrees: 45,
    })

    expect(result.cornerThreshold).toBeCloseTo(Math.PI / 3, 12)
    expect(result.spliceThreshold).toBeCloseTo(Math.PI / 4, 12)
    expect(result.lengthThreshold).toBe(4)
    expect(result.filterSpeckle).toBe(16)
    expect(result.pathPrecision).toBe(2)
  })

  it('deterministically traces smooth compound paths while filtering one-pixel noise', () => {
    const imageData = topologyFixture()
    const first = traceImageData(imageData, { ...DEFAULT_TRACE_SETTINGS })
    const second = traceImageData(imageData, { ...DEFAULT_TRACE_SETTINGS })
    const paths = first.match(/<path\b[^>]*\bd=(['"])(.*?)\1[^>]*\/>/gis) ?? []
    const pathData = first.match(/\bd=(['"])(.*?)\1/is)?.[2] ?? ''

    expect(second).toBe(first)
    expect(paths).toHaveLength(1)
    expect(pathData.match(/M/g)).toHaveLength(2)
    expect(pathData).toMatch(/C/)
    expect(first).not.toMatch(/NaN|Infinity/)

    const formatted = formatFlatSvg(first, imageData.width, imageData.height, 50, 25)
    expect(formatted).toContain('width="50mm"')
    expect(formatted).toContain('height="25mm"')
    expect(formatted).toContain('viewBox="0 0 32 32"')
    expect(formatted).toContain('transform="translate(4,4)"')
  })
})
