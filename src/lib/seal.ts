// Core logic for Cylinder Seal Studio:
// raster -> cleaned heightfield -> displaced cylinder mesh -> binary STL

export interface SealParams {
  diameterMm: number
  heightMm: number
  reliefMm: number
  mode: 'raised' | 'recessed'
  mirror: boolean
  seamBand: boolean
  threshold: number
  invert: boolean
  soften: number
  body: 'solid' | 'bore' | 'shell'
  holeMm: number // through-bore diameter (body === 'bore')
  wallMm: number // wall thickness (body === 'shell')
  segments: number
}

export const DEFAULT_PARAMS: SealParams = {
  diameterMm: 12.7,
  heightMm: 40,
  reliefMm: 0.8,
  mode: 'raised',
  mirror: true,
  seamBand: true,
  threshold: 170,
  invert: false,
  soften: 0.6,
  body: 'solid',
  holeMm: 4,
  wallMm: 2,
  segments: 320,
}

export const GEOMETRY_LIMITS = {
  diameterMm: { min: 1, max: 1000 },
  heightMm: { min: 1, max: 2000 },
  reliefMm: { min: 0, max: 1000 },
  holeMm: { min: 0.1, max: 999 },
  wallMm: { min: 0.4, max: 999 },
  segments: { min: 32, max: 2048 },
} as const

export const MAX_MESH_VERTICES = 1_500_000
export const MAX_MESH_TRIANGLES = 3_000_000
export const MAX_HEIGHT_FIELD_PIXELS = 16_777_216
export const MAX_EDGE_SOFTNESS_PX = 20

const MIN_OUTER_RADIUS_MM = 0.5
const MIN_MATERIAL_CLEARANCE_MM = 0.3

export interface MeshEstimate {
  segmentsAround: number
  segmentsHigh: number
  vertices: number
  triangles: number
  stlBytes: number
}

export interface SealValidationIssue {
  field: keyof SealParams | 'mesh'
  message: string
}

export interface SealValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  issues: SealValidationIssue[]
  estimate: MeshEstimate | null
}

export class SealValidationError extends Error {
  readonly issues: SealValidationIssue[]

  constructor(issues: SealValidationIssue[]) {
    super(issues.map(({ message }) => message).join(' '))
    this.name = 'SealValidationError'
    this.issues = issues
  }
}

function isWithin(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max
}

export function estimateMesh(p: SealParams): MeshEstimate | null {
  const diameter = p.diameterMm
  const height = p.heightMm
  const segments = p.segments
  if (
    !isWithin(diameter, GEOMETRY_LIMITS.diameterMm.min, GEOMETRY_LIMITS.diameterMm.max) ||
    !isWithin(height, GEOMETRY_LIMITS.heightMm.min, GEOMETRY_LIMITS.heightMm.max) ||
    !Number.isInteger(segments) ||
    !isWithin(segments, GEOMETRY_LIMITS.segments.min, GEOMETRY_LIMITS.segments.max) ||
    !(['solid', 'bore', 'shell'] as const).includes(p.body)
  ) {
    return null
  }

  const segmentsHigh = Math.max(8, Math.round((segments * height) / (Math.PI * diameter)))
  const rows = segmentsHigh + 1
  const lateralVertices = segments * rows
  let vertices: number
  let triangles: number

  if (p.body === 'shell') {
    vertices = lateralVertices * 2
    triangles = 4 * segments * rows
  } else if (p.body === 'bore') {
    vertices = lateralVertices + segments * 2
    triangles = 2 * segments * (segmentsHigh + 3)
  } else {
    vertices = lateralVertices + 2
    triangles = 2 * segments * rows
  }

  return {
    segmentsAround: segments,
    segmentsHigh,
    vertices,
    triangles,
    stlBytes: 84 + triangles * 50,
  }
}

