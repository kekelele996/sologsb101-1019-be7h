/**
 * 送修对账领域逻辑（纯函数，不触碰 IndexedDB）
 * 边界约定：
 * - 外单位侧（送修单）与修复室侧（册次 / 对认 / 领用）在这里做只读比对，不改任何一方数据；
 * - 改约晚到：同一（送修编号 + 册次号 + 纸种）取 receivedAt 最晚的一条为现行约定；
 * - 超领：某册某纸种实际领用超过约定张数的部分挂「待补办」，卡验收；
 * - 对上的册次以修复室册次号为准，外单位册次号对不上就是待认领。
 */
import type { Volume } from '@/types/volume'
import type { PaperType } from '@/types/paper'
import type { ConsignManifest } from '@/types/consignManifest'
import type { ConsignIntake } from '@/types/consignIntake'
import type { PaperRequisition } from '@/types/paperRequisition'
import { PAPER_TYPE_LABEL } from '@/types/paper'
import { consignVolumeKey } from '@/types/consignManifest'
import { consignIntakeId } from '@/types/consignIntake'

/** 现行约定行：同一（送修编号 + 册次号 + 纸种）以晚到一份为准 */
export interface EffectiveAgreement {
  consignNo: string
  volumeNo: number
  ownerUnit: string
  paperType: PaperType
  agreedSheets: number
  receivedAt: number
  remark: string
}

/**
 * 折叠全部已接收的送修单（初约 + 各次改约）为现行约定。
 * 同键 later.receivedAt >= earlier 即覆盖 —— 晚到那份为准，早到那份保留但不再生效。
 */
export function effectiveAgreements(manifests: ConsignManifest[]): EffectiveAgreement[] {
  const latest = new Map<string, ConsignManifest>()
  manifests.forEach((line) => {
    const key = consignVolumeKey(line.consignNo, line.volumeNo) + `__${line.paperType}`
    const prev = latest.get(key)
    if (!prev || line.receivedAt >= prev.receivedAt) latest.set(key, line)
  })
  return [...latest.values()].map((line) => ({
    consignNo: line.consignNo,
    volumeNo: line.volumeNo,
    ownerUnit: line.ownerUnit,
    paperType: line.paperType,
    agreedSheets: line.agreedSheets,
    receivedAt: line.receivedAt,
    remark: line.remark
  }))
}

/** 取某送修册（送修编号 + 册次号）的现行约定：纸种 → 约定张数 */
export function agreedSheetsFor(
  agreements: EffectiveAgreement[],
  consignNo: string,
  volumeNo: number
): Partial<Record<PaperType, number>> {
  const result: Partial<Record<PaperType, number>> = {}
  agreements
    .filter((item) => item.consignNo === consignNo && item.volumeNo === volumeNo)
    .forEach((item) => {
      result[item.paperType] = item.agreedSheets
    })
  return result
}

/** 某纸种的领用挂起结果 */
export interface PaperHolding {
  paperType: PaperType
  paperLabel: string
  usedSheets: number
  agreedSheets: number
  /** 约定外多领的张数：>0 即「待补办」，不许并入验收 */
  exceededSheets: number
  /** 是否待补办 */
  pendingSupplement: boolean
}

/**
 * 计算一个送修册的补纸领用挂起情况。
 * 未约定的纸种约定张数按 0 计（领一张也算超）；未领用的约定纸种不出现在结果里。
 */
export function paperHoldings(
  consignNo: string,
  volumeNo: number,
  requisitions: PaperRequisition[],
  agreements: EffectiveAgreement[]
): PaperHolding[] {
  const agreed = agreedSheetsFor(agreements, consignNo, volumeNo)
  return requisitions.map((req) => {
    const agreedSheets = agreed[req.paperType] ?? 0
    const exceededSheets = Math.max(0, req.usedSheets - agreedSheets)
    return {
      paperType: req.paperType,
      paperLabel: PAPER_TYPE_LABEL[req.paperType],
      usedSheets: req.usedSheets,
      agreedSheets,
      exceededSheets,
      pendingSupplement: exceededSheets > 0
    }
  })
}

