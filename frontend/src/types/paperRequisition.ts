/**
 * 补纸领用（PaperRequisition）数据模型 —— 修复室侧账本
 * 修复师实际领用补纸按「册次 + 纸种」累计张数。
 * 与外单位送修单约定的张数比对：超出约定的部分挂「待补办」，
 * 待补办未清前不许并入验收；藏书单位改约追加张数（晚到为准）后自动解除。
 * 本室自管册次（无送修编号）领用不受约定限制。
 */
import type { PaperType } from '@/types/paper'

export interface PaperRequisition {
  id: string
  /** 领用的册次 id（修复室侧） */
  volumeId: string
  /** 纸种 */
  paperType: PaperType
  /** 累计领用张数 */
  usedSheets: number
  /** 最近领用日期 yyyy-MM-dd */
  date: string
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

export type PaperRequisitionDraft = Omit<PaperRequisition, 'id' | 'createdAt' | 'updatedAt'>

/** 一个册次同一纸种只有一条累计记录 */
export function paperRequisitionId(volumeId: string, paperType: PaperType): string {
  return `req_${volumeId}_${paperType}`
}

export function createEmptyRequisitionDraft(volumeId: string): PaperRequisitionDraft {
  return {
    volumeId,
    paperType: 'bamboo',
    usedSheets: 1,
    date: new Date().toISOString().slice(0, 10),
    note: ''
  }
}
