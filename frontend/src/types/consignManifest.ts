/**
 * 送修单（ConsignManifest）数据模型 —— 外单位（藏书单位）侧账本
 * 外单位只登记：送修编号、册次号、约定的补纸纸种与张数。
 * 修复室不登记也不修改这些记录：送修单只允许追加（接收 / 改约），
 * 同一（送修编号 + 册次号 + 纸种）以 receivedAt 最晚的一份为准（晚到改约覆盖早到）。
 */
import type { PaperType } from '@/types/paper'

/** 一条送修约定：某送修编号下某册次约定的某一纸种张数 */
export interface ConsignManifest {
  id: string
  /** 送修编号（外单位登记，对账主键之一） */
  consignNo: string
  /** 册次号（外单位登记，对账主键之二） */
  volumeNo: number
  /** 送修单位 */
  ownerUnit: string
  /** 约定补纸纸种 */
  paperType: PaperType
  /** 约定张数 */
  agreedSheets: number
  /** 单据到达修复室的时间（ms）；改约以晚到那份为准 */
  receivedAt: number
  /** 批次说明，如「初约」「第一次改约」 */
  remark: string
  createdAt: number
  updatedAt: number
}

export type ConsignManifestDraft = Omit<ConsignManifest, 'id' | 'createdAt' | 'updatedAt'>

/** 接收送修单时录入的一行（receivedAt 缺省按到达时刻计） */
export type ConsignManifestInput = Omit<ConsignManifestDraft, 'receivedAt'> & {
  receivedAt?: number
}

/** 送修单行主键：同一纸种每次到达各占一条（追加不改旧），故含 receivedAt */
export function manifestLineId(
  consignNo: string,
  volumeNo: number,
  paperType: PaperType,
  receivedAt: number
): string {
  return `cmf_${consignNo}_v${volumeNo}_${paperType}_${receivedAt}`
}

/** 对账键：送修编号 + 册次号 */
export function consignVolumeKey(consignNo: string, volumeNo: number): string {
  return `${consignNo}__v${volumeNo}`
}
