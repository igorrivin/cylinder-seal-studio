import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  assertCorpusManifest,
  assertRunRecord,
  hashPrompt,
  validateCorpusManifest,
  validateRunRecord,
  validateRunRecordAgainstManifest,
} from './validate'

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/'

function artifact(path: string, sha256: string, mediaType: string) {
  return { path, sha256, media_type: mediaType, bytes: 123 }
}

function corpusArtifact(path: string, sha256: string, mediaType: string) {
  return {
    path,
    sha256,
    media_type: mediaType,
    dimensions: { width: 512, height: 512, unit: 'px' },
    bytes: 123,
  }
}

function corpusCase(id: string, split: 'development' | 'validation' | 'test', sha256: string) {
  return {
    id,
    title: `Benchmark case ${id}`,
    split,
    split_frozen: true,
    categories: ['icon_silhouette'],
    tags: ['clean'],
    difficulty: 'easy',
    input: {
      ...corpusArtifact(`cases/${id}/input.png`, sha256, 'image/png'),
      profile: 'canonical_raster',
      profile_version: '1.0.0',
    },
    reference: {
      ...corpusArtifact(`cases/${id}/reference.svg`, sha256, 'image/svg+xml'),
      kind: 'vector_native',
      render: corpusArtifact(`cases/${id}/reference.png`, sha256, 'image/png'),
    },
    source: {
      kind: 'procedural',
      title: `Source ${id}`,
      creator: 'Cylinder Seal Studio contributors',
      group_id: 'project-procedural',
      page_url: null,
      direct_url: null,
      accessed_at: '2026-07-22',
      sha256,
      transformation: null,
    },
    rights: {
      license_spdx: 'CC0-1.0',
      license_url: LICENSE_URL,
      attribution: 'Cylinder Seal Studio contributors',
      license_evidence_url: LICENSE_URL,
      redistribution_allowed: true,
      adaptation_allowed: true,
      training_allowed: true,
      notes: 'Project-authored procedural source released under CC0-1.0.',
    },
  }
}

function validManifest() {
  return {
    schema_version: '1.0.0',
    corpus: {
      id: 'image-to-svg-v1',
      version: '1.0.0',
      title: 'Image-to-SVG benchmark',
      description: 'A small fixture corpus used to exercise the durable manifest contract.',
      created_at: '2026-07-22T12:00:00Z',
      case_count: 3,
    },
    split_policy: {
      strategy: 'frozen',
      frozen_at: '2026-07-22T12:00:00Z',
      test_is_sealed: true,
      counts: { development: 1, validation: 1, test: 1 },
    },
    cases: [
      corpusCase('case-dev', 'development', SHA_A),
      corpusCase('case-validation', 'validation', SHA_B),
      corpusCase('case-test', 'test', SHA_C),
    ],
  }
}

