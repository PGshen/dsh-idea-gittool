// `gitWorkbench` 文案命名空间与键集：按页面拆在 locales/*.ts，这里合并。
// zh 是键的真源，en 用 satisfies 保证键一致（每个分区也各自校验）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { RepoOperation, WritePolicyReasonCode } from '../shared/protocol.ts'
import { enActions, zhActions } from './locales/actions.ts'
import { enBranch, zhBranch } from './locales/branch.ts'
import { enCommit, zhCommit } from './locales/commit.ts'
import { enCommon, zhCommon } from './locales/common.ts'
import { enConflict, zhConflict } from './locales/conflict.ts'
import { enCore, zhCore } from './locales/core.ts'
import { enDetail, zhDetail } from './locales/detail.ts'
import { enDiffMenu, zhDiffMenu } from './locales/diffmenu.ts'
import { enDocument, zhDocument } from './locales/document.ts'
import { enHistory, zhHistory } from './locales/history.ts'
import { enIntegrate, zhIntegrate } from './locales/integrate.ts'
import { enLog, zhLog } from './locales/log.ts'
import { enMerge, zhMerge } from './locales/merge.ts'
import { enPush, zhPush } from './locales/push.ts'
import { enRebase, zhRebase } from './locales/rebase.ts'
import { enShelf, zhShelf } from './locales/shelf.ts'
import { enRemotes, zhRemotes } from './locales/remotes.ts'
import { enShell, zhShell } from './locales/shell.ts'
import { enStash, zhStash } from './locales/stash.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git 工作台的全部可见文案。 */
    gitWorkbench: GitWorkbenchKey
  }
}

/** 简体中文文案。 */
export const zh = {
  ...zhCore,
  ...zhCommon,
  ...zhLog,
  ...zhDetail,
  ...zhShell,
  ...zhCommit,
  ...zhPush,
  ...zhDocument,
  ...zhActions,
  ...zhBranch,
  ...zhIntegrate,
  ...zhConflict,
  ...zhStash,
  ...zhMerge,
  ...zhHistory,
  ...zhRebase,
  ...zhDiffMenu,
  ...zhShelf,
  ...zhRemotes,
}

export type GitWorkbenchKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  ...enCore,
  ...enCommon,
  ...enLog,
  ...enDetail,
  ...enShell,
  ...enCommit,
  ...enPush,
  ...enDocument,
  ...enActions,
  ...enBranch,
  ...enIntegrate,
  ...enConflict,
  ...enStash,
  ...enMerge,
  ...enHistory,
  ...enRebase,
  ...enDiffMenu,
  ...enShelf,
  ...enRemotes,
} satisfies Record<GitWorkbenchKey, string>

/** In-progress repository operation → its display name. */
export const OPERATION_KEY: Record<Exclude<RepoOperation, null>, GitWorkbenchKey> = {
  merge: 'operation.merge',
  rebase: 'operation.rebase',
  'cherry-pick': 'operation.cherryPick',
  revert: 'operation.revert',
  bisect: 'operation.bisect',
}

/** Host read-only reason code → localized explanation. */
export const READ_ONLY_REASON_KEY: Record<WritePolicyReasonCode, GitWorkbenchKey> = {
  'policy-unavailable': 'readOnly.reason.policy-unavailable',
  'session-not-live': 'readOnly.reason.session-not-live',
  'resolve-failed': 'readOnly.reason.resolve-failed',
  'read-only-mode': 'readOnly.reason.read-only-mode',
  'repo-outside-workspace': 'readOnly.reason.repo-outside-workspace',
  'sandbox-unavailable': 'readOnly.reason.sandbox-unavailable',
  'confine-failed': 'readOnly.reason.confine-failed',
  'partial-enforcement': 'readOnly.reason.partial-enforcement',
  'not-a-repository': 'readOnly.reason.not-a-repository',
}
