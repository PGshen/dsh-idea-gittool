/* global document, getComputedStyle, Element */
// WCAG contrast probe for L4 walkthroughs (B4b T8). Not shipped. The pure part is unit-tested
// (test/scripts/contrast-probe.test.ts); to run it in the DSH page, paste this file with the
// `export ` keywords removed (see docs/runbooks/verification.md「对比度测量」), then call
// `probeContrast([{ name, selector, fg: 'color' | 'stroke' | 'fill' | 'outline-color', min }])`.

/** sRGB channel 0–255 → linear light. */
function linear(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2 relative luminance of an opaque sRGB colour [r, g, b] (0–255). */
export function relativeLuminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2 contrast ratio between two opaque colours, 1–21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Composite a translucent colour [r, g, b, a(0–1)] over an opaque background. */
export function over([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
}

/** Any CSS colour (oklab(), color-mix() results, rgb()) → [r, g, b, a] via a 1×1 canvas. */
export function toRgba(css) {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b, a / 255]
}

/** The opaque background behind `element`: composites ancestor backgrounds up to the page. */
export function effectiveBackground(element) {
  const layers = []
  for (let node = element; node instanceof Element; node = node.parentElement) {
    const rgba = toRgba(getComputedStyle(node).backgroundColor)
    if (rgba[3] > 0) layers.push(rgba)
    if (rgba[3] >= 1) break
  }
  let base = [255, 255, 255]
  for (const layer of layers.reverse()) base = over(layer, base)
  return base
}

/** Measure each target's first match; returns rows for the verification table. */
export function probeContrast(targets) {
  return targets.map(({ name, selector, fg = 'color', min }) => {
    const element = document.querySelector(selector)
    if (element === null) return { name, missing: true }
    const background = effectiveBackground(element)
    const colour = over(toRgba(getComputedStyle(element).getPropertyValue(fg)), background)
    const ratio = Math.round(contrastRatio(colour, background) * 100) / 100
    return { name, ratio, min, pass: ratio >= min }
  })
}