function validRunRecord() {
  const system = 'Return a self-contained SVG.'
  const user = 'Reconstruct the supplied raster as semantic line art.'
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 50,
    reasoning_tokens: 10,
    total_tokens: 150,
  }
  const cost = {
    usd: 0.05,
    estimated: true,
    pricing_source_url: 'https://example.com/pricing',
  }
  return {
    schema_version: '1.0.0',
    run_id: '20260722t120000z-case-dev-gemini-flash',
    recorded_at: '2026-07-22T12:00:02Z',
    immutable: true,
    benchmark: {
      corpus_id: 'image-to-svg-v1',
      corpus_version: '1.0.0',
      manifest_sha256: SHA_A,
      case_id: 'case-dev',
      split: 'development',
      input: artifact('cases/case-dev/input.png', SHA_A, 'image/png'),
      reference: artifact('cases/case-dev/reference.svg', SHA_B, 'image/svg+xml'),
    },
    pipeline: {
      name: 'semantic-svg-fast-path',
      version: '1.0.0',
      git_commit: 'd'.repeat(40),
      worktree_dirty: false,
      renderer: {
        name: 'resvg',
        version: '2.6.2',
        settings: { width: 1024, height: 1024, background: '#ffffff' },
      },
    },
    attempts: [
      {
        index: 0,
        kind: 'generation',
        status: 'completed',
        started_at: '2026-07-22T12:00:00Z',
        finished_at: '2026-07-22T12:00:02Z',
        latency_ms: 2000,
        model: {
          provider: 'google',
          id: 'gemini-flash',
          version: '2026-07-01',
          settings: { thinking_level: 'medium', temperature: 0 },
        },
        prompt: {
          template_id: 'semantic-svg',
          template_version: '1.0.0',
          system,
          user,
          sha256: hashPrompt(system, user),
        },
        usage: { ...usage },
        cost: { ...cost },
        artifacts: {
          batch_request: artifact(
            'runs/example/batch-request.jsonl',
            SHA_A,
            'application/jsonl',
          ),
          source_trace: artifact('runs/example/source-trace.svg', SHA_B, 'image/svg+xml'),
          candidate_svg: artifact('runs/example/attempt-0.svg', SHA_A, 'image/svg+xml'),
          rendered_png: artifact('runs/example/attempt-0.png', SHA_B, 'image/png'),
          validation_report: artifact(
            'runs/example/attempt-0.validation.json',
            SHA_C,
            'application/json',
          ),
        },
        validation: {
          passed: true,
          failures: [],
          metrics: { iou: 0.91, valid_svg: true },
        },
      },
    ],
    aggregate: {
      latency_ms: 2000,
      usage: { ...usage },
      cost: { ...cost },
      metrics: { iou: 0.91 },
      ratings: {
        fidelity: { score: 4, scale: '1-5', reviewer: 'human-reviewer', notes: '' },
        manufacturability: {
          score: 5,
          scale: '1-5',
          reviewer: 'human-reviewer',
          notes: '',
        },
      },
    },
    outcome: {
      status: 'accepted',
      accepted_attempt: 0,
      final_svg: artifact('runs/example/final.svg', SHA_A, 'image/svg+xml'),
      notes: 'Passed deterministic checks and human review.',
    },
    output_training_rights: {
      training_allowed: false,
      source: {
        cleared: true,
        basis: 'asset_license',
        evidence_url: LICENSE_URL,
        notes: 'The source asset license permits adaptation.',
      },
      provider_output: {
        cleared: false,
        basis: 'unknown',
        terms_url: null,
        terms_version: null,
        terms_effective_at: null,
        notes: 'Provider-output training rights have not been reviewed.',
      },
      reviewed_at: '2026-07-22',
      notes: 'Retained for evaluation only until provider terms are reviewed.',
    },
  }
}

describe('image-to-SVG benchmark schemas', () => {
  it.each(['corpus-manifest.schema.json', 'run-record.schema.json'])(
    'publishes a Draft 2020-12 schema in %s',
    async (filename) => {
      const schema = JSON.parse(await readFile(join(BENCHMARK_DIR, filename), 'utf8')) as {
        $schema?: unknown
        $id?: unknown
      }
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(schema.$id).toBe(`https://cylinderseal.studio/schemas/image-to-svg/${filename}`)
    },
  )

  it('validates representative records with a Draft 2020-12 implementation', async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    addFormats(ajv)
    const [corpusSchema, runSchema] = await Promise.all(
      ['corpus-manifest.schema.json', 'run-record.schema.json'].map(async (filename) =>
        JSON.parse(await readFile(join(BENCHMARK_DIR, filename), 'utf8')),
      ),
    )
    const corpusValidator = ajv.compile(corpusSchema)
    const runValidator = ajv.compile(runSchema)
    expect(corpusValidator(validManifest()), JSON.stringify(corpusValidator.errors)).toBe(true)
    expect(runValidator(validRunRecord()), JSON.stringify(runValidator.errors)).toBe(true)
    const currentManifest = JSON.parse(
      await readFile(join(BENCHMARK_DIR, 'manifest.json'), 'utf8'),
    )
    expect(corpusValidator(currentManifest), JSON.stringify(corpusValidator.errors)).toBe(true)
  })
})

