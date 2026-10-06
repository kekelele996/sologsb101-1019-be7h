/**
 * 送修对账 store（Pinia setup store）
 * 两个限界上下文在这里严格分开写：
 * - ingestBatch：接收 / 改约送修单，只 bulkPut consignManifests（对方账本，追加幂等），
 *   不碰修复室任何表，更不改已做完的工序；
 * - reconcile / claim / unclaim / saveRequisition：修复室侧写操作，统一走 withStudioRetry，
 *   写库失败只重试本侧几张表，送修单原样不动。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, withStudioRetry } from '@/utils/db'
import type { ConsignManifest, ConsignManifestInput } from '@/types/consignManifest'
import { manifestLineId } from '@/types/consignManifest'
import {
  consignIntakeId,
  type ConsignIntake,
  type ConsignIntakeDraft
} from '@/types/consignIntake'
import {
  paperRequisitionId,
  type PaperRequisition,
  type PaperRequisitionDraft
} from '@/types/paperRequisition'
import type { Volume } from '@/types/volume'
import {
  effectiveAgreements,
  planReconcile
} from '@/utils/consign'

export const useConsignStore = defineStore('consign', () => {
  /** 外单位送修单（只读账本，按到达时间排序） */
  const manifests = ref<ConsignManifest[]>([])
  /** 修复室对认记录 */
  const intakes = ref<ConsignIntake[]>([])
  /** 修复室补纸领用 */
  const requisitions = ref<PaperRequisition[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [manifestRows, intakeRows, requisitionRows] = await Promise.all([
        db.consignManifests.toArray(),
        db.consignIntakes.toArray(),
        db.paperRequisitions.toArray()
      ])
      manifestRows.sort((a, b) => a.receivedAt - b.receivedAt)
      intakeRows.sort((a, b) => a.consignNo.localeCompare(b.consignNo) || a.volumeNo - b.volumeNo)
      manifests.value = manifestRows
      intakes.value = intakeRows
      requisitions.value = requisitionRows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '送修数据读取失败'
    } finally {
      loading.value = false
    }
  }

  /** 现行约定（初约叠加各次改约，晚到一份覆盖早到） */
  const agreements = computed(() => effectiveAgreements(manifests.value))

  const unclaimedCount = computed(
    () => intakes.value.filter((item) => item.state === 'unclaimed').length
  )

  /** 某册次的领用记录 */
  function requisitionsOfVolume(volumeId: string): PaperRequisition[] {
    return requisitions.value
      .filter((item) => item.volumeId === volumeId)
      .sort((a, b) => a.paperType.localeCompare(b.paperType))
  }

  function intakeOfVolume(volume: Volume): ConsignIntake | undefined {
    if (!volume.consignNo) return undefined
    return intakes.value.find((item) => item.id === consignIntakeId(volume.consignNo as string, volume.volumeNo))
  }

  /**
   * 接收一批送修单（外单位侧写入）。
   * 确定性主键 + bulkPut：重复接收幂等；同一纸种再次到达即「改约」，旧行保留、新行生效。
   * 只写 consignManifests，修复室册次 / 工序一律不动。
   */
  async function ingestBatch(lines: ConsignManifestInput[]): Promise<{ added: number; receivedAt: number }> {
    const batchAt = Date.now()
    const rows: ConsignManifest[] = lines.map((line) => {
      const receivedAt = line.receivedAt ?? batchAt
      return {
        ...line,
        receivedAt,
        id: manifestLineId(line.consignNo.trim(), line.volumeNo, line.paperType, receivedAt),
        createdAt: receivedAt,
        updatedAt: receivedAt
      }
    })
    await db.consignManifests.bulkPut(rows)
    await loadAll()
    return { added: rows.length, receivedAt: batchAt }
  }

  /**
   * 执行对账（修复室侧）：按现行送修单补建对认记录；
   * 已对上的册次保持不动，新键自动按「送修编号 + 册次号」匹配本室册次，认不上挂待认领。
   * 同时给自动对上的册次挂送修标记 / 单位。送修单不参与写事务。
   */
  async function reconcile(volumes: Volume[]): Promise<{ matched: number; unclaimed: number; created: number }> {
    const plan = planReconcile(manifests.value, volumes)
    return await withStudioRetry(['consignIntakes', 'volumes'], async () => {
      const now = Date.now()
      let matched = 0
      let unclaimed = 0
      let created = 0
      for (const expected of plan.expected) {
        const id = consignIntakeId(expected.consignNo, expected.volumeNo)
        const existing = await db.consignIntakes.get(id)
        if (existing) {
          if (existing.state === 'matched') matched += 1
          else unclaimed += 1
          // 单位名称以外单位最新单据为准，但不动对上关系与认领时间
          if (existing.ownerUnit !== expected.ownerUnit) {
            await db.consignIntakes.update(id, { ownerUnit: expected.ownerUnit, updatedAt: now })
          }
          continue
        }
        created += 1
        const hit = plan.autoMatched.find(
          (item) => item.consignNo === expected.consignNo && item.volumeNo === expected.volumeNo
        )
        const draft: ConsignIntakeDraft = hit
          ? {
              consignNo: expected.consignNo,
              volumeNo: expected.volumeNo,
              ownerUnit: expected.ownerUnit,
              volumeId: hit.volumeId,
              state: 'matched',
              claimedAt: now
            }
          : {
              consignNo: expected.consignNo,
              volumeNo: expected.volumeNo,
              ownerUnit: expected.ownerUnit,
              volumeId: null,
              state: 'unclaimed',
              claimedAt: null
            }
        await db.consignIntakes.put({ ...draft, id, createdAt: now, updatedAt: now })
        if (hit) {
          matched += 1
          await db.volumes.update(hit.volumeId, {
            consignNo: expected.consignNo,
            ownerUnit: expected.ownerUnit,
            updatedAt: now
          })
        } else {
          unclaimed += 1
        }
      }
      return { matched, unclaimed, created }
    }).finally(loadAll)
  }

  /**
   * 人工认册（修复室侧）：待认领记录认到本室册次。
   * 严格按「送修编号 + 册次号」校验：册次号对不上不许认；已挂别的送修编号也不许认。
   */
  async function claim(intake: ConsignIntake, volume: Volume): Promise<void> {
    if (volume.volumeNo !== intake.volumeNo) {
      throw new Error(`册次号对不上：送修单为第 ${intake.volumeNo} 册，所选为第 ${volume.volumeNo} 册`)
    }
    if (volume.consignNo && volume.consignNo !== intake.consignNo) {
      throw new Error(`该册已挂送修编号 ${volume.consignNo}，不能再认 ${intake.consignNo}`)
    }
    const now = Date.now()
    await withStudioRetry(['consignIntakes', 'volumes'], async () => {
      await db.consignIntakes.put({
        ...intake,
        volumeId: volume.id,
        state: 'matched',
        claimedAt: now,
        updatedAt: now
      })
      await db.volumes.update(volume.id, {
        consignNo: intake.consignNo,
        ownerUnit: intake.ownerUnit,
        updatedAt: now
      })
    }).finally(loadAll)
  }

  /** 撤销对上（修复室侧）：摘开本侧册次的送修标记，记录退回待认领；送修单不动 */
  async function unclaim(intake: ConsignIntake): Promise<void> {
    if (!intake.volumeId) return
    const volumeId = intake.volumeId
    const now = Date.now()
    await withStudioRetry(['consignIntakes', 'volumes'], async () => {
      await db.consignIntakes.put({
        ...intake,
        volumeId: null,
        state: 'unclaimed',
        claimedAt: null,
        updatedAt: now
      })
      await db.volumes.update(volumeId, { consignNo: null, ownerUnit: null, updatedAt: now })
    }).finally(loadAll)
  }

  /**
   * 登记 / 更新补纸领用（修复室侧）。同册同纸种只累计一条；
   * 超约定的部分在读取侧按现行约定（改约晚到为准）实时算出「待补办」，不在此固化。
   */
  async function saveRequisition(draft: PaperRequisitionDraft, existingId?: string): Promise<void> {
    const now = Date.now()
    await withStudioRetry(['paperRequisitions'], async () => {
      const id = existingId ?? paperRequisitionId(draft.volumeId, draft.paperType)
      const existing = await db.paperRequisitions.get(id)
      const row: PaperRequisition = existing
        ? { ...existing, ...draft, id, updatedAt: now }
        : { ...draft, id, createdAt: now, updatedAt: now }
      await db.paperRequisitions.put(row)
    }).finally(loadAll)
  }

  async function removeRequisition(id: string): Promise<void> {
    await withStudioRetry(['paperRequisitions'], async () => {
      await db.paperRequisitions.delete(id)
    }).finally(loadAll)
  }

  /** 本室册次手工补挂 / 摘除送修编号（册次台账编辑用；认领仍以对账页为准） */
  async function setVolumeConsignNo(volume: Volume, consignNo: string | null): Promise<void> {
    const now = Date.now()
    const trimmed = consignNo?.trim() ? consignNo.trim() : null
    await withStudioRetry(['volumes'], async () => {
      await db.volumes.update(volume.id, {
        consignNo: trimmed,
        ownerUnit: trimmed ? volume.ownerUnit : null,
        updatedAt: now
      })
    })
  }

  return {
    manifests,
    intakes,
    requisitions,
    loading,
    ready,
    error,
    agreements,
    unclaimedCount,
    loadAll,
    requisitionsOfVolume,
    intakeOfVolume,
    ingestBatch,
    reconcile,
    claim,
    unclaim,
    saveRequisition,
    removeRequisition,
    setVolumeConsignNo
  }
})
