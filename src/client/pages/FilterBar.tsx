// 日志筛选栏（设计 §8.1.2）：搜索（.* / Aa）、分支多选、用户多选、图选项、跳转、刷新。
// 纯展示组件：防抖与请求都在 log-store 里，这里只把输入翻译成 store 调用。
// 菜单用原生 <details>，不引入弹层依赖；已生效的条件在第二行显示成可移除的胶囊。
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import type { RefKind } from '../../shared/protocol.ts'
import { render, text, useT } from '../i18n.tsx'
import type { LocalizedText } from '../i18n.tsx'
import type { GitWorkbenchKey } from '../locales.ts'
import type { LogFilterState, LogOrder } from '../store/log-store.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import css from './FilterBar.module.css'

/** 原生 <details> 菜单的最小接口（便于无 DOM 测试）。 */
interface MenuLike {
  open: boolean
  contains(node: unknown): boolean
}

/** 找到包含 target 的菜单；不在任何菜单内时返回 null。 */
export function menuContaining<T extends MenuLike>(menus: Iterable<T>, target: unknown): T | null {
  for (const menu of menus) if (menu.contains(target)) return menu
  return null
}

/** 关闭 root 下所有展开的菜单（keep 除外），返回关闭数。<details> 本身不响应 Esc/外部点击。 */
export function closeOpenMenus(
  root: { querySelectorAll(selector: string): Iterable<MenuLike> },
  keep: MenuLike | null = null,
): number {
  let closed = 0
  for (const menu of root.querySelectorAll('details[open]')) {
    if (menu === keep || !menu.open) continue
    menu.open = false
    closed += 1
  }
  return closed
}

export interface BranchOption {
  /** 传给 Host `branches` 的名字（短名，如 `main` / `origin/main` / `v1`）。 */
  name: string
  kind: RefKind
}

export interface FilterChipItem {
  key: string
  label: LocalizedText
  /** 点 × 时应用的 patch。 */
  remove: Partial<LogFilterState>
}

/** 已生效筛选 → 胶囊（搜索词不在这里，它就在输入框里）。 */
export function filterChips(filter: LogFilterState): FilterChipItem[] {
  const chips: FilterChipItem[] = []
  for (const branch of filter.branches) {
    chips.push({
      key: `branch:${branch}`,
      label: text('filter.chip.branch', { name: branch }),
      remove: { branches: filter.branches.filter((value) => value !== branch) },
    })
  }
  for (const author of filter.authors) {
    chips.push({
      key: `author:${author}`,
      label: text('filter.chip.author', { name: author }),
      remove: { authors: filter.authors.filter((value) => value !== author) },
    })
  }
  if (filter.order === 'topo') chips.push({ key: 'order', label: text('filter.chip.topo'), remove: { order: 'date' } })
  if (filter.firstParent) chips.push({ key: 'firstParent', label: text('filter.firstParent'), remove: { firstParent: false } })
  if (filter.noMerges) chips.push({ key: 'noMerges', label: text('filter.noMerges'), remove: { noMerges: false } })
  return chips
}

/** 多选切换：在列表里就去掉，不在就追加（保持原顺序）。 */
export function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

/** 任何筛选（含搜索）在生效：决定空态文案是「没有匹配」还是「没有提交」。 */
export function hasActiveFilter(filter: LogFilterState): boolean {
  return filter.query.length > 0 || filterChips(filter).length > 0
}

const BRANCH_GROUPS: readonly { kind: RefKind; label: GitWorkbenchKey }[] = [
  { kind: 'local', label: 'filter.group.local' },
  { kind: 'remote', label: 'filter.group.remote' },
  { kind: 'tag', label: 'filter.group.tag' },
]

export interface FilterBarProps {
  /** 输入框原文（防抖生效前）。 */
  query: string
  filter: LogFilterState
  branchOptions: readonly BranchOption[]
  authorOptions: readonly string[]
  /** 跳转失败说明；显示在跳转框正下方。 */
  jumpError: LocalizedText | null
  searchRef?: Ref<HTMLInputElement>
  onQueryChange(raw: string): void
  /** Enter：立即应用。 */
  onQueryCommit(): void
  /** Esc：清空搜索（之后焦点回表格由 onLeave 处理）。 */
  onQueryClear(): void
  onFilterChange(patch: Partial<LogFilterState>): void
  /** 跳转；返回 false 时输入框显示红框。 */
  onJump(target: string): boolean
  /** 跳转框被编辑：清掉旧的错误。 */
  onJumpEdit(): void
  onRefresh?(): void
  /** Esc / Enter 后把焦点交回表格。 */
  onLeave?(): void
}