export function validateSealParams(p: SealParams): SealValidationResult {
  const issues: SealValidationIssue[] = []
  const warnings: string[] = []
  const add = (field: SealValidationIssue['field'], message: string) => issues.push({ field, message })

  if (!isWithin(p.diameterMm, GEOMETRY_LIMITS.diameterMm.min, GEOMETRY_LIMITS.diameterMm.max)) {
    add(
      'diameterMm',
      `Cylinder diameter must be a finite number from ${GEOMETRY_LIMITS.diameterMm.min} to ${GEOMETRY_LIMITS.diameterMm.max} mm.`,
    )
  }
  if (!isWithin(p.heightMm, GEOMETRY_LIMITS.heightMm.min, GEOMETRY_LIMITS.heightMm.max)) {
    add(
      'heightMm',
      `Cylinder height must be a finite number from ${GEOMETRY_LIMITS.heightMm.min} to ${GEOMETRY_LIMITS.heightMm.max} mm.`,
    )
  }
  if (!isWithin(p.reliefMm, GEOMETRY_LIMITS.reliefMm.min, GEOMETRY_LIMITS.reliefMm.max)) {
    add(
      'reliefMm',
      `Relief depth must be a finite number from ${GEOMETRY_LIMITS.reliefMm.min} to ${GEOMETRY_LIMITS.reliefMm.max} mm.`,
    )
  }
  if (
    !Number.isInteger(p.segments) ||
    !isWithin(p.segments, GEOMETRY_LIMITS.segments.min, GEOMETRY_LIMITS.segments.max)
  ) {
    add(
      'segments',
      `Mesh quality must be a whole number from ${GEOMETRY_LIMITS.segments.min} to ${GEOMETRY_LIMITS.segments.max} segments.`,
    )
  }
  if (p.mode !== 'raised' && p.mode !== 'recessed') {
    add('mode', 'Relief mode must be either raised or recessed.')
  }
  if (p.body !== 'solid' && p.body !== 'bore' && p.body !== 'shell') {
    add('body', 'Body type must be solid, bore, or shell.')
  }
  if (!isWithin(p.threshold, 0, 255)) {
    add('threshold', 'Image threshold must be a finite number from 0 to 255.')
  }
  if (!isWithin(p.soften, 0, MAX_EDGE_SOFTNESS_PX)) {
    add('soften', `Edge softness must be a finite number from 0 to ${MAX_EDGE_SOFTNESS_PX} pixels.`)
  }
  if (typeof p.mirror !== 'boolean') add('mirror', 'Mirror must be enabled or disabled.')
  if (typeof p.seamBand !== 'boolean') add('seamBand', 'Seam border band must be enabled or disabled.')
  if (typeof p.invert !== 'boolean') add('invert', 'Image inversion must be enabled or disabled.')

  const baseGeometryValid =
    isWithin(p.diameterMm, GEOMETRY_LIMITS.diameterMm.min, GEOMETRY_LIMITS.diameterMm.max) &&
    isWithin(p.reliefMm, GEOMETRY_LIMITS.reliefMm.min, GEOMETRY_LIMITS.reliefMm.max) &&
    (p.mode === 'raised' || p.mode === 'recessed')

  if (baseGeometryValid) {
    const nominalRadius = p.diameterMm / 2
    const minimumOuterRadius = nominalRadius - (p.mode === 'recessed' ? p.reliefMm : 0)

    if (minimumOuterRadius < MIN_OUTER_RADIUS_MM) {
      add(
        'reliefMm',
        `Recessed relief leaves less than ${MIN_OUTER_RADIUS_MM} mm at the cylinder axis; reduce relief depth or increase diameter.`,
      )
    }

    if (p.body === 'bore') {
      if (!isWithin(p.holeMm, GEOMETRY_LIMITS.holeMm.min, GEOMETRY_LIMITS.holeMm.max)) {
        add(
          'holeMm',
          `Bore diameter must be a finite number from ${GEOMETRY_LIMITS.holeMm.min} to ${GEOMETRY_LIMITS.holeMm.max} mm.`,
        )
      } else {
        const maximumBore = 2 * (minimumOuterRadius - MIN_MATERIAL_CLEARANCE_MM)
        if (p.holeMm > maximumBore) {
          add(
            'holeMm',
            `Bore diameter must be at most ${Math.max(0, maximumBore).toFixed(2)} mm to leave ${MIN_MATERIAL_CLEARANCE_MM} mm of material under the deepest relief.`,
          )
        } else if ((minimumOuterRadius - p.holeMm / 2) < 1) {
          warnings.push('The bore leaves less than 1 mm of material under the deepest relief.')
        }
      }
    }

    if (p.body === 'shell') {
      if (!isWithin(p.wallMm, GEOMETRY_LIMITS.wallMm.min, GEOMETRY_LIMITS.wallMm.max)) {
        add(
          'wallMm',
          `Wall thickness must be a finite number from ${GEOMETRY_LIMITS.wallMm.min} to ${GEOMETRY_LIMITS.wallMm.max} mm.`,
        )
      } else {
        const maximumWall = minimumOuterRadius - MIN_MATERIAL_CLEARANCE_MM
        if (p.wallMm > maximumWall) {
          add(
            'wallMm',
            `Wall thickness must be at most ${Math.max(0, maximumWall).toFixed(2)} mm for this diameter and relief depth.`,
          )
        }
      }
    }

    if (p.reliefMm >= p.diameterMm / 4) {
      warnings.push('Relief depth is large relative to the cylinder diameter.')
    }
  }

  const estimate = estimateMesh(p)
  if (estimate && (estimate.vertices > MAX_MESH_VERTICES || estimate.triangles > MAX_MESH_TRIANGLES)) {
    add(
      'mesh',
      `Mesh would contain ${estimate.vertices.toLocaleString()} vertices and ${estimate.triangles.toLocaleString()} triangles, exceeding the safe browser budget. Reduce cylinder height or mesh quality.`,
    )
  } else if (estimate && estimate.triangles > 1_000_000) {
    warnings.push('This is a large mesh and may take a while to preview and export.')
  }

  const errors = issues.map(({ message }) => message)
  return { valid: errors.length === 0, errors, warnings, issues, estimate }
}

