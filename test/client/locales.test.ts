/**
 * T7 i18n gate: every visible client string lives in the `gitWorkbench` dictionaries.
 * - Static scan: no CJK text in string literals, template literals or JSX text of `src/client/**`
 *   (comments are trivia and never scanned); only the dictionary files may hold Chinese.
 * - Runtime: zh/en key sets match, no empty values, placeholders agree, en has no CJK.
 * - Interpolation follows the DSH locale service rule (`{name}`, unknown names kept).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../../src/client/locales.ts'
import { createTranslator, interpolate, render, text } from '../../src/client/localized-text.ts'

const CLIENT_ROOT = fileURLToPath(new URL('../../src/client', import.meta.url))
/** Dictionary files: the only place Chinese copy may live. */
const DICTIONARY_FILES = /^locales(\.ts$|\/)/
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

interface Finding { file: string; line: number; text: string }

/** CJK in code tokens that can reach the screen: string/template literals and JSX text. */
function scanForCjk(fileName: string, source: string): Omit<Finding, 'file'>[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const findings: Omit<Finding, 'file'>[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
      || ts.isJsxText(node)
    ) {
      if (CJK.test(node.text)) {
        findings.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text.trim() })
      }
    }
    node.forEachChild(visit)
  }
  visit(file)
  return findings
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
}

describe('static scan: no hard-coded Chinese in src/client', () => {
  it('only the dictionary files contain CJK outside comments', () => {
    const files = sourceFiles(CLIENT_ROOT)
    expect(files.length).toBeGreaterThan(40)
    const findings: Finding[] = []
    for (const path of files) {
      const file = relative(CLIENT_ROOT, path)
      if (DICTIONARY_FILES.test(file)) continue
      for (const finding of scanForCjk(path, readFileSync(path, 'utf8'))) findings.push({ file, ...finding })
    }
    expect(findings).toEqual([])
  })

  it('the scanner sees JSX text, attributes and template literals but ignores comments', () => {
    const source = [
      '// 注释里的中文不算',
      '/* 块注释 */',
      'const a = <div title="标题" aria-label={`标签${1}`}>正文</div>',
      "const b = '字符串'",
      'const c = `模板 ${a} 中间 ${b} 结尾`',
      'const ok = <span title="ok">fine</span>',
    ].join('\n')
    const texts = scanForCjk('probe.tsx', source).map(finding => finding.text)
    expect(texts).toEqual(['标题', '标签', '正文', '字符串', '模板', '中间', '结尾'])
  })
})

describe('dictionaries', () => {
  it('zh and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('every value is non-empty and en carries no Chinese', () => {
    for (const [key, value] of Object.entries(zh)) expect(value, key).not.toBe('')
    const chinese = Object.entries(en).filter(([, value]) => value === '' || CJK.test(value))
    expect(chinese).toEqual([])
  })

  it('zh and en use the same placeholders for every key', () => {
    const mismatched = Object.keys(zh).filter((key) => {
      const k = key as keyof typeof zh
      return placeholders(zh[k]).join(',') !== placeholders(en[k]).join(',')
    })
    expect(mismatched).toEqual([])
  })
})

describe('interpolation', () => {
  it('fills {name} placeholders and keeps unknown ones', () => {
    expect(interpolate('删除 {count} 个文件 {x}', { count: 3 })).toBe('删除 3 个文件 {x}')
    expect(interpolate('{a}{a}-{b}', { a: 1, b: 'z' })).toBe('11-z')
    expect(interpolate('no params')).toBe('no params')
  })

  it('does not read inherited properties as params', () => {
    expect(interpolate('{toString}', {})).toBe('{toString}')
  })

  it('translators and LocalizedText resolve per language', () => {
    const zhT = createTranslator(zh)
    const enT = createTranslator(en)
    const value = text('log.jump.notFound', { target: 'v9', count: 12 })
    expect(render(zhT, value)).toBe('已加载的 12 行中未找到「v9」')
    expect(render(enT, value)).toBe('"v9" was not found in the 12 loaded rows')
    expect(enT('status.changes', { count: '3+' })).toBe('3+ changed')
  })
})
