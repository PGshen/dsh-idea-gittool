// B4b T8: the WCAG maths of the L4 contrast probe.
import { describe, expect, it } from 'vitest'
import { contrastRatio, over, relativeLuminance } from '../../scripts/contrast-probe.mjs'

describe('contrast probe', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5)
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255])).toBeCloseTo(4.48, 2)
    expect(contrastRatio([255, 255, 255], [0x77, 0x77, 0x77])).toBeCloseTo(4.48, 2)
  })

  it('composites a translucent colour over the background', () => {
    expect(over([0, 0, 0, 0.5], [255, 255, 255])).toEqual([127.5, 127.5, 127.5])
  })
})
