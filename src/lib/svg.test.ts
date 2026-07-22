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

  it('retains VTracer compound geometry and path-level translations', () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg" style="background:transparent">
      <g transform="scale(1)">
        <path
          d="M0 0 C2 0 4 2 4 4 Z M1 1 L1 3 L3 3 Z"
          transform="translate(12,18)"
          fill="#000000"
          fill-rule="evenodd"
          stroke="none"
        />
        <path d="M0 0 L100 0 L100 100 Z" fill="#ffffff" />
      </g>
    </svg>`

    const result = formatFlatSvg(raw, 100, 100, 50, 25)

    expect(result).toContain('M0 0 C2 0 4 2 4 4 Z M1 1 L1 3 L3 3 Z')
    expect(result).toContain('transform="translate(12,18)"')
    expect(result).toContain('fill-rule="evenodd"')
    expect(result).not.toContain('M0 0 L100 0')
    expect(result).not.toContain('<g')
    expect(result).not.toMatch(/\sstroke(?:-|=)/i)
  })

  it('rejects malformed roots and non-positive dimensions', () => {
    expect(() => formatFlatSvg('<path/>', 10, 10, 10, 10)).toThrow(/complete SVG root/)
    expect(() => formatFlatSvg('<svg></svg>', 0, 10, 10, 10)).toThrow(/positive finite/)
  })
})