export interface HeightSamples {
  data: Float32Array
  w: number
  h: number
}

export interface HeightField extends HeightSamples {
  canvas: HTMLCanvasElement
}

export function validateHeightField(field: HeightSamples): string[] {
  const errors: string[] = []
  if (!field || typeof field !== 'object') return ['Height field is missing.']
  if (!Number.isInteger(field.w) || field.w < 1) errors.push('Height field width must be a positive whole number.')
  if (!Number.isInteger(field.h) || field.h < 1) errors.push('Height field height must be a positive whole number.')
  if (!(field.data instanceof Float32Array)) errors.push('Height field data must be a Float32Array.')

  const pixelCount = field.w * field.h
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 1) {
    errors.push('Height field dimensions must produce a positive, safely representable sample count.')
  } else if (pixelCount > MAX_HEIGHT_FIELD_PIXELS) {
    errors.push(`Height field exceeds the ${MAX_HEIGHT_FIELD_PIXELS.toLocaleString()} pixel safety limit.`)
  }
  if (
    field.data instanceof Float32Array &&
    Number.isSafeInteger(pixelCount) &&
    pixelCount >= 1 &&
    field.data.length !== pixelCount
  ) {
    errors.push(`Height field data has ${field.data.length.toLocaleString()} samples; expected ${pixelCount.toLocaleString()}.`)
  }

  if (errors.length === 0) {
    for (let i = 0; i < field.data.length; i++) {
      const value = field.data[i]
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        errors.push(`Height field sample ${i.toLocaleString()} must be a finite value from 0 to 1.`)
        break
      }
    }
  }
  return errors
}

function integerBoxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array<ArrayBufferLike> {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    let acc = 0
    const row = y * w
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = Math.min(1, Math.max(0, acc / win))
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.min(1, Math.max(0, acc / win))
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

export function blurHeightData(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
): Float32Array<ArrayBufferLike> {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || src.length !== w * h) {
    throw new Error('Blur input dimensions must match a non-empty Float32Array.')
  }
  if (!Number.isFinite(radius) || radius < 0 || radius > MAX_EDGE_SOFTNESS_PX) {
    throw new RangeError(`Blur radius must be a finite number from 0 to ${MAX_EDGE_SOFTNESS_PX}.`)
  }
  if (radius === 0) return src

  const lowerRadius = Math.floor(radius)
  const upperRadius = Math.ceil(radius)
  if (lowerRadius === upperRadius) return integerBoxBlur(src, w, h, lowerRadius)

  const lower = lowerRadius === 0 ? src : integerBoxBlur(src, w, h, lowerRadius)
  const upper = integerBoxBlur(src, w, h, upperRadius)
  const fraction = radius - lowerRadius
  const out = new Float32Array(src.length)
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(1, Math.max(0, lower[i] * (1 - fraction) + upper[i] * fraction))
  }
  return out
}

export function processImage(img: HTMLImageElement, p: SealParams, size = 1024): HeightField {
  const imageFields = new Set<SealValidationIssue['field']>([
    'threshold',
    'soften',
    'mirror',
    'seamBand',
    'invert',
  ])
  const imageIssues = validateSealParams(p).issues.filter(({ field }) => imageFields.has(field))
  if (imageIssues.length > 0) throw new SealValidationError(imageIssues)

  if (!Number.isInteger(size) || size < 1 || size * size > MAX_HEIGHT_FIELD_PIXELS) {
    throw new RangeError(
      `Image processing size must be a positive whole number with no more than ${MAX_HEIGHT_FIELD_PIXELS.toLocaleString()} pixels.`,
    )
  }
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D rendering is unavailable in this browser.')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(img, 0, 0, size, size)
  const im = ctx.getImageData(0, 0, size, size)
  const g: Float32Array<ArrayBufferLike> = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) {
    g[i] = (im.data[i * 4] * 0.299 + im.data[i * 4 + 1] * 0.587 + im.data[i * 4 + 2] * 0.114) / 255
  }
  let f: Float32Array<ArrayBufferLike> = new Float32Array(size * size)
  const t = p.threshold / 255
  for (let i = 0; i < f.length; i++) {
    let v = g[i] < t ? 1 : 0
    if (p.invert) v = 1 - v
    f[i] = v
  }
  f = blurHeightData(f, size, size, p.soften)

  if (p.mirror) {
    const m = new Float32Array(size * size)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) m[y * size + x] = f[y * size + (size - 1 - x)]
    f = m
  }
  if (p.seamBand) {
    const edge = Math.round(size * 0.037)
    const l1 = Math.round(size * 0.013)
    const l2 = Math.round(size * 0.024)
    const lw = Math.max(2, Math.round(size * 0.005))
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < edge; x++) { f[y * size + x] = 0; f[y * size + (size - 1 - x)] = 0 }
      for (const lx of [l1, l2, size - 1 - l1, size - 1 - l2]) {
        for (let dx = -lw; dx <= lw; dx++) f[y * size + Math.min(size - 1, Math.max(0, lx + dx))] = 1
      }
    }
  }

  const out = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    const v = Math.round((1 - f[i]) * 255)
    out.data[i * 4] = v
    out.data[i * 4 + 1] = v
    out.data[i * 4 + 2] = v
    out.data[i * 4 + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  return { data: f, w: size, h: size, canvas }
}

export interface Mesh {
  positions: Float32Array
  indices: Uint32Array
  triangles: number
}

function sampleBilinear(f: Float32Array, w: number, h: number, x: number, y: number): number {
  const wrappedX = w === 1 ? 0 : ((x % w) + w) % w
  const clampedY = h === 1 ? 0 : Math.min(h - 1, Math.max(0, y))
  const x0 = Math.floor(wrappedX)
  const x1 = w === 1 ? 0 : (x0 + 1) % w
  const y0 = Math.floor(clampedY)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = wrappedX - x0
  const fy = clampedY - y0
  const a = f[y0 * w + x0] * (1 - fx) + f[y0 * w + x1] * fx
  const b = f[y1 * w + x0] * (1 - fx) + f[y1 * w + x1] * fx
  return a * (1 - fy) + b * fy
}

