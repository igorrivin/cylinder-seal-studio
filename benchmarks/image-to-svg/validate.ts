import { createHash } from 'node:crypto'

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

type JsonObject = Record<string, unknown>

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/
const SEMANTIC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const SHA256 = /^[a-f0-9]{64}$/
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SPLITS = ['development', 'validation', 'test'] as const

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message })
}

function objectValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): JsonObject | undefined {
  if (!isObject(value)) {
    issue(issues, path, 'must be an object')
    return undefined
  }
  return value
}

function onlyKeys(
  value: JsonObject,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of required) {
    if (!(key in value)) issue(issues, `${path}.${key}`, 'is required')
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, `${path}.${key}`, 'is not an allowed field')
  }
}

function stringValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { nonEmpty?: boolean; pattern?: RegExp } = {},
): string | undefined {
  if (typeof value !== 'string') {
    issue(issues, path, 'must be a string')
    return undefined
  }
  if (options.nonEmpty && value.length === 0) issue(issues, path, 'must not be empty')
  if (options.pattern && !options.pattern.test(value)) issue(issues, path, 'has an invalid format')
  return value
}

function numberValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issue(issues, path, 'must be a finite number')
    return undefined
  }
  if (options.integer && !Number.isInteger(value)) issue(issues, path, 'must be an integer')
  if (options.minimum !== undefined && value < options.minimum) {
    issue(issues, path, `must be at least ${options.minimum}`)
  }
  if (options.maximum !== undefined && value > options.maximum) {
    issue(issues, path, `must be at most ${options.maximum}`)
  }
  return value
}

function booleanValue(value: unknown, path: string, issues: ValidationIssue[]): boolean | undefined {
  if (typeof value !== 'boolean') {
    issue(issues, path, 'must be a boolean')
    return undefined
  }
  return value
}

function enumValue(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  const parsed = stringValue(value, path, issues)
  if (parsed !== undefined && !allowed.includes(parsed)) {
    issue(issues, path, `must be one of: ${allowed.join(', ')}`)
  }
  return parsed
}

function isIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
  )
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value))
}

function dateValue(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const parsed = stringValue(value, path, issues)
  if (parsed !== undefined && !isIsoDate(parsed)) issue(issues, path, 'must be an ISO 8601 date')
  return parsed
}

function dateTimeValue(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const parsed = stringValue(value, path, issues)
  if (parsed !== undefined && !isIsoDateTime(parsed)) {
    issue(issues, path, 'must be an ISO 8601 date-time with a timezone')
  }
  return parsed
}

function urlValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  const parsed = stringValue(value, path, issues, { nonEmpty: true })
  if (parsed === undefined) return
  try {
    const url = new URL(parsed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol')
  } catch {
    issue(issues, path, 'must be an absolute HTTP(S) URL')
  }
}

function relativePathValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  const parsed = stringValue(value, path, issues, { nonEmpty: true })
  if (
    parsed !== undefined
    && (parsed.startsWith('/') || parsed.split('/').includes('..') || parsed.includes('\\'))
  ) {
    issue(issues, path, 'must be a safe POSIX path relative to the repository root')
  }
}

function stringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { minItems?: number; identifier?: boolean; urls?: boolean } = {},
): string[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, path, 'must be an array')
    return undefined
  }
  if (value.length < (options.minItems ?? 0)) {
    issue(issues, path, `must contain at least ${options.minItems} item(s)`)
  }
  const parsed: string[] = []
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    const text = stringValue(item, itemPath, issues, {
      nonEmpty: true,
      pattern: options.identifier ? IDENTIFIER : undefined,
    })
    if (text !== undefined) {
      parsed.push(text)
      if (options.urls) urlValue(text, itemPath, issues)
    }
  })
  if (new Set(parsed).size !== parsed.length) issue(issues, path, 'must not contain duplicates')
  return parsed
}

function dimensionsValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  const dimensions = objectValue(value, path, issues)
  if (!dimensions) return
  onlyKeys(dimensions, ['width', 'height', 'unit'], ['width', 'height', 'unit'], path, issues)
  const width = numberValue(dimensions.width, `${path}.width`, issues)
  const height = numberValue(dimensions.height, `${path}.height`, issues)
  if (width !== undefined && width <= 0) issue(issues, `${path}.width`, 'must be greater than zero')
  if (height !== undefined && height <= 0) issue(issues, `${path}.height`, 'must be greater than zero')
  enumValue(dimensions.unit, ['px', 'viewBox'], `${path}.unit`, issues)
}

function artifactValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { dimensions?: boolean; expectedMediaType?: string; profile?: boolean } = {},
): JsonObject | undefined {
  const artifact = objectValue(value, path, issues)
  if (!artifact) return undefined
  const allowed = options.dimensions
    ? ['path', 'sha256', 'media_type', 'dimensions', 'bytes']
    : ['path', 'sha256', 'media_type', 'bytes']
  if (options.profile) allowed.push('profile', 'profile_version')
  const required = options.dimensions
    ? ['path', 'sha256', 'media_type', 'dimensions']
    : ['path', 'sha256', 'media_type', 'bytes']
  onlyKeys(artifact, allowed, required, path, issues)
  relativePathValue(artifact.path, `${path}.path`, issues)
  stringValue(artifact.sha256, `${path}.sha256`, issues, { pattern: SHA256 })
  const mediaType = stringValue(artifact.media_type, `${path}.media_type`, issues, { nonEmpty: true })
  if (options.expectedMediaType && mediaType !== options.expectedMediaType) {
    issue(issues, `${path}.media_type`, `must be ${options.expectedMediaType}`)
  }
  if (options.dimensions) dimensionsValue(artifact.dimensions, `${path}.dimensions`, issues)
  if ('bytes' in artifact) numberValue(artifact.bytes, `${path}.bytes`, issues, { integer: true, minimum: 0 })
  if ('profile' in artifact) {
    stringValue(artifact.profile, `${path}.profile`, issues, { nonEmpty: true, pattern: IDENTIFIER })
  }
  if ('profile_version' in artifact) {
    stringValue(artifact.profile_version, `${path}.profile_version`, issues, {
      pattern: SEMANTIC_VERSION,
    })
  }
  if (('profile' in artifact) !== ('profile_version' in artifact)) {
    issue(issues, path, 'profile and profile_version must be recorded together')
  }
  return artifact
}

function validateCorpusReference(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): JsonObject | undefined {
  const reference = objectValue(value, path, issues)
  if (!reference) return undefined
  const required = ['path', 'sha256', 'media_type', 'dimensions', 'kind']
  onlyKeys(reference, [...required, 'bytes', 'render'], required, path, issues)
  relativePathValue(reference.path, `${path}.path`, issues)
  stringValue(reference.sha256, `${path}.sha256`, issues, { pattern: SHA256 })
  if (reference.media_type !== 'image/svg+xml') {
    issue(issues, `${path}.media_type`, 'must be image/svg+xml')
  }
  dimensionsValue(reference.dimensions, `${path}.dimensions`, issues)
  stringValue(reference.kind, `${path}.kind`, issues, { nonEmpty: true, pattern: IDENTIFIER })
  if ('bytes' in reference) {
    numberValue(reference.bytes, `${path}.bytes`, issues, { integer: true, minimum: 0 })
  }
  if ('render' in reference) {
    artifactValue(reference.render, `${path}.render`, issues, {
      dimensions: true,
      expectedMediaType: 'image/png',
    })
  }
  return reference
}

function validateSource(value: unknown, path: string, issues: ValidationIssue[]): void {
  const source = objectValue(value, path, issues)
  if (!source) return
  const fields = [
    'kind',
    'title',
    'creator',
    'group_id',
    'page_url',
    'direct_url',
    'accessed_at',
    'sha256',
    'transformation',
  ]
  onlyKeys(source, fields, fields, path, issues)
  enumValue(
    source.kind,
    [
      'external',
      'open_license',
      'public_domain',
      'project_original',
      'procedural',
      'model_assisted_existing_gold',
    ],
    `${path}.kind`,
    issues,
  )
  stringValue(source.title, `${path}.title`, issues, { nonEmpty: true })
  stringValue(source.creator, `${path}.creator`, issues, { nonEmpty: true })
  stringValue(source.group_id, `${path}.group_id`, issues, {
    nonEmpty: true,
    pattern: IDENTIFIER,
  })
  if (source.page_url !== null) urlValue(source.page_url, `${path}.page_url`, issues)
  if (source.direct_url !== null) urlValue(source.direct_url, `${path}.direct_url`, issues)
  if (
    ['external', 'open_license', 'public_domain'].includes(String(source.kind))
    && source.page_url === null
    && source.direct_url === null
  ) {
    issue(issues, path, 'external sources require page_url or direct_url')
  }
  dateValue(source.accessed_at, `${path}.accessed_at`, issues)
  stringValue(source.sha256, `${path}.sha256`, issues, { pattern: SHA256 })
  if (source.transformation !== null) {
    stringValue(source.transformation, `${path}.transformation`, issues, { nonEmpty: true })
  }
}

function validateRights(value: unknown, path: string, issues: ValidationIssue[]): void {
  const rights = objectValue(value, path, issues)
  if (!rights) return
  const fields = [
    'license_spdx',
    'license_url',
    'attribution',
    'license_evidence_url',
    'redistribution_allowed',
    'adaptation_allowed',
    'training_allowed',
    'notes',
  ]
  onlyKeys(rights, fields, fields, path, issues)
  stringValue(rights.license_spdx, `${path}.license_spdx`, issues, { nonEmpty: true })
  urlValue(rights.license_url, `${path}.license_url`, issues)
  stringValue(rights.attribution, `${path}.attribution`, issues, { nonEmpty: true })
  urlValue(rights.license_evidence_url, `${path}.license_evidence_url`, issues)
  booleanValue(rights.redistribution_allowed, `${path}.redistribution_allowed`, issues)
  const adaptationAllowed = booleanValue(
    rights.adaptation_allowed,
    `${path}.adaptation_allowed`,
    issues,
  )
  const trainingAllowed = booleanValue(rights.training_allowed, `${path}.training_allowed`, issues)
  stringValue(rights.notes, `${path}.notes`, issues)
  if (trainingAllowed && !adaptationAllowed) {
    issue(issues, path, 'training_allowed cannot be true when adaptation_allowed is false')
  }
}

