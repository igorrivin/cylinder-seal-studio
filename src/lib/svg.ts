function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`)
  }
}

function formatNumber(value: number): string {
  return value.toFixed(6).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1')
}

function attributeValue(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  return match?.[2]?.trim() ?? null
}

function styleValue(tag: string, name: string): string | null {
  const style = attributeValue(tag, 'style')
  if (!style) return null
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    if (declaration.slice(0, colon).trim().toLowerCase() === name) {
      return declaration.slice(colon + 1).trim()
    }
  }
  return null
}

function isWhite(color: string | null): boolean {
  if (!color) return false
  const normalized = color.toLowerCase().replace(/\s+/g, '')
  if (normalized === 'white' || normalized === '#fff' || normalized === '#ffffff') return true
  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (!rgb) return false
  const channels = rgb[1].split(',').slice(0, 3)
  return channels.length === 3 && channels.every((channel) => channel === '255' || channel === '100%')
}

function removeStrokeAttributes(path: string): string {
  let cleaned = path.replace(
    /\s+stroke(?:-[\w:-]+)?\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  )
  cleaned = cleaned.replace(/\s+style\s*=\s*(["'])(.*?)\1/gi, (_match, quote: string, style: string) => {
    const retained = style
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration && !/^stroke(?:-[\w-]+)?\s*:/i.test(declaration))
    return retained.length > 0 ? ` style=${quote}${retained.join(';')}${quote}` : ''
  })
  return cleaned
}

function compactPath(path: string): string {
  return removeStrokeAttributes(path)
    .replace(/\s+/g, ' ')
    .replace(/\s*\/>\s*$/, '/>')
    .trim()
}

/**
 * Converts trusted tracer output into a dimensionally accurate, fill-only
 * fabrication SVG. Only traced paths are retained; white background paths and
 * all stroke styling are removed. Path-level transforms are preserved.
 */
export function formatFlatSvg(
  rawSvg: string,
  widthPx: number,
  heightPx: number,
  widthMm: number,
  heightMm: number,
): string {
  requirePositiveFinite(widthPx, 'SVG source width')
  requirePositiveFinite(heightPx, 'SVG source height')
  requirePositiveFinite(widthMm, 'SVG physical width')
  requirePositiveFinite(heightMm, 'SVG physical height')

  const root = rawSvg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/i)
  if (!root) throw new Error('Tracer output does not contain a complete SVG root element.')

  const paths = root[1].match(/<path\b[^>]*(?:\/>|>[\s\S]*?<\/path\s*>)/gi) ?? []
  const foregroundPaths = paths
    .filter((path) => !isWhite(attributeValue(path, 'fill') ?? styleValue(path, 'fill')))
    .map(compactPath)

  const sourceWidth = formatNumber(widthPx)
  const sourceHeight = formatNumber(heightPx)
  const physicalWidth = formatNumber(widthMm)
  const physicalHeight = formatNumber(heightMm)
  const body = foregroundPaths.length > 0 ? `\n  ${foregroundPaths.join('\n  ')}\n` : '\n'

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${physicalWidth}mm" height="${physicalHeight}mm" viewBox="0 0 ${sourceWidth} ${sourceHeight}" preserveAspectRatio="none">${body}</svg>\n`
}
