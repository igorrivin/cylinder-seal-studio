import {
  TraceValidationError,
  validateTraceRequest,
  type TraceWorkerResponse,
} from '@/lib/tracing'
import { traceImageData } from '@/lib/vector-tracer'

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: TraceWorkerResponse) => void
}

const workerScope = self as unknown as WorkerScope

function requestId(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('id' in value)) return 0
  const id = value.id
  return Number.isSafeInteger(id) && (id as number) > 0 ? (id as number) : 0
}

workerScope.onmessage = ({ data }) => {
  const id = requestId(data)
  try {
    validateTraceRequest(data)
    const imageData = new ImageData(data.raster.rgba, data.raster.width, data.raster.height)
    const svg = traceImageData(imageData, data.settings)
    workerScope.postMessage({ type: 'result', id: data.id, svg })
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      id,
      code: error instanceof TraceValidationError ? 'INVALID_INPUT' : 'TRACE_FAILED',
      message: error instanceof Error && error.message ? error.message : 'SVG tracing failed.',
    })
  }
}

export {}