function validateCorpusCase(value: unknown, index: number, issues: ValidationIssue[]): JsonObject | undefined {
  const path = `$.cases[${index}]`
  const corpusCase = objectValue(value, path, issues)
  if (!corpusCase) return undefined
  const required = [
    'id',
    'title',
    'split',
    'split_frozen',
    'categories',
    'tags',
    'difficulty',
    'input',
    'reference',
    'source',
    'rights',
  ]
  onlyKeys(corpusCase, [...required, 'notes'], required, path, issues)
  stringValue(corpusCase.id, `${path}.id`, issues, { nonEmpty: true, pattern: IDENTIFIER })
  stringValue(corpusCase.title, `${path}.title`, issues, { nonEmpty: true })
  enumValue(corpusCase.split, SPLITS, `${path}.split`, issues)
  if (booleanValue(corpusCase.split_frozen, `${path}.split_frozen`, issues) === false) {
    issue(issues, `${path}.split_frozen`, 'must remain true')
  }
  stringArray(corpusCase.categories, `${path}.categories`, issues, {
    minItems: 1,
    identifier: true,
  })
  stringArray(corpusCase.tags, `${path}.tags`, issues, { identifier: true })
  enumValue(corpusCase.difficulty, ['easy', 'medium', 'hard'], `${path}.difficulty`, issues)
  const input = artifactValue(corpusCase.input, `${path}.input`, issues, {
    dimensions: true,
    profile: true,
  })
  if (input && typeof input.media_type === 'string' && !input.media_type.startsWith('image/')) {
    issue(issues, `${path}.input.media_type`, 'must be an image media type')
  }
  validateCorpusReference(corpusCase.reference, `${path}.reference`, issues)
  validateSource(corpusCase.source, `${path}.source`, issues)
  validateRights(corpusCase.rights, `${path}.rights`, issues)
  if ('notes' in corpusCase) stringValue(corpusCase.notes, `${path}.notes`, issues)
  return corpusCase
}

function result(issues: ValidationIssue[]): ValidationResult {
  return { valid: issues.length === 0, issues }
}

export function validateCorpusManifest(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  const manifest = objectValue(value, '$', issues)
  if (!manifest) return result(issues)
  onlyKeys(
    manifest,
    ['schema_version', 'corpus', 'split_policy', 'cases'],
    ['schema_version', 'corpus', 'split_policy', 'cases'],
    '$',
    issues,
  )
  if (manifest.schema_version !== '1.0.0') issue(issues, '$.schema_version', 'must be 1.0.0')

  const corpus = objectValue(manifest.corpus, '$.corpus', issues)
  if (corpus) {
    const fields = ['id', 'version', 'title', 'description', 'created_at', 'case_count']
    onlyKeys(corpus, fields, fields, '$.corpus', issues)
    stringValue(corpus.id, '$.corpus.id', issues, { nonEmpty: true, pattern: IDENTIFIER })
    stringValue(corpus.version, '$.corpus.version', issues, { pattern: SEMANTIC_VERSION })
    stringValue(corpus.title, '$.corpus.title', issues, { nonEmpty: true })
    stringValue(corpus.description, '$.corpus.description', issues, { nonEmpty: true })
    dateTimeValue(corpus.created_at, '$.corpus.created_at', issues)
    numberValue(corpus.case_count, '$.corpus.case_count', issues, { integer: true, minimum: 3 })
  }

  const splitPolicy = objectValue(manifest.split_policy, '$.split_policy', issues)
  let declaredCounts: JsonObject | undefined
  if (splitPolicy) {
    const fields = ['strategy', 'frozen_at', 'test_is_sealed', 'counts']
    onlyKeys(splitPolicy, fields, fields, '$.split_policy', issues)
    if (splitPolicy.strategy !== 'frozen') issue(issues, '$.split_policy.strategy', 'must be frozen')
    dateTimeValue(splitPolicy.frozen_at, '$.split_policy.frozen_at', issues)
    if (splitPolicy.test_is_sealed !== true) {
      issue(issues, '$.split_policy.test_is_sealed', 'must remain true')
    }
    declaredCounts = objectValue(splitPolicy.counts, '$.split_policy.counts', issues)
    if (declaredCounts) {
      onlyKeys(declaredCounts, SPLITS, SPLITS, '$.split_policy.counts', issues)
      for (const split of SPLITS) {
        numberValue(declaredCounts[split], `$.split_policy.counts.${split}`, issues, {
          integer: true,
          minimum: 1,
        })
      }
    }
  }

  if (!Array.isArray(manifest.cases)) {
    issue(issues, '$.cases', 'must be an array')
    return result(issues)
  }
  if (manifest.cases.length < 3) issue(issues, '$.cases', 'must contain at least three cases')
  if (corpus && corpus.case_count !== manifest.cases.length) {
    issue(
      issues,
      '$.corpus.case_count',
      `declares ${String(corpus.case_count)}, but the manifest contains ${manifest.cases.length} case(s)`,
    )
  }
  const ids = new Set<string>()
  const inputPaths = new Set<string>()
  const referencePaths = new Set<string>()
  const externalGroupSplits = new Map<string, string>()
  const actualCounts: Record<(typeof SPLITS)[number], number> = {
    development: 0,
    validation: 0,
    test: 0,
  }
  manifest.cases.forEach((item, index) => {
    const parsed = validateCorpusCase(item, index, issues)
    if (!parsed) return
    if (typeof parsed.id === 'string') {
      if (ids.has(parsed.id)) issue(issues, `$.cases[${index}].id`, 'must be unique')
      ids.add(parsed.id)
    }
    if (SPLITS.includes(parsed.split as (typeof SPLITS)[number])) {
      actualCounts[parsed.split as (typeof SPLITS)[number]] += 1
    }
    const input = isObject(parsed.input) ? parsed.input : undefined
    const reference = isObject(parsed.reference) ? parsed.reference : undefined
    const source = isObject(parsed.source) ? parsed.source : undefined
    if (input && typeof input.path === 'string') {
      if (inputPaths.has(input.path)) issue(issues, `$.cases[${index}].input.path`, 'must be unique')
      inputPaths.add(input.path)
    }
    if (reference && typeof reference.path === 'string') {
      if (referencePaths.has(reference.path)) {
        issue(issues, `$.cases[${index}].reference.path`, 'must be unique')
      }
      referencePaths.add(reference.path)
    }
    if (
      source
      && ['external', 'open_license', 'public_domain'].includes(String(source.kind))
      && typeof source.group_id === 'string'
      && typeof parsed.split === 'string'
    ) {
      const priorSplit = externalGroupSplits.get(source.group_id)
      if (priorSplit && priorSplit !== parsed.split) {
        issue(
          issues,
          `$.cases[${index}].source.group_id`,
          `external group already belongs to the ${priorSplit} split`,
        )
      }
      externalGroupSplits.set(source.group_id, parsed.split)
    }
  })
  if (declaredCounts) {
    for (const split of SPLITS) {
      if (declaredCounts[split] !== actualCounts[split]) {
        issue(
          issues,
          `$.split_policy.counts.${split}`,
          `declares ${String(declaredCounts[split])}, but ${actualCounts[split]} case(s) use this split`,
        )
      }
    }
  }
  return result(issues)
}

function validateJsonValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) issue(issues, path, 'must be finite')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, issues))
    return
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) validateJsonValue(item, `${path}.${key}`, issues)
    return
  }
  issue(issues, path, 'must be valid JSON data')
}

function validateUsage(value: unknown, path: string, issues: ValidationIssue[]): JsonObject | undefined {
  const usage = objectValue(value, path, issues)
  if (!usage) return undefined
  const fields = [
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'reasoning_tokens',
    'total_tokens',
  ]
  onlyKeys(usage, fields, fields, path, issues)
  for (const field of fields) {
    numberValue(usage[field], `${path}.${field}`, issues, { integer: true, minimum: 0 })
  }
  if (
    typeof usage.cached_input_tokens === 'number'
    && typeof usage.input_tokens === 'number'
    && usage.cached_input_tokens > usage.input_tokens
  ) {
    issue(issues, `${path}.cached_input_tokens`, 'cannot exceed input_tokens')
  }
  if (
    typeof usage.reasoning_tokens === 'number'
    && typeof usage.output_tokens === 'number'
    && usage.reasoning_tokens > usage.output_tokens
  ) {
    issue(issues, `${path}.reasoning_tokens`, 'cannot exceed output_tokens')
  }
  if (
    typeof usage.input_tokens === 'number'
    && typeof usage.output_tokens === 'number'
    && usage.total_tokens !== usage.input_tokens + usage.output_tokens
  ) {
    issue(issues, `${path}.total_tokens`, 'must equal input_tokens + output_tokens')
  }
  return usage
}

function validateCost(value: unknown, path: string, issues: ValidationIssue[]): JsonObject | undefined {
  const cost = objectValue(value, path, issues)
  if (!cost) return undefined
  const fields = ['usd', 'estimated', 'pricing_source_url']
  onlyKeys(cost, fields, fields, path, issues)
  numberValue(cost.usd, `${path}.usd`, issues, { minimum: 0 })
  booleanValue(cost.estimated, `${path}.estimated`, issues)
  if (cost.pricing_source_url !== null) urlValue(cost.pricing_source_url, `${path}.pricing_source_url`, issues)
  return cost
}

function validateModel(value: unknown, path: string, issues: ValidationIssue[]): void {
  const model = objectValue(value, path, issues)
  if (!model) return
  const fields = ['provider', 'id', 'version', 'settings']
  onlyKeys(model, fields, fields, path, issues)
  stringValue(model.provider, `${path}.provider`, issues, { nonEmpty: true })
  stringValue(model.id, `${path}.id`, issues, { nonEmpty: true })
  stringValue(model.version, `${path}.version`, issues, { nonEmpty: true })
  const settings = objectValue(model.settings, `${path}.settings`, issues)
  if (settings) validateJsonValue(settings, `${path}.settings`, issues)
}

export function hashPrompt(system: string, user: string): string {
  return createHash('sha256').update(system).update('\0').update(user).digest('hex')
}

function validatePrompt(value: unknown, path: string, issues: ValidationIssue[]): void {
  const prompt = objectValue(value, path, issues)
  if (!prompt) return
  const fields = ['template_id', 'template_version', 'system', 'user', 'sha256']
  onlyKeys(prompt, fields, fields, path, issues)
  stringValue(prompt.template_id, `${path}.template_id`, issues, { pattern: IDENTIFIER })
  stringValue(prompt.template_version, `${path}.template_version`, issues, {
    pattern: SEMANTIC_VERSION,
  })
  const system = stringValue(prompt.system, `${path}.system`, issues)
  const user = stringValue(prompt.user, `${path}.user`, issues, { nonEmpty: true })
  const sha256 = stringValue(prompt.sha256, `${path}.sha256`, issues, { pattern: SHA256 })
  if (system !== undefined && user !== undefined && sha256 !== hashPrompt(system, user)) {
    issue(issues, `${path}.sha256`, 'does not match the canonical system + NUL + user prompt hash')
  }
}

