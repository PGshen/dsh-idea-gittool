// Settings sheet (design §13, plan B4a T2): every viewer preference of the workbench, applied on change.
// Values live in localStorage (settings.ts); other mounted views follow through useSettings().
import { useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { useT } from '../i18n.tsx'
import type { Translate } from '../i18n.tsx'
import {
  LANGUAGES,
  LOG_PAGE_SIZES,
  REFRESH_INTERVAL_MAX_SEC,
  REFRESH_INTERVAL_MIN_SEC,
  resetSettings,
  useSettings,
  writeSettings,
} from '../settings.ts'
import type { WorkbenchSettings } from '../settings.ts'
import type { GitExecutableInfo } from '../../shared/protocol.ts'
import { GitPathField } from '../git-missing.tsx'
import { LANGUAGE_NATIVE_NAMES } from '../locales/settings.ts'
import { Button } from '../ui/Button.tsx'
import { SheetFrame, escapeHandler, useInitialFocus } from './integrate-parts.tsx'
import css from './SettingsSheet.module.css'

type SwitchName = 'autoRefresh' | 'compact' | 'autoOpenConflicts' | 'mergeAutoApplyNonConflicting' | 'blameRenderer'
type ChoiceName = 'language' | 'refreshIntervalSec' | 'diffMode' | 'logPageSize' | 'afterCommit' | 'dateFormat'
export type SettingControl = SwitchName | ChoiceName

const CHOICES: Readonly<Record<ChoiceName, readonly string[]>> = {
  language: LANGUAGES,
  refreshIntervalSec: Array.from({ length: REFRESH_INTERVAL_MAX_SEC - REFRESH_INTERVAL_MIN_SEC + 1 }, (_, i) => String(REFRESH_INTERVAL_MIN_SEC + i)),
  diffMode: ['unified', 'split'],
  logPageSize: LOG_PAGE_SIZES.map(String),
  afterCommit: ['stay', 'log'],
  dateFormat: ['absolute', 'relative'],
}

const SWITCHES: readonly SwitchName[] = ['autoRefresh', 'compact', 'autoOpenConflicts', 'mergeAutoApplyNonConflicting', 'blameRenderer']

/** A control's DOM value → a typed patch; values outside the allowed set give `{}`. */
export function settingsPatchFor(name: SettingControl, value: string | boolean): Partial<WorkbenchSettings> {
  if ((SWITCHES as readonly string[]).includes(name)) return typeof value === 'boolean' ? { [name]: value } : {}
  if (typeof value !== 'string' || !CHOICES[name as ChoiceName].includes(value)) return {}
  if (name === 'refreshIntervalSec' || name === 'logPageSize') return { [name]: Number(value) } as Partial<WorkbenchSettings>
  return { [name]: value } as Partial<WorkbenchSettings>
}

export interface SettingsSheetViewProps {
  t: Translate
  settings: WorkbenchSettings
  rootRef?: Ref<HTMLDivElement>
  onChange: (patch: Partial<WorkbenchSettings>) => void
  onReset: () => void
  onClose: () => void
  /** B4d: the git the Host runs (bootstrap `git`). */
  git?: GitExecutableInfo | undefined
  gitPathBusy?: boolean
  gitPathError?: string | null
  /** t2 T5: bootstrap `writePolicy.reasonCode === 'read-only-mode'`; the Host would refuse a path. */
  gitPathReadOnly?: boolean
  onGitPath?: (path: string) => void
}

export function SettingsSheetView({
  t,
  settings,
  rootRef,
  onChange,
  onReset,
  onClose,
  git,
  gitPathBusy = false,
  gitPathError = null,
  gitPathReadOnly = false,
  onGitPath,
}: SettingsSheetViewProps): ReactNode {
  // The stored path is not what the Host runs (Host restarted, or the path stopped validating).
  const gitPathInactive = settings.gitPath !== null && git !== undefined && git.source !== 'setting'
  const change = (name: SettingControl, value: string | boolean): void => {
    const patch = settingsPatchFor(name, value)
    if (Object.keys(patch).length > 0) onChange(patch)
  }

  const toggle = (name: SwitchName, label: string, hint?: string, autofocus = false): ReactNode => (
    <div className={css.row}>
      <label className={css.switchRow}>
        <input
          type="checkbox"
          role="switch"
          checked={settings[name]}
          data-setting={name}
          {...(autofocus ? { 'data-autofocus': '' } : {})}
          onChange={event => change(name, event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint === undefined ? null : <p className={css.hint}>{hint}</p>}
    </div>
  )

  const choice = (name: ChoiceName, label: string, optionLabel: (value: string) => string, options: { disabled?: boolean; hint?: string } = {}): ReactNode => (
    <div className={css.row}>
      <label className={css.choiceRow}>
        <span className={css.label}>{label}</span>
        <select
          className={css.select}
          value={String(settings[name])}
          disabled={options.disabled === true}
          data-setting={name}
          onChange={event => change(name, event.target.value)}
        >
          {CHOICES[name].map(value => <option key={value} value={value}>{optionLabel(value)}</option>)}
        </select>
      </label>
      {options.hint === undefined ? null : <p className={css.hint}>{options.hint}</p>}
    </div>
  )

  const title = t('settings.title')
  return (
    <SheetFrame dataKind="settings" title={title} label={title} rootRef={rootRef} onCancel={onClose} onKeyDown={escapeHandler(false, onClose)}>
      <div className={css.body}>
        <section className={css.group}>
          {choice('language', t('settings.language'), value => (value === 'zh' || value === 'en' ? LANGUAGE_NATIVE_NAMES[value] : t('settings.language.auto')))}
          {toggle('autoRefresh', t('settings.autoRefresh'), undefined, true)}
          {choice('refreshIntervalSec', t('settings.refreshInterval'), value => t('settings.seconds', { n: value }), { disabled: !settings.autoRefresh })}
        </section>
        <section className={css.group}>
          {choice('logPageSize', t('settings.logPageSize'), value => value)}
          {choice('dateFormat', t('settings.dateFormat'), value => t(value === 'relative' ? 'settings.dateFormat.relative' : 'settings.dateFormat.absolute'))}
          {toggle('compact', t('settings.compact'), t('settings.compact.hint'))}
          {choice('diffMode', t('settings.diffMode'), value => t(value === 'split' ? 'settings.diffMode.split' : 'settings.diffMode.unified'), { hint: t('settings.diffMode.hint') })}
        </section>
        <section className={css.group}>
          {choice('afterCommit', t('settings.afterCommit'), value => t(value === 'log' ? 'settings.afterCommit.log' : 'settings.afterCommit.stay'))}
          {toggle('autoOpenConflicts', t('settings.autoOpenConflicts'))}
          {toggle('mergeAutoApplyNonConflicting', t('settings.mergeAutoApply'), t('settings.mergeAutoApply.hint'))}
          <div className={css.row} data-setting-readonly="confirmDestructive">
            <div className={css.choiceRow}>
              <span className={css.label}>{t('settings.confirmDestructive')}</span>
              <span className={css.readonly}>{t('settings.confirmDestructive.value')}</span>
            </div>
          </div>
        </section>
        <section className={css.group}>
          {toggle('blameRenderer', t('settings.blameRenderer'), t('settings.blameRenderer.hint'))}
        </section>
        <section className={css.group}>
          <div className={css.row}>
            <span className={css.label}>{t('settings.gitPath')}</span>
            <GitPathField value={settings.gitPath} busy={gitPathBusy} error={gitPathError} disabled={gitPathReadOnly} onApply={path => onGitPath?.(path)} />
            {gitPathReadOnly ? <p className={css.hint} data-git-path-read-only="">{t('git.path.readOnly')}</p> : null}
            {git === undefined ? null : (
              <p className={css.hint}>
                {t('settings.gitPath.current', {
                  path: git.path,
                  version: git.version,
                  source: t(git.source === 'setting' ? 'settings.gitPath.source.setting' : 'settings.gitPath.source.path'),
                })}
              </p>
            )}
            {gitPathInactive ? <p className={css.hint} data-git-path-inactive="">{t('settings.gitPath.inactive')}</p> : null}
            <p className={css.hint}>{t('settings.gitPath.hint')}</p>
          </div>
        </section>
        <p className={css.hint}>{t('settings.storageNote')}</p>
      </div>
      <footer className={css.footer}>
        <Button onClick={onReset} data-settings-reset="">{t('settings.reset')}</Button>
        <Button tone="primary" onClick={onClose} data-primary="">{t('settings.done')}</Button>
      </footer>
    </SheetFrame>
  )
}

export interface SettingsSheetProps {
  onClose: () => void
  git?: GitExecutableInfo | undefined
  gitPathReadOnly?: boolean
  /** B4d: hand a path to the Host; resolves to the rejection text, or null once adopted. */
  onGitPath?: (path: string) => Promise<string | null>
}

export function SettingsSheet({ onClose, git, gitPathReadOnly = false, onGitPath }: SettingsSheetProps): ReactNode {
  const t = useT()
  const settings = useSettings()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [gitPathBusy, setGitPathBusy] = useState(false)
  const [gitPathError, setGitPathError] = useState<string | null>(null)
  useInitialFocus(rootRef)
  return (
    <SettingsSheetView
      t={t}
      settings={settings}
      rootRef={rootRef}
      onChange={(patch) => { writeSettings(patch) }}
      onReset={() => { resetSettings() }}
      onClose={onClose}
      git={git}
      gitPathBusy={gitPathBusy}
      gitPathError={gitPathError}
      gitPathReadOnly={gitPathReadOnly}
      onGitPath={onGitPath === undefined ? undefined : (path) => {
        setGitPathBusy(true)
        void onGitPath(path).then((error) => {
          setGitPathError(error)
          setGitPathBusy(false)
        })
      }}
    />
  )
}
