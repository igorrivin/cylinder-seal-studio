import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  MAX_MESH_TRIANGLES,
  SealValidationError,
  blurHeightData,
  buildCylinderMesh,
  meshToBinarySTL,
  validateHeightField,
  validateSealParams,
  type HeightSamples,
  type Mesh,
  type SealParams,
} from './seal'

const field = (data: number[], w: number, h: number): HeightSamples => ({
  data: new Float32Array(data),
  w,
  h,
})

const params = (changes: Partial<SealParams> = {}): SealParams => ({
  ...DEFAULT_PARAMS,
  diameterMm: 10,
  heightMm: 2,
  segments: 32,
  ...changes,
})

describe('validateSealParams', () => {
  it('accepts the defaults and provides an exact mesh estimate', () => {
    const result = validateSealParams(DEFAULT_PARAMS)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.estimate?.triangles).toBeGreaterThan(0)
    expect(result.estimate?.stlBytes).toBe(84 + (result.estimate?.triangles ?? 0) * 50)
  })

  it('rejects non-finite and zero geometry before deriving allocations', () => {
    const result = validateSealParams(params({ diameterMm: 0, heightMm: Number.NaN }))

    expect(result.valid).toBe(false)
    expect(result.issues.map(({ field: issueField }) => issueField)).toEqual(
      expect.arrayContaining(['diameterMm', 'heightMm']),
    )
    expect(result.estimate).toBeNull()
  })

  it('blocks meshes over the browser budget', () => {
    const result = validateSealParams(params({ diameterMm: 1, heightMm: 2000, segments: 2048 }))

    expect(result.estimate?.triangles).toBeGreaterThan(MAX_MESH_TRIANGLES)
    expect(result.issues).toContainEqual(expect.objectContaining({ field: 'mesh' }))
  })

  it('rejects a bore that cannot leave material under recessed relief', () => {
    const result = validateSealParams(
      params({ body: 'bore', diameterMm: 10, reliefMm: 2, mode: 'recessed', holeMm: 6 }),
    )

    expect(result.issues).toContainEqual(expect.objectContaining({ field: 'holeMm' }))
  })

  it('rejects a shell wall that intersects the deepest relief', () => {
    const result = validateSealParams(
      params({ body: 'shell', diameterMm: 10, reliefMm: 2, mode: 'recessed', wallMm: 3 }),
    )

    expect(result.issues).toContainEqual(expect.objectContaining({ field: 'wallMm' }))
  })

  it('validates image controls as part of the central parameter contract', () => {
    const result = validateSealParams(params({ threshold: Number.POSITIVE_INFINITY, soften: -1 }))

    expect(result.issues.map(({ field: issueField }) => issueField)).toEqual(
      expect.arrayContaining(['threshold', 'soften']),
    )
  })
})

describe('height fields and mesh construction', () => {
  it('rejects shape mismatches and samples outside the normalized range', () => {
    expect(validateHeightField(field([0], 2, 2))).toContainEqual(expect.stringContaining('expected 4'))
    expect(validateHeightField(field([0, 2], 2, 1))).toContainEqual(expect.stringContaining('from 0 to 1'))
  })

  it('supports one-pixel-wide and one-pixel-high fields', () => {
    for (const samples of [field([0, 1], 1, 2), field([0, 1], 2, 1), field([0.5], 1, 1)]) {
      const mesh = buildCylinderMesh(samples, params())
      expect(mesh.indices).toBeInstanceOf(Uint32Array)
      expect(mesh.indices.length).toBe(mesh.triangles * 3)
      expect([...mesh.positions].every(Number.isFinite)).toBe(true)
    }
  })

  it('throws instead of silently changing invalid body geometry', () => {
    expect(() =>
      buildCylinderMesh(field([1], 1, 1), params({ body: 'bore', holeMm: 20 })),
    ).toThrow(SealValidationError)
  })

  it.each([
    { body: 'solid' as const },
    { body: 'bore' as const, holeMm: 4 },
    { body: 'shell' as const, wallMm: 1 },
  ])('builds an in-bounds, closed, consistently wound $body mesh', (bodyParams) => {
    const meshParams = params({ ...bodyParams, reliefMm: 0.2 })
    const validation = validateSealParams(meshParams)
    const mesh = buildCylinderMesh(field([0, 0.25, 0.5, 1], 2, 2), meshParams)
    const vertexCount = mesh.positions.length / 3

    expect(validation.estimate).not.toBeNull()
    expect(vertexCount).toBe(validation.estimate?.vertices)
    expect(mesh.triangles).toBe(validation.estimate?.triangles)
    expect([...mesh.indices].every((index) => index < vertexCount)).toBe(true)

    const edgeIncidence = new Map<string, number>()
    let signedVolumeTimesSix = 0
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]]
      for (let edge = 0; edge < 3; edge++) {
        const from = triangle[edge]
        const to = triangle[(edge + 1) % 3]
        const key = from < to ? `${from}:${to}` : `${to}:${from}`
        edgeIncidence.set(key, (edgeIncidence.get(key) ?? 0) + 1)
      }

      const a = triangle[0] * 3
      const b = triangle[1] * 3
      const c = triangle[2] * 3
      const positions = mesh.positions
      signedVolumeTimesSix +=
        positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) +
        positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2]) +
        positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
    }

    expect([...edgeIncidence.values()].every((count) => count === 2)).toBe(true)
    expect(signedVolumeTimesSix).toBeGreaterThan(0)
  })
})

describe('blurHeightData', () => {
  it('keeps zero softness sharp and interpolates fractional radii', () => {
    const source = new Float32Array([0, 1, 0])

    expect(blurHeightData(source, 3, 1, 0)).toBe(source)
    const blurred = blurHeightData(source, 3, 1, 0.5)
    expect(blurred[0]).toBeCloseTo(1 / 6, 5)
    expect(blurred[1]).toBeCloseTo(2 / 3, 5)
    expect(blurred[2]).toBeCloseTo(1 / 6, 5)
  })
})

describe('meshToBinarySTL', () => {
  const triangle = (changes: Partial<Mesh> = {}): Mesh => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    triangles: 999,
    ...changes,
  })

  it('derives the triangle count from indices instead of trusting metadata', () => {
    const output = meshToBinarySTL(triangle())
    const view = new DataView(output)

    expect(output.byteLength).toBe(134)
    expect(view.getUint32(80, true)).toBe(1)
  })

  it('rejects invalid indices, coordinates, and degenerate triangles', () => {
    expect(() => meshToBinarySTL(triangle({ indices: new Uint32Array([0, 1, 3]) }))).toThrow(
      /outside the position buffer/,
    )
    expect(() =>
      meshToBinarySTL(
        triangle({ positions: new Float32Array([0, 0, 0, Number.NaN, 0, 0, 0, 1, 0]) }),
      ),
    ).toThrow(/not finite/)
    expect(() => meshToBinarySTL(triangle({ indices: new Uint32Array([0, 1, 1]) }))).toThrow(/degenerate/)
  })
})