function validateFailure(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const failure = objectValue(value, path, issues)
  if (!failure) return undefined
  const fields = ['code', 'severity', 'message']
  onlyKeys(failure, fields, fields, path, issues)
  stringValue(failure.code, `${path}.code`, issues, { pattern: IDENTIFIER })
  const severity = enumValue(failure.severity, ['warning', 'error'], `${path}.severity`, issues)
  stringValue(failure.message, `${path}.message`, issues, { nonEmpty: true })
  return severity
}

function validateValidation(value: unknown, path: string, issues: ValidationIssue[]): void {
  const validation = objectValue(value, path, issues)
  if (!validation) return
  const fields = ['passed', 'failures', 'metrics']
  onlyKeys(validation, fields, fields, path, issues)
  const passed = booleanValue(validation.passed, `${path}.passed`, issues)
  let hasError = false
  if (!Array.isArray(validation.failures)) {
    issue(issues, `${path}.failures`, 'must be an array')
  } else {
    validation.failures.forEach((failure, index) => {
      if (validateFailure(failure, `${path}.failures[${index}]`, issues) === 'error') hasError = true
    })
  }
  const metrics = objectValue(validation.metrics, `${path}.metrics`, issues)
  if (metrics) validateJsonValue(metrics, `${path}.metrics`, issues)
  if (passed && hasError) issue(issues, path, 'cannot pass while retaining an error-severity failure')
}

interface ParsedAttempt {
  value: JsonObject
  usage?: JsonObject
  cost?: JsonObject
}

function validateAttempt(value: unknown, index: number, issues: ValidationIssue[]): ParsedAttempt | undefined {
  const path = `$.attempts[${index}]`
  const attempt = objectValue(value, path, issues)
  if (!attempt) return undefined
  const required = [
    'index',
    'kind',
    'status',
    'started_at',
    'finished_at',
    'latency_ms',
    'model',
    'prompt',
    'usage',
    'cost',
    'artifacts',
  ]
  onlyKeys(attempt, [...required, 'validation', 'error'], required, path, issues)
  const attemptIndex = numberValue(attempt.index, `${path}.index`, issues, {
    integer: true,
    minimum: 0,
  })
  if (attemptIndex !== index) issue(issues, `${path}.index`, `must be the contiguous index ${index}`)
  enumValue(attempt.kind, ['generation', 'repair', 'fallback', 'human_edit'], `${path}.kind`, issues)
  const status = enumValue(attempt.status, ['completed', 'failed'], `${path}.status`, issues)
  const started = dateTimeValue(attempt.started_at, `${path}.started_at`, issues)
  const finished = dateTimeValue(attempt.finished_at, `${path}.finished_at`, issues)
  if (started && finished && Date.parse(finished) < Date.parse(started)) {
    issue(issues, `${path}.finished_at`, 'must not precede started_at')
  }
  numberValue(attempt.latency_ms, `${path}.latency_ms`, issues, { integer: true, minimum: 0 })
  validateModel(attempt.model, `${path}.model`, issues)
  validatePrompt(attempt.prompt, `${path}.prompt`, issues)
  const usage = validateUsage(attempt.usage, `${path}.usage`, issues)
  const cost = validateCost(attempt.cost, `${path}.cost`, issues)
  const artifacts = objectValue(attempt.artifacts, `${path}.artifacts`, issues)
  if (artifacts) {
    const requiredArtifacts = ['candidate_svg', 'rendered_png', 'validation_report']
    const fields = [
      'provider_response',
      'batch_request',
      'raw_model_output',
      'source_trace',
      ...requiredArtifacts,
    ]
    onlyKeys(
      artifacts,
      fields,
      status === 'completed' ? requiredArtifacts : [],
      `${path}.artifacts`,
      issues,
    )
    if ('provider_response' in artifacts) {
      artifactValue(artifacts.provider_response, `${path}.artifacts.provider_response`, issues, {
        expectedMediaType: 'application/json',
      })
    }
    if ('batch_request' in artifacts) {
      artifactValue(artifacts.batch_request, `${path}.artifacts.batch_request`, issues, {
        expectedMediaType: 'application/jsonl',
      })
    }
    if ('raw_model_output' in artifacts) {
      artifactValue(artifacts.raw_model_output, `${path}.artifacts.raw_model_output`, issues, {
        expectedMediaType: 'text/plain',
      })
    }
    if ('source_trace' in artifacts) {
      artifactValue(artifacts.source_trace, `${path}.artifacts.source_trace`, issues, {
        expectedMediaType: 'image/svg+xml',
      })
    }
    if ('candidate_svg' in artifacts) {
      artifactValue(artifacts.candidate_svg, `${path}.artifacts.candidate_svg`, issues, {
        expectedMediaType: 'image/svg+xml',
      })
    }
    if ('rendered_png' in artifacts) {
      artifactValue(artifacts.rendered_png, `${path}.artifacts.rendered_png`, issues, {
        expectedMediaType: 'image/png',
      })
    }
    if ('validation_report' in artifacts) {
      artifactValue(artifacts.validation_report, `${path}.artifacts.validation_report`, issues, {
        expectedMediaType: 'application/json',
      })
    }
  }
  if (status === 'completed') {
    if (!('validation' in attempt)) issue(issues, `${path}.validation`, 'is required for completed attempts')
    else validateValidation(attempt.validation, `${path}.validation`, issues)
  }
  if (status === 'failed') {
    stringValue(attempt.error, `${path}.error`, issues, { nonEmpty: true })
  }
  return { value: attempt, usage, cost }
}