/** 验收闸门结论 */
export interface AcceptanceBlock {
  blocked: boolean
  /** 不能验收的原因（待补办纸种明细 / 认不上），用于提示 */
  reasons: string[]
}

/**
 * 一册能否验收归档：
 * - 只有外单位送修册受约束（未挂送修标记的本室册次不拦）；
 * - 送修册必须已对上（在册次上），且没有超约定未补办的领用。
 */
export function acceptanceBlockForVolume(
  volume: Volume,
  requisitions: PaperRequisition[],
  agreements: EffectiveAgreement[],
  intakes: ConsignIntake[]
): AcceptanceBlock {
  if (!volume.consignNo) return { blocked: false, reasons: [] }
  const reasons: string[] = []

  const intake = intakes.find((item) => item.id === consignIntakeId(volume.consignNo as string, volume.volumeNo))
  if (!intake || intake.state !== 'matched' || intake.volumeId !== volume.id) {
    reasons.push(`送修编号 ${volume.consignNo} 第 ${volume.volumeNo} 册尚未对上，先到送修对账页认册`)
  }

  const holdings = paperHoldings(volume.consignNo, volume.volumeNo, requisitions, agreements)
  holdings
    .filter((item) => item.pendingSupplement)
    .forEach((item) => {
      reasons.push(
        `${item.paperLabel}领用 ${item.usedSheets} 张、约定 ${item.agreedSheets} 张，超领 ${item.exceededSheets} 张待补办`
      )
    })

  return { blocked: reasons.length > 0, reasons }
}

/** 待认领对认行的视图（送修对账页与导航徽标共用） */
export interface UnclaimedIntakeView {
  intake: ConsignIntake
  /** 该行现行约定（用于展示约定纸种张数与改约痕迹） */
  agreements: EffectiveAgreement[]
}

export function unclaimedIntakes(
  intakes: ConsignIntake[],
  manifests: ConsignManifest[]
): UnclaimedIntakeView[] {
  const agreements = effectiveAgreements(manifests)
  return intakes
    .filter((item) => item.state === 'unclaimed')
    .sort((a, b) => a.consignNo.localeCompare(b.consignNo) || a.volumeNo - b.volumeNo)
    .map((intake) => ({
      intake,
      agreements: agreements.filter(
        (line) => line.consignNo === intake.consignNo && line.volumeNo === intake.volumeNo
      )
    }))
}

export interface ReconcileResult {
  /** 应存在的对认行（由现行送修单键集合决定） */
  expected: Array<{ consignNo: string; volumeNo: number; ownerUnit: string }>
  /** 自动对上：本室存在挂同一送修编号且册次号相同的册次 */
  autoMatched: Array<{ consignNo: string; volumeNo: number; volumeId: string }>
}

/**
 * 预演对账：仅计算「应建对认行」与「可自动对上」的结果，不落库。
 * 对上的严格条件：送修编号相等 且 修复室册次号 === 外单位册次号。
 */
export function planReconcile(manifests: ConsignManifest[], volumes: Volume[]): ReconcileResult {
  const agreements = effectiveAgreements(manifests)
  const expectedMap = new Map<string, { consignNo: string; volumeNo: number; ownerUnit: string }>()
  agreements.forEach((line) => {
    expectedMap.set(consignVolumeKey(line.consignNo, line.volumeNo), {
      consignNo: line.consignNo,
      volumeNo: line.volumeNo,
      ownerUnit: line.ownerUnit
    })
  })

  const autoMatched: ReconcileResult['autoMatched'] = []
  expectedMap.forEach((item) => {
    const hit = volumes.find(
      (volume) => volume.consignNo === item.consignNo && volume.volumeNo === item.volumeNo
    )
    if (hit) autoMatched.push({ ...item, volumeId: hit.id })
  })

  return { expected: [...expectedMap.values()], autoMatched }
}
