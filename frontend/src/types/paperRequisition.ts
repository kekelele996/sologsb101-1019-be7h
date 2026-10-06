/**
 * 补纸领用（PaperRequisition）数据模型 —— 修复室侧台账
 * 修复师实际领用补纸时登记，逐行对照送修约定：
 * - 在约定张数内的部分 → in_quota（正常领用，不影响验收）
 * - 超出约定的那部分  → pending_supplement（先挂起待补办，不许并进验收）
 * - 改约后约定张数增加、超额消失后，可对挂起记录「补办入账」→ supplemented
 *
 * 约定之外的纸种（约定里没有该纸种）按约定 0 张处理，全部视为超额。
 * 非送修册不做约定校验：一律 in_quota，pendingSheets 为 0。
 */
import type { PaperType } from './paper'

/** 领用状态：正常 / 挂起待补办 / 已补办入账 */
export type RequisitionState = 'in_quota' | 'pending_supplement' | 'supplemented'

export interface PaperRequisition {
  id: string
  /** 领用时所属册次 id（书叶维度的领用统一按册汇总张数） */
  volumeId: string
  /** 关联书叶 id（领用用途，可空） */
  leafId: string
  /** 领用纸种 */
  paperType: PaperType
  /** 本次领用总张数 */
  usedSheets: number
  /** 其中在约定张数内的部分 */
  inQuotaSheets: number
  /** 其中超出约定、挂起待补办的部分 */
  pendingSheets: number
  /** 落账时依据的有效约定批次行 id；非送修册为空 */
  basisLineId: string
  /** 落账时依据的约定张数；非送修册为空 */
  basisAgreedSheets: number | null
  /** 当前状态 */
  state: RequisitionState
  /** 领用人 */
  operator: string
  /** 日期 yyyy-MM-dd */
  date: string
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

export type PaperRequisitionDraft = Omit<PaperRequisition, 'id' | 'createdAt' | 'updatedAt'>

export const REQUISITION_STATE_LABEL: Record<RequisitionState, string> = {
  in_quota: '正常领用',
  pending_supplement: '挂起待补办',
  supplemented: '已补办入账'
}

export const REQUISITION_STATE_COLOR: Record<RequisitionState, string> = {
  in_quota: '#1e8449',
  pending_supplement: '#b03a2e',
  supplemented: '#3a6ea5'
}

export const REQUISITION_STATE_OPTIONS: ReadonlyArray<{ value: RequisitionState; label: string }> = [
  { value: 'in_quota', label: '正常领用' },
  { value: 'pending_supplement', label: '挂起待补办' },
  { value: 'supplemented', label: '已补办入账' }
]

export function createEmptyRequisitionDraft(volumeId: string): PaperRequisitionDraft {
  return {
    volumeId,
    leafId: '',
    paperType: 'bamboo',
    usedSheets: 1,
    inQuotaSheets: 0,
    pendingSheets: 0,
    basisLineId: '',
    basisAgreedSheets: null,
    state: 'in_quota',
    operator: '',
    date: new Date().toISOString().slice(0, 10),
    note: ''
  }
}
