// B2 终审 I4：历史 / 比较 / Blame 列表的键盘判定。
import { describe, expect, it } from 'vitest'
import { listKeyAction, stepListIndex } from '../../../src/client/pages/list-keys.ts'

const key = (name: string, shiftKey = false) => ({ key: name, shiftKey })

describe('listKeyAction', () => {
  it('maps arrows, Home/End, Enter and the context menu keys', () => {
    expect(listKeyAction(key('ArrowDown'))).toBe('next')
    expect(listKeyAction(key('ArrowUp'))).toBe('previous')
    expect(listKeyAction(key('Home'))).toBe('first')
    expect(listKeyAction(key('End'))).toBe('last')
    expect(listKeyAction(key('Enter'))).toBe('activate')
    expect(listKeyAction(key('ContextMenu'))).toBe('menu')
    expect(listKeyAction(key('F10', true))).toBe('menu')
    expect(listKeyAction(key('F10'))).toBeNull()
    expect(listKeyAction(key('a'))).toBeNull()
  })
})

describe('stepListIndex', () => {
  it('starts at the ends and clamps', () => {
    expect(stepListIndex(3, -1, 'next')).toBe(0)
    expect(stepListIndex(3, -1, 'previous')).toBe(2)
    expect(stepListIndex(3, 2, 'next')).toBe(2)
    expect(stepListIndex(3, 0, 'previous')).toBe(0)
    expect(stepListIndex(3, 1, 'first')).toBe(0)
    expect(stepListIndex(3, 1, 'last')).toBe(2)
    expect(stepListIndex(0, -1, 'next')).toBe(-1)
  })
})
