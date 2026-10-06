/**
 * useConsignOverview()：送修对账页 / 验收页共用的派生视图
 * 组合外单位送修单（现行约定）、修复室对认记录与本室册次，产出可直接渲染的行视图。
 * 纯读取、纯派生，不写任何一方数据。
 */
import { computed, type ComputedRef } from 'vue'
import { useBookStore } from '@/stores/bookStore'
import { useConsignStore } from '@/stores/consignStore'
import { PAPER_TYPE_LABEL } from '@/types/paper'
import type { PaperType } from '@/types/paper'
import type { ConsignIntake } from '@/types/consignIntake'
import type { EffectiveAgreement } from '@/utils/consign'
import {
  acceptanceBlockForVolume,
  agreedSheetsFor,
  effectiveAgreements,
  paperHoldings,
  unclaimedIntakes,
  type AcceptanceBlock,
  type PaperHolding
} from '@/utils/consign'

export interface ConsignRowView {
  intake: ConsignIntake
  ownerUnit: string
  agreements: EffectiveAgreement[]
  agreementText: string
  volumeId: string | null
  volumeLabel: string
  holdings: PaperHolding[]
  /** 该册是否有待补办（超约定）的领用 */
  hasPendingSupplement: boolean
  /** 验收闸门结论（已对上的册次才有意义） */
  acceptance: AcceptanceBlock | null
}

export interface ConsignOverview {
  rows: ComputedRef<ConsignRowView[]>
  unclaimed: ComputedRef<ReturnType<typeof unclaimedIntakes>>
  matchedCount: ComputedRef<number>
  unclaimedCount: ComputedRef<number>
  pendingSupplementCount: ComputedRef<number>
  /** 给定册次的验收闸门（验收页调用） */
  blockOfVolume: (volumeId: string) => AcceptanceBlock
  holdingsOfVolume: (volumeId: string) => PaperHolding[]
  agreementsTextOf: (consignNo: string, volumeNo: number) => string
}

function formatAgreements(list: EffectiveAgreement[]): string {
  if (list.length === 0) return '（无约定行，可能送修单缺失）'
  return list
    .slice()
    .sort((a, b) => a.paperType.localeCompare(b.paperType))
    .map((item) => `${PAPER_TYPE_LABEL[item.paperType]} ${item.agreedSheets} 张`)
    .join(' · ')
}

export function useConsignOverview(): ConsignOverview {
  const bookStore = useBookStore()
  const consignStore = useConsignStore()

  const allAgreements = computed(() => effectiveAgreements(consignStore.manifests))

  function volumeLabelOf(volumeId: string | null): string {
    if (!volumeId) return ''
    const volume = bookStore.volumeById(volumeId)
    if (!volume) return '册次已删除'
    const book = bookStore.bookById(volume.bookId)
    return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
  }

  const rows = computed<ConsignRowView[]>(() =>
    consignStore.intakes.map((intake) => {
      const agreements = allAgreements.value.filter(
        (line) => line.consignNo === intake.consignNo && line.volumeNo === intake.volumeNo
      )
      const requisitions = intake.volumeId
        ? consignStore.requisitionsOfVolume(intake.volumeId)
        : []
      const holdings = paperHoldings(intake.consignNo, intake.volumeNo, requisitions, allAgreements.value)
      const volume = intake.volumeId ? bookStore.volumeById(intake.volumeId) : undefined
      const acceptance =
        intake.state === 'matched' && volume
          ? acceptanceBlockForVolume(volume, requisitions, allAgreements.value, consignStore.intakes)
          : null
      return {
        intake,
        ownerUnit: intake.ownerUnit,
        agreements,
        agreementText: formatAgreements(agreements),
        volumeId: intake.volumeId,
        volumeLabel: volumeLabelOf(intake.volumeId),
        holdings,
        hasPendingSupplement: holdings.some((item) => item.pendingSupplement),
        acceptance
      }
    })
  )

  const unclaimed = computed(() => unclaimedIntakes(consignStore.intakes, consignStore.manifests))

  const matchedCount = computed(
    () => consignStore.intakes.filter((item) => item.state === 'matched').length
  )
  const unclaimedCount = computed(() => unclaimed.value.length)
  const pendingSupplementCount = computed(
    () => rows.value.filter((row) => row.hasPendingSupplement).length
  )

  function blockOfVolume(volumeId: string): AcceptanceBlock {
    const volume = bookStore.volumeById(volumeId)
    if (!volume || !volume.consignNo) return { blocked: false, reasons: [] }
    return acceptanceBlockForVolume(
      volume,
      consignStore.requisitionsOfVolume(volumeId),
      allAgreements.value,
      consignStore.intakes
    )
  }

  function holdingsOfVolume(volumeId: string): PaperHolding[] {
    const volume = bookStore.volumeById(volumeId)
    if (!volume || !volume.consignNo) return []
    return paperHoldings(
      volume.consignNo,
      volume.volumeNo,
      consignStore.requisitionsOfVolume(volumeId),
      allAgreements.value
    )
  }

  function agreementsTextOf(consignNo: string, volumeNo: number): string {
    const agreed: Partial<Record<PaperType, number>> = agreedSheetsFor(
      allAgreements.value,
      consignNo,
      volumeNo
    )
    const list: EffectiveAgreement[] = (Object.keys(agreed) as PaperType[]).map((paperType) => ({
      consignNo,
      volumeNo,
      ownerUnit: '',
      paperType,
      agreedSheets: agreed[paperType] ?? 0,
      receivedAt: 0,
      remark: ''
    }))
    return formatAgreements(list)
  }

  return {
    rows,
    unclaimed,
    matchedCount,
    unclaimedCount,
    pendingSupplementCount,
    blockOfVolume,
    holdingsOfVolume,
    agreementsTextOf
  }
}

export default useConsignOverview