function validateRating(value: unknown, path: string, issues: ValidationIssue[]): void {
  const rating = objectValue(value, path, issues)
  if (!rating) return
  const fields = ['score', 'scale', 'reviewer', 'notes']
  onlyKeys(rating, fields, fields, path, issues)
  if (rating.score !== null) {
    numberValue(rating.score, `${path}.score`, issues, { minimum: 1, maximum: 5 })
  }
  if (rating.scale !== '1-5') issue(issues, `${path}.scale`, 'must be 1-5')
  stringValue(rating.reviewer, `${path}.reviewer`, issues, { nonEmpty: true })
  stringValue(rating.notes, `${path}.notes`, issues)
}

function validateTrainingRights(value: unknown, path: string, issues: ValidationIssue[]): void {
  const rights = objectValue(value, path, issues)
  if (!rights) return
  const fields = ['training_allowed', 'source', 'provider_output', 'reviewed_at', 'notes']
  onlyKeys(rights, fields, fields, path, issues)
  const allowed = booleanValue(rights.training_allowed, `${path}.training_allowed`, issues)

  const source = objectValue(rights.source, `${path}.source`, issues)
  let sourceCleared: boolean | undefined
  if (source) {
    const sourceFields = ['cleared', 'basis', 'evidence_url', 'notes']
    onlyKeys(source, sourceFields, sourceFields, `${path}.source`, issues)
    sourceCleared = booleanValue(source.cleared, `${path}.source.cleared`, issues)
    const sourceBasis = enumValue(
      source.basis,
      ['asset_license', 'owner_permission', 'unknown'],
      `${path}.source.basis`,
      issues,
    )
    if (source.evidence_url !== null) {
      urlValue(source.evidence_url, `${path}.source.evidence_url`, issues)
    }
    stringValue(source.notes, `${path}.source.notes`, issues, { nonEmpty: true })
    if (sourceCleared && sourceBasis === 'unknown') {
      issue(issues, `${path}.source.basis`, 'cannot be unknown when source rights are cleared')
    }
    if (sourceCleared && source.evidence_url === null) {
      issue(issues, `${path}.source.evidence_url`, 'is required when source rights are cleared')
    }
  }

  const provider = objectValue(rights.provider_output, `${path}.provider_output`, issues)
  let providerCleared: boolean | undefined
  if (provider) {
    const providerFields = [
      'cleared',
      'basis',
      'terms_url',
      'terms_version',
      'terms_effective_at',
      'notes',
    ]
    onlyKeys(provider, providerFields, providerFields, `${path}.provider_output`, issues)
    providerCleared = booleanValue(
      provider.cleared,
      `${path}.provider_output.cleared`,
      issues,
    )
    const providerBasis = enumValue(
      provider.basis,
      ['provider_terms', 'owner_permission', 'not_applicable', 'unknown'],
      `${path}.provider_output.basis`,
      issues,
    )
    if (provider.terms_url !== null) {
      urlValue(provider.terms_url, `${path}.provider_output.terms_url`, issues)
    }
    if (provider.terms_version !== null) {
      stringValue(provider.terms_version, `${path}.provider_output.terms_version`, issues, {
        nonEmpty: true,
      })
    }
    if (provider.terms_effective_at !== null) {
      dateValue(provider.terms_effective_at, `${path}.provider_output.terms_effective_at`, issues)
    }
    stringValue(provider.notes, `${path}.provider_output.notes`, issues, { nonEmpty: true })
    if (providerCleared && providerBasis === 'unknown') {
      issue(
        issues,
        `${path}.provider_output.basis`,
        'cannot be unknown when provider-output rights are cleared',
      )
    }
    if (providerBasis === 'provider_terms') {
      if (provider.terms_url === null) {
        issue(issues, `${path}.provider_output.terms_url`, 'is required for provider_terms')
      }
      if (provider.terms_version === null) {
        issue(issues, `${path}.provider_output.terms_version`, 'is required for provider_terms')
      }
      if (provider.terms_effective_at === null) {
        issue(
          issues,
          `${path}.provider_output.terms_effective_at`,
          'is required for provider_terms',
        )
      }
    }
  }

  dateValue(rights.reviewed_at, `${path}.reviewed_at`, issues)
  stringValue(rights.notes, `${path}.notes`, issues, { nonEmpty: true })
  if (allowed && sourceCleared !== true) {
    issue(issues, `${path}.source.cleared`, 'must be true when training_allowed is true')
  }
  if (allowed && providerCleared !== true) {
    issue(
      issues,
      `${path}.provider_output.cleared`,
      'must be true when training_allowed is true',
    )
  }
}

