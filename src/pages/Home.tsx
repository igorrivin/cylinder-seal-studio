import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import {
  DEFAULT_PARAMS,
  GEOMETRY_LIMITS,
  download,
  processImage,
  validateSealParams,
  type HeightField,
  type Mesh,
  type SealParams,
} from '@/lib/seal'
import { formatFlatSvg } from '@/lib/svg'

const ThreePreview = lazy(() => import('@/components/ThreePreview'))

const PREVIEW_IMAGE_SIZE = 384
const EXPORT_IMAGE_SIZE = 1024
const PREVIEW_SEGMENTS = 200
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000
const ACCEPTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
])

type ExportKind = 'stl' | 'svg' | null

interface MeshWorkerResponse {
  id: number
  kind: 'preview' | 'stl'
  error?: string
  mesh?: Mesh
  buffer?: ArrayBuffer
  triangles?: number
}

interface FieldState {
  image: HTMLImageElement
  key: string
  field: HeightField
}

interface PreviewState {
  key: string
  mesh: Mesh | null
  error: string
}

interface NumericControlProps {
  id: string
  label: string
  value: number
  step: string
  min: number
  max: number
  errors: string[]
  onChange: (value: number) => void
}

function NumericControl({ id, label, value, step, min, max, errors, onChange }: NumericControlProps) {
  const errorId = `${id}-error`
  return (
    <div>
      <div className="grid grid-cols-[1fr_110px] items-center gap-2">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : ''}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={errors.length > 0 ? errorId : undefined}
          onChange={(event) => onChange(event.target.value === '' ? Number.NaN : event.target.valueAsNumber)}
        />
      </div>
      {errors.length > 0 && (
        <p id={errorId} className="mt-1 text-xs text-red-700">
          {errors.join(' ')}
        </p>
      )}
    </div>
  )
}

function createMeshWorker() {
  return new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' })
}

function designKey(params: SealParams) {
  return [params.threshold, params.invert, params.soften, params.mirror, params.seamBand].join(':')
}

function geometryKey(params: SealParams) {
  return [
    params.diameterMm,
    params.heightMm,
    params.reliefMm,
    params.mode,
    params.body,
    params.holeMm,
    params.wallMm,
    params.segments,
  ].join(':')
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs, value])
  return debounced
}

function waitForPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function Home() {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [imgName, setImgName] = useState('')
  const [p, setP] = useState<SealParams>(DEFAULT_PARAMS)
  const [thresholdDraft, setThresholdDraft] = useState(DEFAULT_PARAMS.threshold)
  const [softenDraft, setSoftenDraft] = useState(DEFAULT_PARAMS.soften)
  const [fileStatus, setFileStatus] = useState<{ kind: 'loading' | 'error'; message: string } | null>(null)
  const [fieldState, setFieldState] = useState<FieldState | null>(null)
  const [fieldFailure, setFieldFailure] = useState<{ image: HTMLImageElement; key: string; message: string } | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState>({ key: '', mesh: null, error: '' })
  const [exportKind, setExportKind] = useState<ExportKind>(null)
  const [exportStatus, setExportStatus] = useState('')
  const [exportError, setExportError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const preview2dRef = useRef<HTMLCanvasElement>(null)
  const loadRequestRef = useRef(0)
  const pendingObjectUrlRef = useRef<string | null>(null)
  const previewWorkerRef = useRef<Worker | null>(null)
  const exportWorkerRef = useRef<Worker | null>(null)
  const workerRequestRef = useRef(0)

  const debouncedP = useDebouncedValue(p, 180)
  const validation = useMemo(() => validateSealParams(p), [p])
  const debouncedValidation = useMemo(() => validateSealParams(debouncedP), [debouncedP])
  const currentDesignKey = designKey(debouncedP)
  const currentGeometryKey = geometryKey(debouncedP)
  const imageParams = useMemo<SealParams>(
    () => ({
      ...DEFAULT_PARAMS,
      threshold: debouncedP.threshold,
      invert: debouncedP.invert,
      soften: debouncedP.soften,
      mirror: debouncedP.mirror,
      seamBand: debouncedP.seamBand,
    }),
    [debouncedP.invert, debouncedP.mirror, debouncedP.seamBand, debouncedP.soften, debouncedP.threshold],
  )
  const field = fieldState?.image === image && fieldState.key === currentDesignKey ? fieldState.field : null
  const fieldError = fieldFailure?.image === image && fieldFailure.key === currentDesignKey ? fieldFailure.message : ''
  const fieldBusy = Boolean(image && !field && !fieldError)
  const previewParams = useMemo(
    () => ({ ...debouncedP, segments: Math.min(debouncedP.segments, PREVIEW_SEGMENTS) }),
    [debouncedP],
  )
  const previewKey = field ? `${currentDesignKey}|${currentGeometryKey}|${previewParams.segments}` : ''
  const mesh = previewState.key === previewKey ? previewState.mesh : null
  const previewError = previewState.key === previewKey ? previewState.error : ''
  const previewBusy = Boolean(field && debouncedValidation.valid && previewState.key !== previewKey)
  const displayMesh = mesh ?? ((fieldBusy || previewBusy) ? previewState.mesh : null)
  const circ = Number.isFinite(p.diameterMm) ? Math.PI * p.diameterMm : null
  const estimate = validation.estimate
  const stlMB = estimate ? estimate.stlBytes / 1e6 : null

  const issuesFor = (fieldName: keyof SealParams | 'mesh') =>
    validation.issues.filter((issue) => issue.field === fieldName).map((issue) => issue.message)

  const set = <K extends keyof SealParams>(key: K, value: SealParams[K]) => {
    setP((previous) => ({ ...previous, [key]: value }))
  }

  const beginImageLoad = (src: string, name: string, objectUrl: string | null = null) => {
    const request = ++loadRequestRef.current
    if (pendingObjectUrlRef.current) URL.revokeObjectURL(pendingObjectUrlRef.current)
    pendingObjectUrlRef.current = objectUrl
    setFileStatus({ kind: 'loading', message: `Loading ${name}…` })

    const loadedImage = new Image()
    loadedImage.decoding = 'async'
    const releaseObjectUrl = () => {
      if (objectUrl && pendingObjectUrlRef.current === objectUrl) {
        URL.revokeObjectURL(objectUrl)
        pendingObjectUrlRef.current = null
      }
    }
    loadedImage.onload = () => {
      releaseObjectUrl()
      if (request !== loadRequestRef.current) return
      const pixels = loadedImage.naturalWidth * loadedImage.naturalHeight
      if (!loadedImage.naturalWidth || !loadedImage.naturalHeight || pixels > MAX_IMAGE_PIXELS) {
        setFileStatus({
          kind: 'error',
          message: `The image dimensions are invalid or exceed ${MAX_IMAGE_PIXELS.toLocaleString()} pixels.`,
        })
        return
      }
      setImage(loadedImage)
      setImgName(name)
      setFileStatus(null)
      setExportStatus('')
      setExportError('')
    }
    loadedImage.onerror = () => {
      releaseObjectUrl()
      if (request !== loadRequestRef.current) return
      setFileStatus({ kind: 'error', message: `Could not decode ${name} as a supported raster image.` })
    }
    loadedImage.src = src
  }

  const loadFile = (file: File) => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setFileStatus({ kind: 'error', message: 'Choose a PNG, JPEG, WebP, GIF, or BMP raster image.' })
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileStatus({ kind: 'error', message: 'The image is larger than the 20 MB upload limit.' })
      return
    }
    try {
      const url = URL.createObjectURL(file)
      beginImageLoad(url, file.name, url)
    } catch (error) {
      setFileStatus({ kind: 'error', message: errorMessage(error, 'Could not read the selected image.') })
    }
  }

  const loadSample = () => {
    const sampleUrl = `${import.meta.env.BASE_URL}sample.png`
    beginImageLoad(sampleUrl, 'sample.png (Easter line art)')
  }

  useEffect(() => () => {
    loadRequestRef.current += 1
    if (pendingObjectUrlRef.current) URL.revokeObjectURL(pendingObjectUrlRef.current)
    previewWorkerRef.current?.terminate()
    exportWorkerRef.current?.terminate()
  }, [])

  useEffect(() => {
    if (!image) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      try {
        const nextField = processImage(image, imageParams, PREVIEW_IMAGE_SIZE)
        if (!cancelled) {
          setFieldState({ image, key: currentDesignKey, field: nextField })
          setFieldFailure(null)
        }
      } catch (error) {
        if (!cancelled) {
          setFieldFailure({
            image,
            key: currentDesignKey,
            message: errorMessage(error, 'Image processing failed.'),
          })
        }
      }
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [currentDesignKey, image, imageParams])

  useEffect(() => {
    if (!field || !debouncedValidation.valid) {
      previewWorkerRef.current?.terminate()
      previewWorkerRef.current = null
      return
    }

    const requestId = ++workerRequestRef.current
    let worker: Worker
    try {
      worker = createMeshWorker()
    } catch (error) {
      const timer = window.setTimeout(() => {
        setPreviewState({ key: previewKey, mesh: null, error: errorMessage(error, 'Could not start the preview worker.') })
      }, 0)
      return () => window.clearTimeout(timer)
    }
    previewWorkerRef.current?.terminate()
    previewWorkerRef.current = worker

    worker.onmessage = (event: MessageEvent<MeshWorkerResponse>) => {
      if (previewWorkerRef.current !== worker || event.data.id !== requestId) return
      if (event.data.error || !event.data.mesh) {
        setPreviewState({ key: previewKey, mesh: null, error: event.data.error ?? 'Preview generation failed.' })
      } else {
        setPreviewState({ key: previewKey, mesh: event.data.mesh, error: '' })
      }
      worker.terminate()
      previewWorkerRef.current = null
    }
    worker.onerror = (event) => {
      if (previewWorkerRef.current !== worker) return
      setPreviewState({ key: previewKey, mesh: null, error: event.message || 'Preview worker failed.' })
      worker.terminate()
      previewWorkerRef.current = null
    }

    try {
      const data = new Float32Array(field.data)
      worker.postMessage(
        {
          id: requestId,
          kind: 'preview',
          field: { data, w: field.w, h: field.h },
          params: previewParams,
        },
        [data.buffer],
      )
    } catch (error) {
      worker.terminate()
      previewWorkerRef.current = null
      const timer = window.setTimeout(() => {
        setPreviewState({ key: previewKey, mesh: null, error: errorMessage(error, 'Could not send data to the preview worker.') })
      }, 0)
      return () => window.clearTimeout(timer)
    }

    return () => {
      worker.terminate()
      if (previewWorkerRef.current === worker) previewWorkerRef.current = null
    }
  }, [debouncedValidation.valid, field, previewKey, previewParams])

  useEffect(() => {
    if (!preview2dRef.current) return
    const canvas = preview2dRef.current
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (field) context.drawImage(field.canvas, 0, 0, canvas.width, canvas.height)
  }, [field, image])

  const buildStl = (exportField: HeightField, params: SealParams) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const worker = createMeshWorker()
      const requestId = ++workerRequestRef.current
      exportWorkerRef.current?.terminate()
      exportWorkerRef.current = worker
      const finish = () => {
        worker.terminate()
        if (exportWorkerRef.current === worker) exportWorkerRef.current = null
      }
      worker.onmessage = (event: MessageEvent<MeshWorkerResponse>) => {
        if (event.data.id !== requestId) return
        if (event.data.error || !event.data.buffer) {
          reject(new Error(event.data.error ?? 'STL generation failed.'))
        } else {
          resolve(event.data.buffer)
        }
        finish()
      }
      worker.onerror = (event) => {
        reject(new Error(event.message || 'STL worker failed.'))
        finish()
      }
      const data = new Float32Array(exportField.data)
      try {
        worker.postMessage(
          {
            id: requestId,
            kind: 'stl',
            field: { data, w: exportField.w, h: exportField.h },
            params,
          },
          [data.buffer],
        )
      } catch (error) {
        finish()
        reject(error)
      }
    })

  const exportSTL = async () => {
    if (!image || !validation.valid || exportKind) return
    const params = { ...p }
    const sourceImage = image
    setExportKind('stl')
    setExportStatus('Preparing the full-quality STL…')
    setExportError('')
    try {
      await waitForPaint()
      const exportField = processImage(sourceImage, params, EXPORT_IMAGE_SIZE)
      const buffer = await buildStl(exportField, params)
      download(
        new Blob([buffer], { type: 'model/stl' }),
        `cylinder-seal-d${params.diameterMm}-h${params.heightMm}-${params.mode}.stl`,
      )
      setExportStatus('STL download ready.')
    } catch (error) {
      setExportStatus('')
      setExportError(errorMessage(error, 'Could not generate the STL.'))
    } finally {
      setExportKind(null)
    }
  }

  const exportSVG = async () => {
    if (!image || !validation.valid || exportKind) return
    const params = { ...p }
    const sourceImage = image
    setExportKind('svg')
    setExportStatus('Tracing the full-quality SVG…')
    setExportError('')
    try {
      const { default: ImageTracer } = await import('imagetracerjs')
      await waitForPaint()
      const exportField = processImage(sourceImage, params, EXPORT_IMAGE_SIZE)
      const context = exportField.canvas.getContext('2d')
      if (!context) throw new Error('Could not access the image canvas.')
      const rawSvg = ImageTracer.imagedataToSVG(
        context.getImageData(0, 0, exportField.w, exportField.h),
        {
          numberofcolors: 2,
          colorquantcycles: 1,
          colorsampling: 0,
          pal: [
            { r: 0, g: 0, b: 0, a: 255 },
            { r: 255, g: 255, b: 255, a: 255 },
          ],
          pathomit: 6,
          ltres: 1,
          qtres: 1,
          scale: 1,
          roundcoords: 2,
          strokewidth: 0,
          desc: false,
        },
      )
      const widthMm = Math.PI * params.diameterMm
      const svg = formatFlatSvg(rawSvg, exportField.w, exportField.h, widthMm, params.heightMm)
      download(
        new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
        `cylinder-seal-flat-${params.mode}.svg`,
      )
      setExportStatus('SVG download ready.')
    } catch (error) {
      setExportStatus('')
      setExportError(errorMessage(error, 'Could not generate the SVG.'))
    } finally {
      setExportKind(null)
    }
  }

  const radioCardClass =
    'flex cursor-pointer items-center rounded-md border has-[[data-state=checked]]:border-slate-900 has-[[data-state=checked]]:bg-slate-900/5'
  const exportDisabled = !image || !validation.valid || exportKind !== null
  const previewMessage = !image
    ? 'Load a raster image to create a three-dimensional preview.'
    : !debouncedValidation.valid
      ? 'Correct the highlighted settings to create a preview.'
      : fieldBusy || !field
        ? 'Processing the image preview…'
        : previewBusy
          ? 'Building a responsive draft preview…'
          : null

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Cylinder Seal Studio</h1>
            <p className="text-sm text-slate-500">
              Flat raster &rarr; wrapped relief roller &middot; STL for 3D printing, SVG for laser
            </p>
          </div>
          <Badge variant="secondary">client-side &middot; no upload to any server</Badge>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[380px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle><h2 className="text-base">1 &middot; Design</h2></CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <button
                type="button"
                className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-100/60 p-3 text-center transition-colors hover:border-slate-400 focus-visible:border-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                aria-label={image ? 'Choose a different raster image' : 'Choose a raster image'}
                aria-describedby="upload-help upload-status"
                onClick={() => fileRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const file = event.dataTransfer.files?.[0]
                  if (file) loadFile(file)
                }}
              >
                {image ? (
                  <canvas
                    ref={preview2dRef}
                    width={512}
                    height={512}
                    className="h-auto w-full rounded"
                    role="img"
                    aria-label={`Processed two-dimensional preview of ${imgName}`}
                  />
                ) : (
                  <span className="py-8 text-sm text-slate-500">
                    Drop a raster image here
                    <br />
                    or press to browse
                  </span>
                )}
              </button>
              <span id="upload-help" className="sr-only">
                Choose or drop a PNG, JPEG, WebP, GIF, or BMP image up to 20 MB.
              </span>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) loadFile(file)
                }}
              />
              <div id="upload-status" aria-live="polite">
                {fileStatus ? (
                  <p className={`text-xs ${fileStatus.kind === 'error' ? 'text-red-700' : 'text-slate-500'}`} role={fileStatus.kind === 'error' ? 'alert' : 'status'}>
                    {fileStatus.message}
                  </p>
                ) : (
                  <p className="truncate text-xs text-slate-500">{imgName || 'No image loaded'}</p>
                )}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={loadSample} disabled={fileStatus?.kind === 'loading'}>
                  Load sample
                </Button>
              </div>

              <Separator />
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <Label id="threshold-label">Threshold</Label>
                  <span className="text-slate-500">{thresholdDraft}</span>
                </div>
                <Slider
                  value={[thresholdDraft]}
                  min={20}
                  max={240}
                  step={1}
                  aria-labelledby="threshold-label"
                  onValueChange={([value]) => setThresholdDraft(value)}
                  onValueCommit={([value]) => set('threshold', value)}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <Label id="softness-label">Edge softness</Label>
                  <span className="text-slate-500">{softenDraft.toFixed(1)} px</span>
                </div>
                <Slider
                  value={[softenDraft]}
                  min={0}
                  max={3}
                  step={0.1}
                  aria-labelledby="softness-label"
                  onValueChange={([value]) => setSoftenDraft(value)}
                  onValueCommit={([value]) => set('soften', value)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="invert" className="text-sm">Invert (white = design)</Label>
                <Switch id="invert" checked={p.invert} onCheckedChange={(value) => set('invert', value)} />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="mirror" className="text-sm">
                  Mirror <span className="text-slate-400">(correct for rollers)</span>
                </Label>
                <Switch id="mirror" checked={p.mirror} onCheckedChange={(value) => set('mirror', value)} />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="seam" className="text-sm">Seam border band</Label>
                <Switch id="seam" checked={p.seamBand} onCheckedChange={(value) => set('seamBand', value)} />
              </div>
              {fieldError && <p className="text-xs text-red-700" role="alert">{fieldError}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle><h2 className="text-base">2 &middot; Roller</h2></CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p id="mode-label" className="mb-2 text-sm font-medium">Relief mode</p>
                <RadioGroup
                  value={p.mode}
                  onValueChange={(value) => set('mode', value as SealParams['mode'])}
                  className="grid grid-cols-2 gap-2"
                  aria-labelledby="mode-label"
                >
                  <Label htmlFor="raised" className={`${radioCardClass} gap-2 p-3`}>
                    <RadioGroupItem value="raised" id="raised" />
                    <span className="text-sm">Extruded<br /><span className="text-xs text-slate-500">lines raised</span></span>
                  </Label>
                  <Label htmlFor="recessed" className={`${radioCardClass} gap-2 p-3`}>
                    <RadioGroupItem value="recessed" id="recessed" />
                    <span className="text-sm">Intruded<br /><span className="text-xs text-slate-500">lines carved in</span></span>
                  </Label>
                </RadioGroup>
              </div>

              <div>
                <p id="body-label" className="mb-2 text-sm font-medium">Roller body</p>
                <RadioGroup
                  value={p.body}
                  onValueChange={(value) => set('body', value as SealParams['body'])}
                  className="grid grid-cols-3 gap-2"
                  aria-labelledby="body-label"
                >
                  <Label htmlFor="solid" className={`${radioCardClass} gap-1.5 p-2.5`}>
                    <RadioGroupItem value="solid" id="solid" />
                    <span className="text-xs">Solid<br /><span className="text-[10px] text-slate-500">slicer infills</span></span>
                  </Label>
                  <Label htmlFor="bore" className={`${radioCardClass} gap-1.5 p-2.5`}>
                    <RadioGroupItem value="bore" id="bore" />
                    <span className="text-xs">Through-hole<br /><span className="text-[10px] text-slate-500">axle bore</span></span>
                  </Label>
                  <Label htmlFor="shell" className={`${radioCardClass} gap-1.5 p-2.5`}>
                    <RadioGroupItem value="shell" id="shell" />
                    <span className="text-xs">Shell<br /><span className="text-[10px] text-slate-500">hollow, open ends</span></span>
                  </Label>
                </RadioGroup>
              </div>

              <NumericControl
                id="diameter-mm"
                label="Cylinder Ø (mm)"
                value={p.diameterMm}
                step="0.1"
                min={GEOMETRY_LIMITS.diameterMm.min}
                max={GEOMETRY_LIMITS.diameterMm.max}
                errors={issuesFor('diameterMm')}
                onChange={(value) => set('diameterMm', value)}
              />
              <NumericControl
                id="height-mm"
                label="Height (mm)"
                value={p.heightMm}
                step="0.5"
                min={GEOMETRY_LIMITS.heightMm.min}
                max={GEOMETRY_LIMITS.heightMm.max}
                errors={issuesFor('heightMm')}
                onChange={(value) => set('heightMm', value)}
              />
              <NumericControl
                id="relief-mm"
                label="Relief depth (mm)"
                value={p.reliefMm}
                step="0.1"
                min={GEOMETRY_LIMITS.reliefMm.min}
                max={GEOMETRY_LIMITS.reliefMm.max}
                errors={issuesFor('reliefMm')}
                onChange={(value) => set('reliefMm', value)}
              />

              {p.body === 'bore' && (
                <NumericControl
                  id="bore-mm"
                  label="Bore Ø (mm)"
                  value={p.holeMm}
                  step="0.5"
                  min={GEOMETRY_LIMITS.holeMm.min}
                  max={GEOMETRY_LIMITS.holeMm.max}
                  errors={issuesFor('holeMm')}
                  onChange={(value) => set('holeMm', value)}
                />
              )}
              {p.body === 'shell' && (
                <NumericControl
                  id="wall-mm"
                  label="Wall thickness (mm)"
                  value={p.wallMm}
                  step="0.1"
                  min={GEOMETRY_LIMITS.wallMm.min}
                  max={GEOMETRY_LIMITS.wallMm.max}
                  errors={issuesFor('wallMm')}
                  onChange={(value) => set('wallMm', value)}
                />
              )}

              <div>
                <div className="grid grid-cols-[1fr_110px] items-center gap-2">
                  <Label id="mesh-quality-label" className="text-sm">Mesh quality</Label>
                  <Select value={String(p.segments)} onValueChange={(value) => set('segments', Number.parseInt(value, 10))}>
                    <SelectTrigger
                      aria-labelledby="mesh-quality-label"
                      aria-invalid={issuesFor('segments').length > 0 || issuesFor('mesh').length > 0 || undefined}
                      aria-describedby={issuesFor('segments').length > 0 || issuesFor('mesh').length > 0 ? 'mesh-quality-error' : undefined}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="200">Draft (200)</SelectItem>
                      <SelectItem value="320">Standard (320)</SelectItem>
                      <SelectItem value="512">Fine (512)</SelectItem>
                      <SelectItem value="768">Ultra (768)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(issuesFor('segments').length > 0 || issuesFor('mesh').length > 0) && (
                  <p id="mesh-quality-error" className="mt-1 text-xs text-red-700">
                    {[...issuesFor('segments'), ...issuesFor('mesh')].join(' ')}
                  </p>
                )}
              </div>

              <p className="text-xs text-slate-500">
                Circumference: {circ === null ? '—' : `${circ.toFixed(1)} mm`} &middot; the design wraps once around.
                {p.body === 'solid' && ' Solid exports as a closed mesh — infill is set in your slicer; use 3–4 perimeters + about 30% infill for a working roller.'}
                {p.body === 'shell' && ' Shell is an open-ended tube with constant wall under the relief — suited for SLA or mounting on a mandrel.'}
              </p>

              {!validation.valid && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800" role="alert" aria-live="assertive">
                  <p className="font-medium">Correct these settings before export:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {validation.errors.map((error) => <li key={error}>{error}</li>)}
                  </ul>
                </div>
              )}
              {validation.warnings.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800" role="status">
                  {validation.warnings.join(' ')}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="flex min-h-[70vh] flex-col">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle><h2 className="text-base">3 &middot; Preview &amp; export</h2></CardTitle>
            {estimate && (
              <div className="flex flex-wrap justify-end gap-2 text-xs text-slate-500" aria-label="Estimated export size">
                <Badge variant="outline">{estimate.triangles.toLocaleString()} triangles</Badge>
                {stlMB !== null && <Badge variant="outline">STL &asymp; {stlMB.toFixed(1)} MB</Badge>}
              </div>
            )}
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <div className="relative min-h-[420px] flex-1" aria-busy={fieldBusy || previewBusy}>
              {displayMesh ? (
                <Suspense fallback={<div className="flex h-full items-center justify-center rounded-lg border bg-slate-100 text-sm text-slate-500" role="status">Loading 3D viewer…</div>}>
                  <ThreePreview mesh={displayMesh} />
                </Suspense>
              ) : (
                <div className="flex h-full min-h-[420px] items-center justify-center rounded-lg border bg-slate-100 p-6 text-center text-sm text-slate-500" role="status" aria-live="polite">
                  {previewMessage ?? 'Preview unavailable.'}
                </div>
              )}
              {displayMesh && (fieldBusy || previewBusy) && (
                <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1 text-xs text-slate-600 shadow" role="status" aria-live="polite">
                  Updating draft preview…
                </p>
              )}
            </div>
            {previewError && <p className="text-xs text-red-700" role="alert">{previewError}</p>}
            <div className="flex flex-wrap gap-3">
              <Button onClick={exportSTL} disabled={exportDisabled} className="min-w-40">
                {exportKind === 'stl' ? 'Preparing STL…' : 'Download STL'}
              </Button>
              <Button variant="outline" onClick={exportSVG} disabled={exportDisabled}>
                {exportKind === 'svg' ? 'Preparing SVG…' : 'Download flat SVG'}
              </Button>
              <p className="self-center text-xs text-slate-500">
                STL is manifold and uses millimetres. SVG size matches circumference &times; roller height.
              </p>
            </div>
            <div aria-live="polite" aria-atomic="true">
              {exportStatus && <p className="text-xs text-slate-600" role="status">{exportStatus}</p>}
              {exportError && <p className="text-xs text-red-700" role="alert">{exportError}</p>}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