export function buildCylinderMesh(field: HeightSamples, p: SealParams): Mesh {
  const validation = validateSealParams(p)
  if (!validation.valid) throw new SealValidationError(validation.issues)

  const fieldErrors = validateHeightField(field)
  if (fieldErrors.length > 0) throw new Error(`Invalid height field: ${fieldErrors.join(' ')}`)

  const estimate = validation.estimate
  if (!estimate) throw new Error('Unable to estimate mesh size from the supplied parameters.')

  const R = p.diameterMm / 2
  const nT = estimate.segmentsAround
  const nY = estimate.segmentsHigh
  const holeR = p.holeMm / 2
  const isBore = p.body === 'bore'
  const wall = p.wallMm
  const isShell = p.body === 'shell'

  const rows = nY + 1
  const latCount = nT * rows
  const pos = new Float32Array(estimate.vertices * 3)
  const idx = new Uint32Array(estimate.triangles * 3)
  let indexOffset = 0
  const putTriangle = (a: number, b: number, c: number) => {
    idx[indexOffset++] = a
    idx[indexOffset++] = b
    idx[indexOffset++] = c
  }

  const radiusAt = (i: number, j: number): number => {
    const sampleY = field.h === 1 ? 0 : (j / nY) * (field.h - 1)
    const v = sampleBilinear(field.data, field.w, field.h, (i / nT) * field.w, sampleY)
    return p.mode === 'raised' ? R + p.reliefMm * v : R - p.reliefMm * v
  }

  // outer lateral surface
  for (let j = 0; j <= nY; j++) {
    const y = (j / nY) * p.heightMm
    for (let i = 0; i < nT; i++) {
      const th = (i / nT) * Math.PI * 2
      const r = radiusAt(i, j)
      const o = (j * nT + i) * 3
      pos[o] = r * Math.cos(th)
      pos[o + 1] = y
      pos[o + 2] = r * Math.sin(th)
    }
  }
  for (let j = 0; j < nY; j++) {
    for (let i = 0; i < nT; i++) {
      const i2 = (i + 1) % nT
      const a = j * nT + i
      const b = j * nT + i2
      const c = (j + 1) * nT + i
      const d = (j + 1) * nT + i2
      putTriangle(a, c, b)
      putTriangle(b, c, d)
    }
  }

  const yTop = p.heightMm
  const put = (vi: number, x: number, y: number, z: number) => {
    pos[vi * 3] = x
    pos[vi * 3 + 1] = y
    pos[vi * 3 + 2] = z
  }

  if (isShell) {
    // inner lateral surface at constant wall offset (open-ended tube)
    for (let j = 0; j <= nY; j++) {
      const y = (j / nY) * p.heightMm
      for (let i = 0; i < nT; i++) {
        const th = (i / nT) * Math.PI * 2
        const r = radiusAt(i, j) - wall
        put(latCount + j * nT + i, r * Math.cos(th), y, r * Math.sin(th))
      }
    }
    for (let j = 0; j < nY; j++) {
      for (let i = 0; i < nT; i++) {
        const i2 = (i + 1) % nT
        const a = latCount + j * nT + i
        const b = latCount + j * nT + i2
        const c = latCount + (j + 1) * nT + i
        const d = latCount + (j + 1) * nT + i2
        putTriangle(a, b, c) // reversed: normals face inward
        putTriangle(b, d, c)
      }
    }
    for (let i = 0; i < nT; i++) {
      const i2 = (i + 1) % nT
      // bottom wall ring (faces -y)
      putTriangle(i, latCount + i2, latCount + i)
      putTriangle(i, i2, latCount + i2)
      // top wall ring (faces +y)
      const e0 = nY * nT + i
      const e1 = nY * nT + i2
      const n0 = latCount + nY * nT + i
      const n1 = latCount + nY * nT + i2
      putTriangle(e0, n0, n1)
      putTriangle(e0, n1, e1)
    }
  } else if (isBore) {
    const holeBottom = latCount
    const holeTop = latCount + nT
    for (let i = 0; i < nT; i++) {
      const th = (i / nT) * Math.PI * 2
      put(holeBottom + i, holeR * Math.cos(th), 0, holeR * Math.sin(th))
      put(holeTop + i, holeR * Math.cos(th), yTop, holeR * Math.sin(th))
    }
    for (let i = 0; i < nT; i++) {
      const i2 = (i + 1) % nT
      putTriangle(i, holeBottom + i2, holeBottom + i)
      putTriangle(i, i2, holeBottom + i2)
      const e0 = nY * nT + i
      const e1 = nY * nT + i2
      putTriangle(e0, holeTop + i, holeTop + i2)
      putTriangle(e0, holeTop + i2, e1)
      putTriangle(holeBottom + i, holeTop + i2, holeTop + i)
      putTriangle(holeBottom + i, holeBottom + i2, holeTop + i2)
    }
  } else {
    const cBot = latCount
    const cTop = latCount + 1
    put(cBot, 0, 0, 0)
    put(cTop, 0, yTop, 0)
    for (let i = 0; i < nT; i++) {
      const i2 = (i + 1) % nT
      putTriangle(i, i2, cBot)
      putTriangle(nY * nT + i, cTop, nY * nT + i2)
    }
  }
  if (indexOffset !== idx.length) {
    throw new Error(`Internal mesh index count mismatch: wrote ${indexOffset} values, expected ${idx.length}.`)
  }
  return { positions: pos, indices: idx, triangles: idx.length / 3 }
}

