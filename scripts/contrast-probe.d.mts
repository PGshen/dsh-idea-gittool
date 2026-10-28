// Types for the walkthrough script scripts/contrast-probe.mjs (B4b T8).
export type Rgb = readonly [number, number, number]
export type Rgba = readonly [number, number, number, number]
export function relativeLuminance(rgb: Rgb): number
export function contrastRatio(a: Rgb, b: Rgb): number
export function over(colour: Rgba, background: Rgb): [number, number, number]
export function toRgba(css: string): [number, number, number, number]
export function effectiveBackground(element: Element): [number, number, number]
export interface ProbeTarget { name: string; selector: string; fg?: string; min: number }
export type ProbeRow = { name: string; missing: true } | { name: string; ratio: number; min: number; pass: boolean }
export function probeContrast(targets: readonly ProbeTarget[]): ProbeRow[]
