import {
  buildCylinderMesh,
  meshToBinarySTL,
  type HeightSamples,
  type SealParams,
} from '@/lib/seal'

interface WorkerRequest {
  id: number
  kind: 'preview' | 'stl'
  field: HeightSamples
  params: SealParams
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const workerScope = self as unknown as WorkerScope

workerScope.onmessage = ({ data: request }) => {
  try {
    const mesh = buildCylinderMesh(request.field, request.params)
    if (request.kind === 'stl') {
      const buffer = meshToBinarySTL(mesh)
      workerScope.postMessage(
        { id: request.id, kind: request.kind, buffer, triangles: mesh.triangles },
        [buffer],
      )
      return
    }

    workerScope.postMessage(
      {
        id: request.id,
        kind: request.kind,
        mesh: {
          positions: mesh.positions,
          indices: mesh.indices,
          triangles: mesh.triangles,
        },
      },
      [mesh.positions.buffer, mesh.indices.buffer],
    )
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      kind: request.kind,
      error: error instanceof Error ? error.message : 'Mesh generation failed.',
    })
  }
}

export {}