export function FilterBar({
  query,
  filter,
  branchOptions,
  authorOptions,
  jumpError,
  searchRef,
  onQueryChange,
  onQueryCommit,
  onQueryClear,
  onFilterChange,
  onJump,
  onJumpEdit,
  onRefresh,
  onLeave,
}: FilterBarProps): ReactNode {
  const t = useT()
  const [jump, setJump] = useState('')
  const chips = filterChips(filter)
  const barRef = useRef<HTMLDivElement>(null)
  const jumpErrorId = useId()

  // 菜单：点外部关闭、同时只开一个；Esc 关闭并把焦点还给 summary。
  useEffect(() => {
    const bar = barRef.current
    if (bar === null) return
    const onPointerDown = (event: PointerEvent): void => {
      closeOpenMenus(bar, menuContaining(bar.querySelectorAll('details'), event.target))
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const menu = menuContaining(bar.querySelectorAll<HTMLDetailsElement>('details[open]'), event.target)
      if (menu === null) return
      event.preventDefault()
      event.stopPropagation()
      menu.open = false
      menu.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    bar.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      bar.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      onQueryCommit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onQueryClear()
      onLeave?.()
    }
  }

  function onJumpKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (onJump(jump)) onLeave?.()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setJump('')
      onJumpEdit()
      onLeave?.()
    }
  }

  return (
    <div ref={barRef} className={css.bar} role="toolbar" aria-label={t('filter.toolbar')}>
      <div className={css.controls}>
        <div className={css.search}>
          <input
            ref={searchRef}
            className={css.searchInput}
            type="search"
            value={query}
            placeholder={t('filter.search.placeholder')}
            aria-label={t('filter.search.label')}
            spellCheck={false}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onSearchKey}
          />
          <button
            type="button"
            className={css.toggle}
            aria-pressed={filter.regex}
            title={t('filter.regex')}
            onClick={() => onFilterChange({ regex: !filter.regex })}
          >
            .*
          </button>
          <button
            type="button"
            className={css.toggle}
            aria-pressed={filter.caseSensitive}
            title={t('filter.caseSensitive')}
            onClick={() => onFilterChange({ caseSensitive: !filter.caseSensitive })}
          >
            Aa
          </button>
        </div>

        <details className={css.menu} data-menu="branches">
          <summary className={css.menuButton}>
            {t('filter.branches')}{filter.branches.length > 0 ? ` (${filter.branches.length})` : ''} ▾
          </summary>
          <div className={css.menuBody} role="group" aria-label={t('filter.branches.label')}>
            {branchOptions.length === 0 ? <span className={css.menuEmpty}>{t('filter.branches.empty')}</span> : null}
            {BRANCH_GROUPS.map(({ kind, label }) => {
              const options = branchOptions.filter((option) => option.kind === kind)
              if (options.length === 0) return null
              return (
                <fieldset key={kind} className={css.menuGroup}>
                  <legend className={css.menuLegend}>{t(label)}</legend>
                  {options.map((option) => (
                    <label key={`${kind}:${option.name}`} className={css.menuItem}>
                      <input
                        type="checkbox"
                        checked={filter.branches.includes(option.name)}
                        onChange={() => onFilterChange({ branches: toggleValue(filter.branches, option.name) })}
                      />
                      <span className={css.menuLabel}>{option.name}</span>
                    </label>
                  ))}
                </fieldset>
              )
            })}
          </div>
        </details>

        <details className={css.menu} data-menu="authors">
          <summary className={css.menuButton}>
            {t('filter.authors')}{filter.authors.length > 0 ? ` (${filter.authors.length})` : ''} ▾
          </summary>
          <div className={css.menuBody} role="group" aria-label={t('filter.authors.label')}>
            {authorOptions.length === 0 ? <span className={css.menuEmpty}>{t('filter.authors.empty')}</span> : null}
            {authorOptions.map((author) => (
              <label key={author} className={css.menuItem}>
                <input
                  type="checkbox"
                  checked={filter.authors.includes(author)}
                  onChange={() => onFilterChange({ authors: toggleValue(filter.authors, author) })}
                />
                <span className={css.menuLabel}>{author}</span>
              </label>
            ))}
          </div>
        </details>

        <details className={css.menu} data-menu="graph">
          <summary className={css.menuButton}>{t('filter.graph')} ▾</summary>
          <div className={css.menuBody} role="group" aria-label={t('filter.graph')}>
            {(['date', 'topo'] as const satisfies readonly LogOrder[]).map((order) => (
              <label key={order} className={css.menuItem}>
                <input
                  type="radio"
                  name="git-log-order"
                  checked={filter.order === order}
                  onChange={() => onFilterChange({ order })}
                />
                <span className={css.menuLabel}>{t(order === 'date' ? 'filter.order.date' : 'filter.order.topo')}</span>
              </label>
            ))}
            <label className={css.menuItem}>
              <input
                type="checkbox"
                checked={filter.firstParent}
                onChange={() => onFilterChange({ firstParent: !filter.firstParent })}
              />
              <span className={css.menuLabel}>{t('filter.firstParent')}</span>
            </label>
            <label className={css.menuItem}>
              <input
                type="checkbox"
                checked={filter.noMerges}
                onChange={() => onFilterChange({ noMerges: !filter.noMerges })}
              />
              <span className={css.menuLabel}>{t('filter.noMerges')}</span>
            </label>
          </div>
        </details>

        <div className={css.jumpField}>
          <input
            className={jumpError === null ? css.jump : `${css.jump} ${css.jumpInvalid}`}
            type="text"
            value={jump}
            placeholder={t('filter.jump.placeholder')}
            aria-label={t('filter.jump.label')}
            aria-invalid={jumpError !== null}
            aria-describedby={jumpError === null ? undefined : jumpErrorId}
            spellCheck={false}
            onChange={(event) => {
              setJump(event.target.value)
              if (jumpError !== null) onJumpEdit()
            }}
            onKeyDown={onJumpKey}
          />
          {/* 失败说明是可见文本（A1 验收：只放在 title 里看不到）。 */}
          {jumpError === null ? null : (
            <div id={jumpErrorId} className={css.jumpError} role="alert">{render(t, jumpError)}</div>
          )}
        </div>

        {onRefresh === undefined ? null : (
          <Button onClick={onRefresh} title={t('filter.refresh.title')}>{t('filter.refresh')}</Button>
        )}
      </div>

      {chips.length === 0 ? null : (
        <div className={css.chips} data-filter-chips="">
          {chips.map((chip) => (
            <Chip key={chip.key} kind="filter" title={t('filter.chip.remove', { label: render(t, chip.label) })} onClick={() => onFilterChange(chip.remove)}>
              {render(t, chip.label)} ×
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}