describe('corpus manifest validation', () => {
  it('accepts a complete, frozen, rights-audited manifest', () => {
    const manifest = validManifest()
    expect(validateCorpusManifest(manifest)).toEqual({ valid: true, issues: [] })
    expect(() => assertCorpusManifest(manifest)).not.toThrow()
  })

  it('rejects split drift, inconsistent counts, and unsafe training declarations', () => {
    const manifest = validManifest()
    manifest.cases[0].split_frozen = false
    manifest.cases[0].rights.adaptation_allowed = false
    manifest.split_policy.counts.development = 2

    const validation = validateCorpusManifest(manifest)
    expect(validation.valid).toBe(false)
    expect(validation.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '$.cases[0].split_frozen',
        '$.cases[0].rights',
        '$.split_policy.counts.development',
      ]),
    )
  })

  it('rejects duplicate case IDs and paths', () => {
    const manifest = validManifest()
    manifest.cases[1].id = manifest.cases[0].id
    manifest.cases[1].input.path = manifest.cases[0].input.path

    const paths = validateCorpusManifest(manifest).issues.map(({ path }) => path)
    expect(paths).toContain('$.cases[1].id')
    expect(paths).toContain('$.cases[1].input.path')
  })

  it('rejects impossible calendar dates', () => {
    const manifest = validManifest()
    manifest.cases[0].source.accessed_at = '2026-02-31'
    expect(validateCorpusManifest(manifest).issues.map(({ path }) => path)).toContain(
      '$.cases[0].source.accessed_at',
    )
  })

  it('keeps each external source group in a single split', () => {
    const manifest = validManifest()
    for (const fixture of manifest.cases.slice(0, 2)) {
      fixture.source.kind = 'external'
      fixture.source.group_id = 'shared-external-family'
      fixture.source.page_url = 'https://example.com/source'
    }
    expect(validateCorpusManifest(manifest).issues.map(({ path }) => path)).toContain(
      '$.cases[1].source.group_id',
    )
  })
})

describe('immutable run record validation', () => {
  it('accepts a complete record with exact prompt, attempts, usage, and rights metadata', () => {
    const record = validRunRecord()
    expect(validateRunRecord(record)).toEqual({ valid: true, issues: [] })
    expect(() => assertRunRecord(record)).not.toThrow()
  })

  it('rejects mutable records, prompt drift, non-contiguous attempts, and unsafe rights', () => {
    const record = validRunRecord()
    record.immutable = false
    record.attempts[0].index = 3
    record.attempts[0].prompt.user = 'Changed without updating the digest.'
    record.outcome.final_svg.sha256 = SHA_C
    record.output_training_rights.training_allowed = true

    const paths = validateRunRecord(record).issues.map(({ path }) => path)
    expect(paths).toEqual(
      expect.arrayContaining([
        '$.immutable',
        '$.attempts[0].index',
        '$.attempts[0].prompt.sha256',
        '$.outcome.final_svg.sha256',
        '$.output_training_rights.provider_output.cleared',
      ]),
    )
  })

  it('rejects aggregate token or cost totals that omit an attempt', () => {
    const record = validRunRecord()
    record.aggregate.usage.input_tokens = 99
    record.aggregate.usage.total_tokens = 149
    record.aggregate.cost.usd = 0.04

    const paths = validateRunRecord(record).issues.map(({ path }) => path)
    expect(paths).toContain('$.aggregate.usage.input_tokens')
    expect(paths).toContain('$.aggregate.usage.total_tokens')
    expect(paths).toContain('$.aggregate.cost.usd')
  })

  it('binds a run to the exact manifest bytes and case artifacts', () => {
    const manifest = validManifest()
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
    const record = validRunRecord()
    record.benchmark.manifest_sha256 = createHash('sha256').update(manifestBytes).digest('hex')
    record.benchmark.reference.sha256 = SHA_A

    expect(validateRunRecordAgainstManifest(record, manifestBytes)).toEqual({
      valid: true,
      issues: [],
    })

    record.benchmark.split = 'test'
    record.benchmark.input.sha256 = SHA_C
    const paths = validateRunRecordAgainstManifest(record, manifestBytes).issues.map(
      ({ path }) => path,
    )
    expect(paths).toContain('$.benchmark.split')
    expect(paths).toContain('$.benchmark.input.sha256')
  })
})