export function validateRunRecord(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  const record = objectValue(value, '$', issues)
  if (!record) return result(issues)
  const fields = [
    'schema_version',
    'run_id',
    'recorded_at',
    'immutable',
    'benchmark',
    'pipeline',
    'attempts',
    'aggregate',
    'outcome',
    'output_training_rights',
  ]
  onlyKeys(record, fields, fields, '$', issues)
  if (record.schema_version !== '1.0.0') issue(issues, '$.schema_version', 'must be 1.0.0')
  stringValue(record.run_id, '$.run_id', issues, { nonEmpty: true, pattern: IDENTIFIER })
  dateTimeValue(record.recorded_at, '$.recorded_at', issues)
  if (record.immutable !== true) issue(issues, '$.immutable', 'must remain true')

  const benchmark = objectValue(record.benchmark, '$.benchmark', issues)
  if (benchmark) {
    const benchmarkFields = [
      'corpus_id',
      'corpus_version',
      'manifest_sha256',
      'case_id',
      'split',
      'input',
      'reference',
    ]
    onlyKeys(benchmark, benchmarkFields, benchmarkFields, '$.benchmark', issues)
    stringValue(benchmark.corpus_id, '$.benchmark.corpus_id', issues, { pattern: IDENTIFIER })
    stringValue(benchmark.corpus_version, '$.benchmark.corpus_version', issues, {
      pattern: SEMANTIC_VERSION,
    })
    stringValue(benchmark.manifest_sha256, '$.benchmark.manifest_sha256', issues, {
      pattern: SHA256,
    })
    stringValue(benchmark.case_id, '$.benchmark.case_id', issues, { pattern: IDENTIFIER })
    enumValue(benchmark.split, SPLITS, '$.benchmark.split', issues)
    artifactValue(benchmark.input, '$.benchmark.input', issues)
    artifactValue(benchmark.reference, '$.benchmark.reference', issues, {
      expectedMediaType: 'image/svg+xml',
    })
  }

  const pipeline = objectValue(record.pipeline, '$.pipeline', issues)
  if (pipeline) {
    const pipelineFields = ['name', 'version', 'git_commit', 'worktree_dirty', 'renderer']
    onlyKeys(pipeline, pipelineFields, pipelineFields, '$.pipeline', issues)
    stringValue(pipeline.name, '$.pipeline.name', issues, { pattern: IDENTIFIER })
    stringValue(pipeline.version, '$.pipeline.version', issues, { pattern: SEMANTIC_VERSION })
    stringValue(pipeline.git_commit, '$.pipeline.git_commit', issues, { pattern: GIT_OBJECT_ID })
    booleanValue(pipeline.worktree_dirty, '$.pipeline.worktree_dirty', issues)
    const renderer = objectValue(pipeline.renderer, '$.pipeline.renderer', issues)
    if (renderer) {
      const rendererFields = ['name', 'version', 'settings']
      onlyKeys(renderer, rendererFields, rendererFields, '$.pipeline.renderer', issues)
      stringValue(renderer.name, '$.pipeline.renderer.name', issues, { nonEmpty: true })
      stringValue(renderer.version, '$.pipeline.renderer.version', issues, { nonEmpty: true })
      const settings = objectValue(renderer.settings, '$.pipeline.renderer.settings', issues)
      if (settings) validateJsonValue(settings, '$.pipeline.renderer.settings', issues)
    }
  }

  const parsedAttempts: ParsedAttempt[] = []
  if (!Array.isArray(record.attempts) || record.attempts.length === 0) {
    issue(issues, '$.attempts', 'must be a non-empty array')
  } else {
    record.attempts.forEach((attempt, index) => {
      const parsed = validateAttempt(attempt, index, issues)
      if (parsed) parsedAttempts.push(parsed)
    })
  }

  const aggregate = objectValue(record.aggregate, '$.aggregate', issues)
  if (aggregate) {
    const aggregateFields = ['latency_ms', 'usage', 'cost', 'metrics', 'ratings']
    onlyKeys(aggregate, aggregateFields, aggregateFields, '$.aggregate', issues)
    numberValue(aggregate.latency_ms, '$.aggregate.latency_ms', issues, {
      integer: true,
      minimum: 0,
    })
    const aggregateUsage = validateUsage(aggregate.usage, '$.aggregate.usage', issues)
    const aggregateCost = validateCost(aggregate.cost, '$.aggregate.cost', issues)
    const metrics = objectValue(aggregate.metrics, '$.aggregate.metrics', issues)
    if (metrics) validateJsonValue(metrics, '$.aggregate.metrics', issues)
    const ratings = objectValue(aggregate.ratings, '$.aggregate.ratings', issues)
    if (ratings) {
      const ratingFields = ['fidelity', 'manufacturability']
      onlyKeys(ratings, ratingFields, ratingFields, '$.aggregate.ratings', issues)
      validateRating(ratings.fidelity, '$.aggregate.ratings.fidelity', issues)
      validateRating(ratings.manufacturability, '$.aggregate.ratings.manufacturability', issues)
    }
    if (aggregateUsage) {
      for (const field of [
        'input_tokens',
        'cached_input_tokens',
        'output_tokens',
        'reasoning_tokens',
        'total_tokens',
      ]) {
        const sum = parsedAttempts.reduce((total, attempt) => {
          const count = attempt.usage?.[field]
          return total + (typeof count === 'number' ? count : 0)
        }, 0)
        if (aggregateUsage[field] !== sum) {
          issue(issues, `$.aggregate.usage.${field}`, `must equal the attempt total ${sum}`)
        }
      }
    }
    if (aggregateCost && typeof aggregateCost.usd === 'number') {
      const sum = parsedAttempts.reduce((total, attempt) => {
        const amount = attempt.cost?.usd
        return total + (typeof amount === 'number' ? amount : 0)
      }, 0)
      if (Math.abs(aggregateCost.usd - sum) > 0.000001) {
        issue(issues, '$.aggregate.cost.usd', `must equal the attempt total ${sum}`)
      }
    }
  }

  const outcome = objectValue(record.outcome, '$.outcome', issues)
  if (outcome) {
    const outcomeFields = ['status', 'accepted_attempt', 'final_svg', 'notes']
    onlyKeys(outcome, outcomeFields, outcomeFields, '$.outcome', issues)
    const status = enumValue(
      outcome.status,
      ['accepted', 'rejected', 'error', 'fallback'],
      '$.outcome.status',
      issues,
    )
    stringValue(outcome.notes, '$.outcome.notes', issues)
    if (status === 'accepted' || status === 'fallback') {
      const acceptedAttempt = numberValue(
        outcome.accepted_attempt,
        '$.outcome.accepted_attempt',
        issues,
        { integer: true, minimum: 0 },
      )
      artifactValue(outcome.final_svg, '$.outcome.final_svg', issues, {
        expectedMediaType: 'image/svg+xml',
      })
      if (
        acceptedAttempt !== undefined
        && parsedAttempts[acceptedAttempt]?.value.status !== 'completed'
      ) {
        issue(issues, '$.outcome.accepted_attempt', 'must identify a completed attempt')
      }
      const finalSvg = isObject(outcome.final_svg) ? outcome.final_svg : undefined
      const acceptedArtifacts =
        acceptedAttempt === undefined
          ? undefined
          : parsedAttempts[acceptedAttempt]?.value.artifacts
      const candidateSvg =
        isObject(acceptedArtifacts) && isObject(acceptedArtifacts.candidate_svg)
          ? acceptedArtifacts.candidate_svg
          : undefined
      if (finalSvg && candidateSvg && finalSvg.sha256 !== candidateSvg.sha256) {
        issue(
          issues,
          '$.outcome.final_svg.sha256',
          'must match the accepted attempt candidate_svg hash',
        )
      }
    } else if (status !== undefined) {
      if (outcome.accepted_attempt !== null) {
        issue(issues, '$.outcome.accepted_attempt', 'must be null for an unsuccessful outcome')
      }
      if (outcome.final_svg !== null) {
        issue(issues, '$.outcome.final_svg', 'must be null for an unsuccessful outcome')
      }
    }
  }
  validateTrainingRights(record.output_training_rights, '$.output_training_rights', issues)
  return result(issues)
}

