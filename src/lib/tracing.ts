export interface TraceRaster {
  rgba: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

export interface TraceSettings {
  mode: 'spline' | 'polygon'
  filterSpeckle: number
  segmentLength: number
  cornerThresholdDegrees: number
  spliceThresholdDegrees: number
  maxIterations: number
  pathPrecision: number
}

export const DEFAULT_TRACE_SETTINGS: Readonly<TraceSettings> = Object.freeze({
  mode: 'spline',
  filterSpeckle: 16,
  segmentLength: 4,
  cornerThresholdDegrees: 60,
  spliceThresholdDegrees: 45,
  maxIterations: 10,
  pathPrecision: 2,
})

export const MAX_TRACE_PIXELS = 16_777_216

export type TraceWorkerRequest = {
  type: 'trace'
  id: number
  raster: TraceRaster
  settings: TraceSettings
}

export type TraceWorkerResponse =
  | { type: 'result'; id: number; svg: string }
  | {
      type: 'error'
      id: number
      code: 'INVALID_INPUT' | 'TRACE_FAILED'
      message: string
    }

export class TraceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceValidationError'
  }
}

export class TraceWorkerError extends Error {
  readonly code: 'INVALID_INPUT' | 'TRACE_FAILED'

  constructor(code: 'INVALID_INPUT' | 'TRACE_FAILED', message: string) {
    super(message)
    this.name = 'TraceWorkerError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireFiniteRange(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TraceValidationError(`${label} must be a finite number from ${min} to ${max}.`)
  }
}

export function validateTraceRaster(value: unknown): asserts value is TraceRaster {
  if (!isRecord(value)) throw new TraceValidationError('Trace raster is missing.')
  const { rgba, width, height } = value
  if (!Number.isSafeInteger(width) || (width as number) < 1) {
    throw new TraceValidationError('Trace raster width must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(height) || (height as number) < 1) {
    throw new TraceValidationError('Trace raster height must be a positive safe integer.')
  }

  const pixelCount = (width as number) * (height as number)
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_TRACE_PIXELS) {
    throw new TraceValidationError(
      `Trace raster exceeds the ${MAX_TRACE_PIXELS.toLocaleString()} pixel safety limit.`,
    )
  }
  if (!(rgba instanceof Uint8ClampedArray)) {
    throw new TraceValidationError('Trace raster pixels must be a Uint8ClampedArray.')
  }
  if (!(rgba.buffer instanceof ArrayBuffer)) {
    throw new TraceValidationError('Trace raster pixels must use a transferable ArrayBuffer.')
  }
  if (rgba.length !== pixelCount * 4) {
    throw new TraceValidationError(
      `Trace raster has ${rgba.length.toLocaleString()} bytes; expected ${(pixelCount * 4).toLocaleString()}.`,
    )
  }
}

export function validateTraceSettings(value: unknown): asserts value is TraceSettings {
  if (!isRecord(value)) throw new TraceValidationError('Trace settings are missing.')
  if (value.mode !== 'spline' && value.mode !== 'polygon') {
    throw new TraceValidationError('Trace mode must be spline or polygon.')
  }
  if (
    !Number.isSafeInteger(value.filterSpeckle) ||
    (value.filterSpeckle as number) < 0 ||
    (value.filterSpeckle as number) > MAX_TRACE_PIXELS
  ) {
    throw new TraceValidationError(
      `Trace speckle filter must be a whole number from 0 to ${MAX_TRACE_PIXELS.toLocaleString()}.`,
    )
  }
  requireFiniteRange(value.segmentLength, 0.1, 1_000, 'Trace segment length')
  requireFiniteRange(value.cornerThresholdDegrees, 0, 180, 'Trace corner threshold')
  requireFiniteRange(value.spliceThresholdDegrees, 0, 180, 'Trace splice threshold')
  if (
    !Number.isSafeInteger(value.maxIterations) ||
    (value.maxIterations as number) < 1 ||
    (value.maxIterations as number) > 100
  ) {
    throw new TraceValidationError('Trace iteration count must be a whole number from 1 to 100.')
  }
  if (
    !Number.isSafeInteger(value.pathPrecision) ||
    (value.pathPrecision as number) < 0 ||
    (value.pathPrecision as number) > 8
  ) {
    throw new TraceValidationError('Trace path precision must be a whole number from 0 to 8.')
  }
}

export function validateTraceRequest(value: unknown): asserts value is TraceWorkerRequest {
  if (!isRecord(value) || value.type !== 'trace') {
    throw new TraceValidationError('Trace worker received an unsupported request.')
  }
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    throw new TraceValidationError('Trace request ID must be a positive safe integer.')
  }
  validateTraceRaster(value.raster)
  validateTraceSettings(value.settings)
}

interface TraceWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: TraceWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

export type TraceWorkerFactory = () => TraceWorkerLike

interface TraceRasterOptions {
  signal?: AbortSignal
  workerFactory?: TraceWorkerFactory
}

let nextTraceRequestId = 0

function createTraceWorker(): TraceWorkerLike {
  return new Worker(new URL('../workers/trace.worker.ts', import.meta.url), { type: 'module' })
}

function isTraceWorkerResponse(value: unknown): value is TraceWorkerResponse {
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) return false
  if (value.type === 'result') return typeof value.svg === 'string'
  return (
    value.type === 'error' &&
    (value.code === 'INVALID_INPUT' || value.code === 'TRACE_FAILED') &&
    typeof value.message === 'string'
  )
}

function abortError(): DOMException {
  return new DOMException('SVG tracing was cancelled.', 'AbortError')
}

export function traceRaster(
  raster: TraceRaster,
  settings: Readonly<TraceSettings> = DEFAULT_TRACE_SETTINGS,
  options: TraceRasterOptions = {},
): Promise<string> {
  try {
    validateTraceRaster(raster)
    validateTraceSettings(settings)
  } catch (error) {
    return Promise.reject(error)
  }
  if (options.signal?.aborted) return Promise.reject(abortError())

  const id = ++nextTraceRequestId
  const request: TraceWorkerRequest = {
    type: 'trace',
    id,
    raster,
    settings: { ...settings },
  }

  return new Promise<string>((resolve, reject) => {
    let worker: TraceWorkerLike
    try {
      worker = (options.workerFactory ?? createTraceWorker)()
    } catch (error) {
      reject(error)
      return
    }

    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      callback()
    }
    const onAbort = () => finish(() => reject(abortError()))

    worker.onmessage = (event) => {
      const response = event.data
      if (!isTraceWorkerResponse(response) || response.id !== id) {
        finish(() => reject(new Error('SVG trace worker returned an invalid response.')))
        return
      }
      if (response.type === 'error') {
        finish(() => reject(new TraceWorkerError(response.code, response.message)))
      } else {
        finish(() => resolve(response.svg))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(() => reject(new Error(event.message || 'SVG trace worker failed.')))
    }
    worker.onmessageerror = () => {
      finish(() => reject(new Error('Could not read the SVG trace worker response.')))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      worker.postMessage(request, [raster.rgba.buffer])
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