export function meshToBinarySTL(mesh: Mesh): ArrayBuffer {
  if (!mesh || typeof mesh !== 'object') throw new TypeError('Mesh is missing.')
  if (!(mesh.positions instanceof Float32Array)) throw new TypeError('Mesh positions must be a Float32Array.')
  if (!(mesh.indices instanceof Uint32Array)) throw new TypeError('Mesh indices must be a Uint32Array.')
  if (mesh.positions.length < 9 || mesh.positions.length % 3 !== 0) {
    throw new Error('Mesh positions must contain at least three complete XYZ vertices.')
  }
  if (mesh.indices.length < 3 || mesh.indices.length % 3 !== 0) {
    throw new Error('Mesh indices must contain complete triangles.')
  }

  const p = mesh.positions
  const indices = mesh.indices
  const vertexCount = p.length / 3
  const n = indices.length / 3
  if (n > MAX_MESH_TRIANGLES) {
    throw new RangeError(`STL export exceeds the ${MAX_MESH_TRIANGLES.toLocaleString()} triangle safety limit.`)
  }

  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) throw new Error(`Mesh position component ${i.toLocaleString()} is not finite.`)
  }
  const buf = new ArrayBuffer(84 + n * 50)
  const dv = new DataView(buf)
  dv.setUint32(80, n, true)
  let off = 84
  for (let t = 0; t < n; t++) {
    const ia = indices[t * 3]
    const ib = indices[t * 3 + 1]
    const ic = indices[t * 3 + 2]
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) {
      throw new RangeError(`Mesh triangle ${t.toLocaleString()} references a vertex outside the position buffer.`)
    }
    if (ia === ib || ib === ic || ia === ic) {
      throw new Error(`Mesh triangle ${t.toLocaleString()} is degenerate because it repeats a vertex.`)
    }

    const a = ia * 3
    const b = ib * 3
    const c = ic * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (!Number.isFinite(len) || len === 0) {
      throw new Error(`Mesh triangle ${t.toLocaleString()} is degenerate or has non-finite geometry.`)
    }
    nx /= len; ny /= len; nz /= len
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true)
    dv.setFloat32(off + 12, p[a], true); dv.setFloat32(off + 16, p[a + 1], true); dv.setFloat32(off + 20, p[a + 2], true)
    dv.setFloat32(off + 24, p[b], true); dv.setFloat32(off + 28, p[b + 1], true); dv.setFloat32(off + 32, p[b + 2], true)
    dv.setFloat32(off + 36, p[c], true); dv.setFloat32(off + 40, p[c + 1], true); dv.setFloat32(off + 44, p[c + 2], true)
    dv.setUint16(off + 48, 0, true)
    off += 50
  }
  return buf
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.hidden = true
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}