export function validateRunRecordAgainstManifest(
  recordValue: unknown,
  manifestBytes: string | Uint8Array,
): ValidationResult {
  const issues: ValidationIssue[] = []
  const recordValidation = validateRunRecord(recordValue)
  issues.push(...recordValidation.issues)
  const manifestText =
    typeof manifestBytes === 'string' ? manifestBytes : new TextDecoder().decode(manifestBytes)
  let manifestValue: unknown
  try {
    manifestValue = JSON.parse(manifestText)
  } catch {
    issue(issues, 'manifest', 'must contain valid JSON')
    return result(issues)
  }
  const manifestValidation = validateCorpusManifest(manifestValue)
  issues.push(
    ...manifestValidation.issues.map(({ path, message }) => ({
      path: `manifest${path.slice(1)}`,
      message,
    })),
  )
  if (!recordValidation.valid || !manifestValidation.valid) return result(issues)

  const record = recordValue as JsonObject
  const manifest = manifestValue as JsonObject
  const benchmark = record.benchmark as JsonObject
  const corpus = manifest.corpus as JsonObject
  const cases = manifest.cases as JsonObject[]
  const corpusCase = cases.find((candidate) => candidate.id === benchmark.case_id)

  if (benchmark.corpus_id !== corpus.id) {
    issue(issues, '$.benchmark.corpus_id', 'does not match the supplied manifest')
  }
  if (benchmark.corpus_version !== corpus.version) {
    issue(issues, '$.benchmark.corpus_version', 'does not match the supplied manifest')
  }
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  if (benchmark.manifest_sha256 !== manifestSha256) {
    issue(issues, '$.benchmark.manifest_sha256', 'does not hash the supplied manifest bytes')
  }
  if (!corpusCase) {
    issue(issues, '$.benchmark.case_id', 'does not exist in the supplied manifest')
    return result(issues)
  }
  if (benchmark.split !== corpusCase.split) {
    issue(issues, '$.benchmark.split', 'does not match the manifest case split')
  }

  const artifactPairs: Array<{
    path: string
    record: JsonObject
    manifest: JsonObject
  }> = [
    {
      path: '$.benchmark.input',
      record: benchmark.input as JsonObject,
      manifest: corpusCase.input as JsonObject,
    },
    {
      path: '$.benchmark.reference',
      record: benchmark.reference as JsonObject,
      manifest: corpusCase.reference as JsonObject,
    },
  ]
  for (const pair of artifactPairs) {
    for (const field of ['path', 'sha256', 'media_type', 'bytes']) {
      if (pair.record[field] !== pair.manifest[field]) {
        issue(issues, `${pair.path}.${field}`, 'does not match the manifest case artifact')
      }
    }
  }
  return result(issues)
}

export function assertCorpusManifest(value: unknown): void {
  const validation = validateCorpusManifest(value)
  if (!validation.valid) {
    throw new Error(validation.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'))
  }
}

export function assertRunRecord(value: unknown): void {
  const validation = validateRunRecord(value)
  if (!validation.valid) {
    throw new Error(validation.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'))
  }
}

export function assertRunRecordAgainstManifest(
  record: unknown,
  manifestBytes: string | Uint8Array,
): void {
  const validation = validateRunRecordAgainstManifest(record, manifestBytes)
  if (!validation.valid) {
    throw new Error(validation.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'))
  }
}
