import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TRACE_SETTINGS,
  MAX_TRACE_PIXELS,
  TraceWorkerError,
  traceRaster,
  validateTraceRaster,
  validateTraceSettings,
  type TraceWorkerFactory,
  type TraceWorkerRequest,
} from './tracing'

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  readonly postMessage = vi.fn<(message: TraceWorkerRequest, transfer: Transferable[]) => void>()
  readonly terminate = vi.fn()
}

function raster(width = 2, height = 2) {
  return { rgba: new Uint8ClampedArray(width * height * 4), width, height }
}

function factory(worker: FakeWorker): TraceWorkerFactory {
  return () => worker
}

function postedRequest(worker: FakeWorker): TraceWorkerRequest {
  return worker.postMessage.mock.calls[0][0]
}

describe('trace input validation', () => {
  it('accepts a correctly sized transferable raster and the production preset', () => {
    expect(() => validateTraceRaster(raster())).not.toThrow()
    expect(() => validateTraceSettings(DEFAULT_TRACE_SETTINGS)).not.toThrow()
  })

  it('rejects unsafe dimensions, incorrect buffers, and out-of-range settings', () => {
    expect(() => validateTraceRaster({ ...raster(), width: 0 })).toThrow(/width/)
    expect(() =>
      validateTraceRaster({ rgba: new Uint8ClampedArray(4), width: MAX_TRACE_PIXELS, height: 2 }),
    ).toThrow(/safety limit/)
    expect(() => validateTraceRaster({ ...raster(), rgba: new Uint8ClampedArray(3) })).toThrow(
      /expected 16/,
    )
    expect(() => validateTraceSettings({ ...DEFAULT_TRACE_SETTINGS, segmentLength: Number.NaN })).toThrow(
      /segment length/,
    )
    expect(() => validateTraceSettings({ ...DEFAULT_TRACE_SETTINGS, pathPrecision: 9 })).toThrow(
      /precision/,
    )
    expect(() =>
      validateTraceSettings({ ...DEFAULT_TRACE_SETTINGS, filterSpeckle: MAX_TRACE_PIXELS + 1 }),
    ).toThrow(/speckle filter/)
  })
})

describe('traceRaster worker lifecycle', () => {
  it('transfers pixels and resolves a matching worker result exactly once', async () => {
    const worker = new FakeWorker()
    const input = raster()
    const result = traceRaster(input, DEFAULT_TRACE_SETTINGS, { workerFactory: factory(worker) })
    const request = postedRequest(worker)

    expect(worker.postMessage).toHaveBeenCalledWith(request, [input.rgba.buffer])
    worker.onmessage?.({ data: { type: 'result', id: request.id, svg: '<svg />' } } as MessageEvent)

    await expect(result).resolves.toBe('<svg />')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('surfaces typed trace failures and malformed responses', async () => {
    const failedWorker = new FakeWorker()
    const failed = traceRaster(raster(), DEFAULT_TRACE_SETTINGS, {
      workerFactory: factory(failedWorker),
    })
    const failedRequest = postedRequest(failedWorker)
    failedWorker.onmessage?.({
      data: {
        type: 'error',
        id: failedRequest.id,
        code: 'TRACE_FAILED',
        message: 'converter failed',
      },
    } as MessageEvent)

    await expect(failed).rejects.toEqual(
      expect.objectContaining<Partial<TraceWorkerError>>({ code: 'TRACE_FAILED', message: 'converter failed' }),
    )

    const malformedWorker = new FakeWorker()
    const malformed = traceRaster(raster(), DEFAULT_TRACE_SETTINGS, {
      workerFactory: factory(malformedWorker),
    })
    malformedWorker.onmessage?.({ data: { type: 'result', id: -1 } } as MessageEvent)
    await expect(malformed).rejects.toThrow(/invalid response/)
    expect(malformedWorker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates and rejects when tracing is aborted', async () => {
    const worker = new FakeWorker()
    const controller = new AbortController()
    const result = traceRaster(raster(), DEFAULT_TRACE_SETTINGS, {
      signal: controller.signal,
      workerFactory: factory(worker),
    })

    controller.abort()

    await expect(result).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }))
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('handles worker execution and response-cloning errors', async () => {
    const crashedWorker = new FakeWorker()
    const crashed = traceRaster(raster(), DEFAULT_TRACE_SETTINGS, {
      workerFactory: factory(crashedWorker),
    })
    crashedWorker.onerror?.({ message: 'worker crashed', preventDefault: vi.fn() } as unknown as ErrorEvent)
    await expect(crashed).rejects.toThrow('worker crashed')

    const cloneWorker = new FakeWorker()
    const cloneFailure = traceRaster(raster(), DEFAULT_TRACE_SETTINGS, {
      workerFactory: factory(cloneWorker),
    })
    cloneWorker.onmessageerror?.({ data: null } as MessageEvent)
    await expect(cloneFailure).rejects.toThrow(/Could not read/)
  })
})
