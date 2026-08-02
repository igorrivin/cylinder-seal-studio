import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertRunRecordAgainstManifest } from './validate'

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_DIR = join(BENCHMARK_DIR, '..', '..')
const RUNS_DIR = join(BENCHMARK_DIR, 'runs')
const MANIFEST_PATH = join(BENCHMARK_DIR, 'manifest.json')

interface Artifact {
  path: string
  sha256: string
  bytes: number
}

interface RunRecord {
  run_id: string
  benchmark: { split: string }
  attempts: Array<{ artifacts: Record<string, Artifact> }>
  outcome: { final_svg: Artifact | null }
  output_training_rights: { training_allowed: boolean }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('image-to-SVG immutable run archive', () => {
  it('validates every run record and its referenced artifact bytes', async () => {
    const manifestBytes = await readFile(MANIFEST_PATH)
    const entries = await readdir(RUNS_DIR, { withFileTypes: true })
    const runDirectories = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filenames = await readdir(join(RUNS_DIR, entry.name))
      if (filenames.includes('record.json')) runDirectories.push(entry)
    }
    runDirectories.sort((left, right) => left.name.localeCompare(right.name))

    expect(runDirectories.length).toBeGreaterThan(0)
    for (const directory of runDirectories) {
      const record = JSON.parse(
        await readFile(join(RUNS_DIR, directory.name, 'record.json'), 'utf8'),
      ) as RunRecord
      assertRunRecordAgainstManifest(record, manifestBytes)
      expect(record.run_id).toBe(directory.name)
      expect(record.benchmark.split).not.toBe('test')
      expect(record.output_training_rights.training_allowed).toBe(false)

      const artifacts = record.attempts.flatMap((attempt) => Object.values(attempt.artifacts))
      if (record.outcome.final_svg) artifacts.push(record.outcome.final_svg)
      const uniqueArtifacts = new Map(artifacts.map((artifact) => [artifact.path, artifact]))
      for (const artifact of uniqueArtifacts.values()) {
        const bytes = await readFile(join(REPOSITORY_DIR, artifact.path))
        expect(bytes.byteLength, artifact.path).toBe(artifact.bytes)
        expect(hash(bytes), artifact.path).toBe(artifact.sha256)
      }
    }
  })
})
