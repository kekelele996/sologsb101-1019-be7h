/**
 * 送修单（Consignment）数据模型 —— 藏书单位侧上下文
 * 藏书单位记录「送修编号、册次号、约定补纸纸种与张数」；
 * 修复室只负责接收与对账：既不改写送修单内容，也不回写对方系统。
 *
 * 同一（送修编号 + 册次号）的初约 / 改约批次全部留痕（append-only），
 * 当前有效约定以「晚到那份」（receivedAt 最大的一行）为准。
 *
 * 认不上的送修行不强行挂册，先挂「待认领」。
 */
import type { PaperType } from './paper'

/** 一笔补纸约定：纸种 + 张数 */
export interface PaperAllowance {
  paperType: PaperType
  agreedSheets: number
}

/** 批次性质：初约 / 改约 */
export type ConsignRevisionKind = 'initial' | 'amendment'

export interface ConsignmentLine {
  /** 行主键：由藏书单位生成；同一批次重发保持同 id，接收侧据此幂等去重 */
  id: string
  /** 送修编号（藏书单位编号，对账主键之一） */
  sendNo: string
  /** 册次号（对账主键之二） */
  volumeNo: number
  /** 藏书单位名称 */
  ownerUnit: string
  /** 批次性质：初约 / 改约 */
  revision: ConsignRevisionKind
  /** 批次序号，从 1 开始；2 及以上为改约 */
  revisionSeq: number
  /** 修复室收到该批次的时刻；同键晚到者为准 */
  receivedAt: number
  /** 约定补纸清单 */
  paperAllowances: PaperAllowance[]
  /** 来件备注，如「第 2 批改约：竹纸追加」 */
  note: string
  createdAt: number
  updatedAt: number
}

/**
 * 本侧对账关系（ConsignLink）—— 修复室侧数据
 * 送修编号 + 册次号 与本侧册次一一对应；挂上即给册次打「送修」标记。
 * 取消对账只删本侧关系，送修单原样保留，该行重新回到「待认领」。
 */
export interface ConsignLink {
  id: string
  /** 送修编号 */
  sendNo: string
  /** 送修单上的册次号 */
  volumeNo: number
  /** 修复室本侧册次 id */
  volumeId: string
  /** 挂上对账的时刻 */
  linkedAt: number
  createdAt: number
  updatedAt: number
}

/** 对账键：送修编号 + 册次号 */
export function consignKey(sendNo: string, volumeNo: number): string {
  return `${sendNo.trim()}#${volumeNo}`
}

/** 送修行对账状态：待认领 / 已对上 */
export type ConsignLineStatus = 'pending_claim' | 'matched'

export const CONSIGN_REVISION_LABEL: Record<ConsignRevisionKind, string> = {
  initial: '初约',
  amendment: '改约'
}

export const CONSIGN_REVISION_COLOR: Record<ConsignRevisionKind, string> = {
  initial: '#8c8c8c',
  amendment: '#a8623a'
}

export const CONSIGN_LINE_STATUS_LABEL: Record<ConsignLineStatus, string> = {
  pending_claim: '待认领',
  matched: '已对上'
}

export const CONSIGN_LINE_STATUS_COLOR: Record<ConsignLineStatus, string> = {
  pending_claim: '#b03a2e',
  matched: '#1e8449'
}

/** 送修批次在表格中的简要文案：竹纸×20 / 宣纸×5 */
export function formatAllowances(allowances: PaperAllowance[], typeLabel: Record<PaperType, string>): string {
  if (allowances.length === 0) return '未约定补纸'
  return allowances.map((item) => `${typeLabel[item.paperType]}×${item.agreedSheets}`).join(' / ')
}

/** 手工登记「收到的批次」用草稿 */
export interface ConsignLineDraft {
  sendNo: string
  volumeNo: number
  ownerUnit: string
  revisionSeq: number
  paperAllowances: PaperAllowance[]
  note: string
}

export function createEmptyConsignLineDraft(): ConsignLineDraft {
  return {
    sendNo: '',
    volumeNo: 1,
    ownerUnit: '',
    revisionSeq: 1,
    paperAllowances: [{ paperType: 'bamboo', agreedSheets: 0 }],
    note: ''
  }
}

/** 批次序号推导批次性质 */
export function revisionKindOf(seq: number): ConsignRevisionKind {
  return seq >= 2 ? 'amendment' : 'initial'
}
