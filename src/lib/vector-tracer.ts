import { BinaryImageConverter, type BinaryImageConverterParams } from 'vectortracer'
import type { TraceSettings } from './tracing'

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}

export function toVectorTracerOptions(settings: TraceSettings): BinaryImageConverterParams {
  return {
    debug: false,
    mode: settings.mode,
    cornerThreshold: degreesToRadians(settings.cornerThresholdDegrees),
    lengthThreshold: settings.segmentLength,
    maxIterations: settings.maxIterations,
    spliceThreshold: degreesToRadians(settings.spliceThresholdDegrees),
    filterSpeckle: settings.filterSpeckle,
    pathPrecision: settings.pathPrecision,
  }
}

export function traceImageData(imageData: ImageData, settings: TraceSettings): string {
  const converter = new BinaryImageConverter(imageData, toVectorTracerOptions(settings), {
    invert: false,
    pathFill: '#000000',
    backgroundColor: 'transparent',
    attributes: '',
    scale: 1,
  })

  let rawSvg: string
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
      // A panicked WASM converter is discarded with its short-lived worker.
    }
    throw error
  }

  converter.free()
  return rawSvg
}
