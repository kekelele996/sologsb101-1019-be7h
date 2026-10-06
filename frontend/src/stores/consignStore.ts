/**
 * 送修对账 store（Pinia setup store）
 *
 * 两侧数据各管各的，靠人工对账：
 * - consignments：藏书单位侧的送修单批次（送修编号 / 册次号 / 约定纸种张数 / 改约），
 *   接收侧只追加（bulkAdd，同 id 幂等跳过），本侧任何失败都不改写它；
 * - consignLinks：修复室本侧的对账关系（人工把「送修编号+册次号」认到本侧册次上）；
 * - paperRequisitions：修复室本侧的补纸领用台账（超额部分挂起待补办）。
 *
 * 本侧写库失败：只重试 consignLinks / paperRequisitions 两张本侧表，
 * 失败到底进死信队列（见 utils/localRetry），送修单原样不动。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import {
  calcRequisition,
  effectiveLineOf,
  groupConsignments,
  hasPendingSupplement,
  parseConsignPacket,
  remainingOverflow,
  usageOf,
  type ConsignGroup,
  type ValidatedConsignPacket
} from '@/utils/consignment'
import {
  loadDeadLetters,
  removeDeadLetter,
  runLocalWrite,
  type DeadLetter
} from '@/utils/localRetry'
import type { ConsignLink, ConsignmentLine, ConsignLineDraft, PaperAllowance } from '@/types/consignment'
import type { PaperRequisition } from '@/types/paperRequisition'
import type { PaperType } from '@/types/paper'

export interface RegisterRequisitionInput {
  volumeId: string
  leafId?: string
  paperType: PaperType
  usedSheets: number
  operator?: string
  date?: string
  note?: string
}

export const useConsignStore = defineStore('consign', () => {
  /** 藏书单位侧：送修单（只读接收） */
  const consignments = ref<ConsignmentLine[]>([])
  /** 修复室本侧：对账关系 */
  const links = ref<ConsignLink[]>([])
  /** 修复室本侧：补纸领用 */
  const requisitions = ref<PaperRequisition[]>([])
  /** 本侧写失败死信 */
  const deadLetters = ref<DeadLetter[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [lineRows, linkRows, reqRows] = await Promise.all([
        db.consignments.toArray(),
        db.consignLinks.toArray(),
        db.paperRequisitions.toArray()
      ])
      lineRows.sort((a, b) =>
        a.sendNo === b.sendNo
          ? a.volumeNo === b.volumeNo
            ? a.receivedAt - b.receivedAt
            : a.volumeNo - b.volumeNo
          : a.sendNo.localeCompare(b.sendNo)
      )
      consignments.value = lineRows
      linkRows.sort((a, b) => a.linkedAt - b.linkedAt)
      links.value = linkRows
      reqRows.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date.localeCompare(b.date)))
      requisitions.value = reqRows
      deadLetters.value = loadDeadLetters()
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '送修数据读取失败'
    } finally {
      loading.value = false
    }
  }

  function refreshDeadLetters(): void {
    deadLetters.value = loadDeadLetters()
  }

  /* ------------------------------ 派生查询 ------------------------------ */

  /** 按（送修编号+册次号）分组的有效约定视图 */
  const groups = computed<ConsignGroup[]>(() => groupConsignments(consignments.value))

  function groupOf(sendNo: string, volumeNo: number): ConsignGroup | undefined {
    return groups.value.find((group) => group.sendNo === sendNo && group.volumeNo === volumeNo)
  }

  /** 册次 id → 对账关系（本侧册次是否已挂送修标记） */
  const linkByVolumeId = computed<Map<string, ConsignLink>>(() => {
    const map = new Map<string, ConsignLink>()
    links.value.forEach((link) => map.set(link.volumeId, link))
    return map
  })

  /** 对账键（送修编号#册次号）→ 关系，供送修行判定是否已对上 */
  const linkByKey = computed<Map<string, ConsignLink>>(() => {
    const map = new Map<string, ConsignLink>()
    links.value.forEach((link) => map.set(`${link.sendNo}#${link.volumeNo}`, link))
    return map
  })

  function linkOfVolume(volumeId: string): ConsignLink | undefined {
    return linkByVolumeId.value.get(volumeId)
  }

  function isConsignedVolume(volumeId: string): boolean {
    return linkByVolumeId.value.has(volumeId)
  }

  function effectiveLineForVolume(volumeId: string): ConsignmentLine | undefined {
    const link = linkOfVolume(volumeId)
    if (!link) return undefined
    return effectiveLineOf(consignments.value, link.sendNo, link.volumeNo)
  }

  /** 待认领送修行（已到件、本侧还没认上册次） */
  const pendingClaimGroups = computed<ConsignGroup[]>(() =>
    groups.value.filter((group) => !linkByKey.value.has(`${group.sendNo}#${group.volumeNo}`))
  )

  /** 已对上的分组 */
  const matchedGroups = computed<ConsignGroup[]>(() =>
    groups.value.filter((group) => linkByKey.value.has(`${group.sendNo}#${group.volumeNo}`))
  )

  function requisitionsOfVolume(volumeId: string): PaperRequisition[] {
    return requisitions.value.filter((row) => row.volumeId === volumeId)
  }

  /** 该册是否有挂起待补办的领用：有则不许并进验收 */
  function volumeBlockedForAcceptance(volumeId: string): boolean {
    return hasPendingSupplement(requisitions.value, volumeId)
  }

  /** 待补办领用总数（导航徽标用） */
  const pendingSupplementCount = computed<number>(
    () => requisitions.value.filter((row) => row.state === 'pending_supplement').length
  )

  const pendingClaimCount = computed<number>(() => pendingClaimGroups.value.length)

  /* ------------------------ 送修单接收（藏书单位侧，原样落库） ------------------------ */

  /**
   * 接收藏书单位发来的对账批次：只写 consignments 表（bulkAdd 幂等），
   * 绝不与本侧对账关系 / 领用写在同一事务里 —— 本侧失败不影响来件，来件也不回滚。
   * 返回新入库条数；同 id（同一批次重发）跳过。
   */
  async function receivePacket(input: unknown): Promise<{ ok: boolean; inserted: number; message: string }> {
    const { error: invalid, packet } = parseConsignPacket(input, Date.now())
    if (invalid || !packet) return { ok: false, inserted: 0, message: invalid }
    const result = await bulkReceive(packet)
    return result
  }

  async function bulkReceive(packet: ValidatedConsignPacket): Promise<{ ok: boolean; inserted: number; message: string }> {
    try {
      const existing = new Set((await db.consignments.toCollection().primaryKeys()) as string[])
      const fresh = packet.lines
        .filter((line) => !existing.has(line.id))
        .map((line) => {
          const now = Date.now()
          const row: ConsignmentLine = {
            id: line.id,
            sendNo: line.sendNo,
            volumeNo: line.volumeNo,
            ownerUnit: line.ownerUnit,
            revision: line.revision,
            revisionSeq: line.revisionSeq,
            receivedAt: line.receivedAt,
            paperAllowances: line.paperAllowances,
            note: line.note,
            createdAt: now,
            updatedAt: now
          }
          return row
        })
      if (fresh.length > 0) await db.consignments.bulkAdd(fresh)
      await loadAll()
      return {
        ok: true,
        inserted: fresh.length,
        message:
          fresh.length === 0
            ? '来件批次此前已接收，全部幂等跳过；送修单原样未改'
            : `已接收 ${fresh.length} 条送修批次（改约以晚到那份为准）`
      }
    } catch (err) {
      return { ok: false, inserted: 0, message: err instanceof Error ? err.message : '送修单接收失败' }
    }
  }

  /** 手工登记一单来件（修复室收件登记） */
  async function receiveManual(draft: ConsignLineDraft): Promise<{ ok: boolean; message: string }> {
    const sendNo = draft.sendNo.trim()
    if (!sendNo) return { ok: false, message: '请填写送修编号' }
    const seq = Math.max(1, Math.floor(draft.revisionSeq))
    const allowances = draft.paperAllowances.filter((item) => item.agreedSheets >= 0)
    const packet: ValidatedConsignPacket = {
      receivedAt: Date.now(),
      lines: [
        {
          id: `ext_${sendNo}_${draft.volumeNo}_r${seq}`,
          sendNo,
          volumeNo: draft.volumeNo,
          ownerUnit: draft.ownerUnit.trim(),
          revision: seq >= 2 ? 'amendment' : 'initial',
          revisionSeq: seq,
          receivedAt: Date.now(),
          paperAllowances: allowances,
          note: draft.note.trim()
        }
      ]
    }
    return bulkReceive(packet)
  }

  /* ------------------------------ 本侧对账（只写本侧表） ------------------------------ */

  /**
   * 人工认领：把（送修编号+册次号）认到本侧册次上。
   * 一对一：一个对账键只挂一册、一册只挂一个对账键。
   */
  async function linkVolume(sendNo: string, volumeNo: number, volumeId: string): Promise<{ ok: boolean; message: string }> {
    if (!sendNo) return { ok: false, message: '缺少送修编号' }
    if (!volumeId) return { ok: false, message: '请选择本侧册次' }
    if (!groupOf(sendNo, volumeNo)) return { ok: false, message: '送修编号 / 册次号在来件中不存在，认不上的先挂待认领' }
    if (linkByKey.value.has(`${sendNo}#${volumeNo}`)) return { ok: false, message: '该送修册次已认过，不能重复认领' }
    if (linkByVolumeId.value.has(volumeId)) return { ok: false, message: '该本侧册次已挂有送修标记' }

    const now = Date.now()
    const row: ConsignLink = {
      id: createId('csk'),
      sendNo,
      volumeNo,
      volumeId,
      linkedAt: now,
      createdAt: now,
      updatedAt: now
    }
    const result = await runLocalWrite(async () => {
      await db.consignLinks.add(row)
    }, {
      kind: 'link',
      description: `挂送修标记：${sendNo} 第 ${volumeNo} 册 → 本侧册次`,
      table: 'consignLinks',
      payload: row
    })
    await loadAll()
    if (!result.ok) return { ok: false, message: `本侧写库失败，已重试 ${result.attempts} 次，转入死信待人工重试；送修单原样未动` }
    return { ok: true, message: `已对上：${sendNo} 第 ${volumeNo} 册挂上送修标记` }
  }

  /** 取消对账：只删本侧关系，送修单原样保留，该行回到待认领 */
  async function unlink(linkId: string): Promise<{ ok: boolean; message: string }> {
    const target = links.value.find((row) => row.id === linkId)
    if (!target) return { ok: false, message: '对账关系不存在' }
    const result = await runLocalWrite(async () => {
      await db.consignLinks.delete(linkId)
    }, {
      kind: 'unlink',
      description: `取消对账：${target.sendNo} 第 ${target.volumeNo} 册（送修单保留）`,
      table: 'consignLinks',
      payload: { id: linkId }
    })
    await loadAll()
    if (!result.ok) return { ok: false, message: `本侧写库失败，已重试 ${result.attempts} 次，转入死信待人工重试` }
    return { ok: true, message: '已取消本侧对账，送修行回到待认领，送修单原样未动' }
  }

  /* ------------------------------ 补纸领用（只写本侧表） ------------------------------ */

  /**
   * 登记一笔补纸领用：按当前有效约定测算，超额部分挂起待补办。
   * 非送修册不做约定校验。修复师登记的破损 / 工序与此无关，这里不回写。
   */
  async function registerRequisition(input: RegisterRequisitionInput): Promise<{ ok: boolean; message: string }> {
    const usedSheets = Math.floor(input.usedSheets)
    if (!input.volumeId) return { ok: false, message: '请选择册次' }
    if (!Number.isFinite(usedSheets) || usedSheets <= 0) return { ok: false, message: '领用张数必须是正整数' }

    const effectiveLine = effectiveLineForVolume(input.volumeId)
    const prior = usageOf(requisitions.value, input.volumeId, input.paperType)
    const calc = calcRequisition({
      effectiveLine,
      paperType: input.paperType,
      usedSheets,
      priorUsage: prior
    })

    const now = Date.now()
    const row: PaperRequisition = {
      id: createId('req'),
      volumeId: input.volumeId,
      leafId: input.leafId ?? '',
      paperType: input.paperType,
      usedSheets,
      inQuotaSheets: calc.inQuotaSheets,
      pendingSheets: calc.pendingSheets,
      basisLineId: calc.basisLineId,
      basisAgreedSheets: calc.basisAgreedSheets,
      state: calc.state,
      operator: input.operator?.trim() ?? '',
      date: input.date ?? new Date().toISOString().slice(0, 10),
      note: input.note?.trim() ?? '',
      createdAt: now,
      updatedAt: now
    }
    const result = await runLocalWrite(async () => {
      await db.paperRequisitions.add(row)
    }, {
      kind: 'register-requisition',
      description: `补纸领用入账：${input.paperType} ${usedSheets} 张（挂起 ${calc.pendingSheets} 张）`,
      table: 'paperRequisitions',
      payload: row
    })
    await loadAll()
    if (!result.ok) return { ok: false, message: `本侧写库失败，已重试 ${result.attempts} 次，转入死信待人工重试；送修单原样未动` }
    return calc.pendingSheets > 0
      ? { ok: true, message: `已登记：${calc.inQuotaSheets} 张正常，超出约定 ${calc.pendingSheets} 张挂起待补办，不许并进验收` }
      : { ok: true, message: '已登记领用，全部在约定张数内' }
  }

  /**
   * 补办入账：改约后约定张数增加、超额被吸收时，把挂起行转为已补办入账。
   * 只依据当前有效约定重新测算，不回改任何已完成的修复工序。
   */
  async function supplementRequisition(requisitionId: string): Promise<{ ok: boolean; message: string }> {
    const target = requisitions.value.find((row) => row.id === requisitionId)
    if (!target) return { ok: false, message: '领用记录不存在' }
    if (target.state !== 'pending_supplement') return { ok: false, message: '只有挂起待补办的领用可以补办入账' }

    const effectiveLine = effectiveLineForVolume(target.volumeId)
    if (!effectiveLine) return { ok: false, message: '该册已无有效送修约定，不能补办' }
    const agreed = effectiveLine.paperAllowances.find((item) => item.paperType === target.paperType)?.agreedSheets ?? 0
    const overflow = remainingOverflow(agreed, requisitions.value, target.volumeId, target.paperType)
    if (overflow > 0) {
      return { ok: false, message: `当前有效约定仍有 ${overflow} 张超额，需等藏书单位再改约后补办` }
    }

    const next: PaperRequisition = {
      ...target,
      state: 'supplemented',
      inQuotaSheets: target.usedSheets,
      pendingSheets: 0,
      basisLineId: effectiveLine.id,
      basisAgreedSheets: agreed,
      note: target.note ? `${target.note}｜改约后补办入账` : '改约后补办入账',
      updatedAt: Date.now()
    }
    const result = await runLocalWrite(async () => {
      await db.paperRequisitions.put(next)
    }, {
      kind: 'supplement-requisition',
      description: `补办入账：领用 ${target.id}（${target.paperType} ${target.usedSheets} 张）`,
      table: 'paperRequisitions',
      payload: next
    })
    await loadAll()
    if (!result.ok) return { ok: false, message: `本侧写库失败，已重试 ${result.attempts} 次，转入死信待人工重试` }
    return { ok: true, message: '已补办入账，该领用不再阻塞验收（已完成工序未作任何改动）' }
  }

  /** 删除一笔本侧领用（仅本侧表，送修单不动） */
  async function removeRequisition(requisitionId: string): Promise<{ ok: boolean; message: string }> {
    const target = requisitions.value.find((row) => row.id === requisitionId)
    if (!target) return { ok: false, message: '领用记录不存在' }
    const result = await runLocalWrite(async () => {
      await db.paperRequisitions.delete(requisitionId)
    }, {
      kind: 'remove-requisition',
      description: `删除领用记录：${requisitionId}`,
      table: 'paperRequisitions',
      payload: { id: requisitionId }
    })
    await loadAll()
    if (!result.ok) return { ok: false, message: `本侧写库失败，已重试 ${result.attempts} 次，转入死信待人工重试` }
    return { ok: true, message: '已删除该笔领用（送修单原样未动）' }
  }

  /* ------------------------------ 死信重试（只重放本侧写） ------------------------------ */

  /**
   * 重放死信：按载荷重新执行本侧写。
   * 绝不触碰 consignments 表；成功后移出死信队列。
   */
  async function retryDeadLetter(letterId: string): Promise<{ ok: boolean; message: string }> {
    const letter = deadLetters.value.find((row) => row.id === letterId)
    if (!letter) return { ok: false, message: '死信不存在' }
    if (letter.table === 'consignments') {
      return { ok: false, message: '送修单侧写操作不允许进入本侧重试，请重新接收来件' }
    }

    let write: () => Promise<void>
    // 死信载荷经 Pinia 状态 / localStorage 往返后可能是响应式代理，
    // IndexedDB structured clone 无法克隆，统一做一次深拷贝还原成普通对象
    const payload = JSON.parse(JSON.stringify(letter.payload)) as PaperRequisition | ConsignLink | { id: string }
    if (letter.kind === 'unlink' || letter.kind === 'remove-requisition') {
      const id = (payload as { id: string }).id
      const table = letter.kind === 'unlink' ? db.consignLinks : db.paperRequisitions
      write = async () => {
        await table.delete(id)
      }
    } else if (letter.table === 'consignLinks') {
      write = async () => {
        await db.consignLinks.put(payload as ConsignLink)
      }
    } else if (letter.table === 'paperRequisitions') {
      write = async () => {
        await db.paperRequisitions.put(payload as PaperRequisition)
      }
    } else {
      return { ok: false, message: `未知本侧表：${letter.table}` }
    }

    try {
      await write()
      removeDeadLetter(letterId)
      await loadAll()
      return { ok: true, message: '本侧重放成功，已从死信队列移除；送修单未受影响' }
    } catch (err) {
      refreshDeadLetters()
      return { ok: false, message: `重放仍失败：${err instanceof Error ? err.message : '未知错误'}（送修单原样未动）` }
    }
  }

  async function dismissDeadLetter(letterId: string): Promise<void> {
    removeDeadLetter(letterId)
    refreshDeadLetters()
  }

  return {
    consignments,
    links,
    requisitions,
    deadLetters,
    loading,
    ready,
    error,
    groups,
    pendingClaimGroups,
    matchedGroups,
    pendingClaimCount,
    pendingSupplementCount,
    loadAll,
    refreshDeadLetters,
    groupOf,
    linkOfVolume,
    isConsignedVolume,
    effectiveLineForVolume,
    requisitionsOfVolume,
    volumeBlockedForAcceptance,
    receivePacket,
    receiveManual,
    linkVolume,
    unlink,
    registerRequisition,
    supplementRequisition,
    removeRequisition,
    retryDeadLetter,
    dismissDeadLetter
  }
})

export type { ConsignGroup, PaperAllowance }
