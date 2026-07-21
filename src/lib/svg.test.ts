import { describe, expect, it } from 'vitest'
import { formatFlatSvg } from './svg'

describe('formatFlatSvg', () => {
  it('sets physical dimensions independently from the source aspect ratio', () => {
    const raw = `<svg width="100" height="100">
      <path fill="rgb(255,255,255)" stroke="rgb(255,255,255)" d="M 0 0 L 100 0 L 100 100 Z"></path>
      <path fill="rgb(0,0,0)" stroke="rgb(0,0,0)" stroke-width="1" d="M 2 3 L 4 5 Z"></path>
    </svg>`

    const result = formatFlatSvg(raw, 100, 100, Math.PI * 10, 40)

    expect(result).toContain('width="31.415927mm"')
    expect(result).toContain('height="40mm"')
    expect(result).toContain('viewBox="0 0 100 100"')
    expect(result).toContain('preserveAspectRatio="none"')
    expect(result).toContain('d="M 2 3 L 4 5 Z"')
    expect(result).not.toContain('M 0 0 L 100 0')
    expect(result).not.toMatch(/\sstroke(?:-|=)/i)
  })

  it('removes style-based white fills and stroke declarations', () => {
    const raw = `<svg><path style='fill: white; stroke: #fff' d='background'/><path style='fill:#000;stroke-linecap:round;opacity:1' d='design'/></svg>`

    const result = formatFlatSvg(raw, 20, 10, 40, 25)

    expect(result).not.toContain('background')
    expect(result).toContain("d='design'")
    expect(result).toContain("style='fill:#000;opacity:1'")
    expect(result).not.toContain('stroke')
  })

  it('rejects malformed roots and non-positive dimensions', () => {
    expect(() => formatFlatSvg('<path/>', 10, 10, 10, 10)).toThrow(/complete SVG root/)
    expect(() => formatFlatSvg('<svg></svg>', 0, 10, 10, 10)).toThrow(/positive finite/)
  })
})
