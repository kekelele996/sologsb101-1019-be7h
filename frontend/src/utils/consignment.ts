/**
 * 送修对账纯函数：有效约定选取、领用超额测算、来件解析校验。
 * 不触碰 IndexedDB、不依赖 UI；被 consignStore 与送修对账页共同消费。
 *
 * 边界约定：
 * - 送修单是藏书单位的数据：只读接收、按行留痕，同键（送修编号+册次号）晚到者为有效约定；
 * - 修复师登记的破损与工序与对账完全无关，本文件不参与其任何回写；
 * - 认不上的来件行不允许挂册，保持「待认领」。
 */
import type { PaperType } from '@/types/paper'
import type { ConsignmentLine, PaperAllowance } from '@/types/consignment'

/** 同一（送修编号 + 册次号）下的全部批次 */
export interface ConsignGroup {
  sendNo: string
  volumeNo: number
  lines: ConsignmentLine[]
  /** 当前有效约定行：receivedAt 最大（并列再取 revisionSeq / updatedAt） */
  effective: ConsignmentLine
}

/** 按对账键分组并选出每行有效约定 */
export function groupConsignments(lines: ConsignmentLine[]): ConsignGroup[] {
  const map = new Map<string, ConsignmentLine[]>()
  lines.forEach((line) => {
    const key = `${line.sendNo}#${line.volumeNo}`
    const bucket = map.get(key)
    if (bucket) bucket.push(line)
    else map.set(key, [line])
  })
  const groups: ConsignGroup[] = []
  map.forEach((bucket, key) => {
    const sorted = [...bucket].sort(compareLineArrival)
    groups.push({
      sendNo: key.split('#')[0] ?? '',
      volumeNo: bucket[0]?.volumeNo ?? 0,
      lines: sorted,
      effective: sorted[sorted.length - 1] as ConsignmentLine
    })
  })
  return groups.sort((a, b) =>
    a.sendNo === b.sendNo ? a.volumeNo - b.volumeNo : a.sendNo.localeCompare(b.sendNo)
  )
}

/** 晚到排序：receivedAt → revisionSeq → updatedAt */
function compareLineArrival(a: ConsignmentLine, b: ConsignmentLine): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt
  if (a.revisionSeq !== b.revisionSeq) return a.revisionSeq - b.revisionSeq
  return a.updatedAt - b.updatedAt
}

/** 有效约定行（晚到那份）；无记录返回 undefined */
export function effectiveLineOf(
  lines: ConsignmentLine[],
  sendNo: string,
  volumeNo: number
): ConsignmentLine | undefined {
  const matched = lines.filter((line) => line.sendNo === sendNo && line.volumeNo === volumeNo)
  if (matched.length === 0) return undefined
  return [...matched].sort(compareLineArrival)[matched.length - 1]
}

/** 某纸种的约定张数；约定中没有该纸种按 0 处理 */
export function agreedSheetsOf(line: ConsignmentLine | undefined, paperType: PaperType): number {
  if (!line) return 0
  return line.paperAllowances.find((item) => item.paperType === paperType)?.agreedSheets ?? 0
}

/** 一册一纸种的累计领用口径 */
export interface PaperUsage {
  /** 累计实领张数（全部非作废口径的领用行） */
  totalUsed: number
  /** 其中挂起待补办张数之和 */
  pendingSheets: number
}

/** 册次 × 纸种 的已用张数汇总（已补办入账行计入已用，不再算挂起） */
export function usageOf(
  requisitions: Array<{
    volumeId: string
    paperType: PaperType
    usedSheets: number
    pendingSheets: number
    state: string
  }>,
  volumeId: string,
  paperType: PaperType
): PaperUsage {
  const rows = requisitions.filter((row) => row.volumeId === volumeId && row.paperType === paperType)
  return {
    totalUsed: rows.reduce((sum, row) => sum + row.usedSheets, 0),
    pendingSheets: rows
      .filter((row) => row.state === 'pending_supplement')
      .reduce((sum, row) => sum + row.pendingSheets, 0)
  }
}

export interface RequisitionCalc {
  /** 落账依据的有效约定行 id（非送修册为空） */
  basisLineId: string
  basisAgreedSheets: number | null
  inQuotaSheets: number
  pendingSheets: number
  state: 'in_quota' | 'pending_supplement'
}

/**
 * 新领用落账测算：
 * 有效约定纸种余量 = 约定张数 − 该纸种历史累计实领；
 * 本次在余量内的部分正常，超出部分挂起待补办。
 * 非送修册（line 为空）不做校验，全部正常。
 */
export function calcRequisition(input: {
  effectiveLine?: ConsignmentLine
  paperType: PaperType
  usedSheets: number
  priorUsage: PaperUsage
}): RequisitionCalc {
  const { effectiveLine, paperType, usedSheets, priorUsage } = input
  if (!effectiveLine) {
    return {
      basisLineId: '',
      basisAgreedSheets: null,
      inQuotaSheets: usedSheets,
      pendingSheets: 0,
      state: 'in_quota'
    }
  }
  const agreed = agreedSheetsOf(effectiveLine, paperType)
  const remaining = Math.max(0, agreed - priorUsage.totalUsed)
  const inQuota = Math.min(usedSheets, remaining)
  const pending = usedSheets - inQuota
  return {
    basisLineId: effectiveLine.id,
    basisAgreedSheets: agreed,
    inQuotaSheets: inQuota,
    pendingSheets: pending,
    state: pending > 0 ? 'pending_supplement' : 'in_quota'
  }
}

/**
 * 补办测算：改约后约定张数增加，挂起的超额是否已被新约定吸收。
 * 返回 0 表示该纸种已无超额，可将挂起行补办入账；> 0 表示仍超额的张数。
 */
export function remainingOverflow(
  agreedSheets: number,
  requisitions: Array<{ volumeId: string; paperType: PaperType; usedSheets: number }>,
  volumeId: string,
  paperType: PaperType
): number {
  const totalUsed = requisitions
    .filter((row) => row.volumeId === volumeId && row.paperType === paperType)
    .reduce((sum, row) => sum + row.usedSheets, 0)
  return Math.max(0, totalUsed - agreedSheets)
}

/** 该册是否允许并入验收：存在挂起待补办的领用即不许 */
export function hasPendingSupplement(
  requisitions: Array<{ volumeId: string; state: string }>,
  volumeId: string
): boolean {
  return requisitions.some((row) => row.volumeId === volumeId && row.state === 'pending_supplement')
}

/* ------------------------------ 来件解析校验 ------------------------------ */

export interface ValidatedConsignPacket {
  /** 来件批次的接收时刻；缺省按解析时刻 */
  receivedAt: number
  lines: Array<{
    id: string
    sendNo: string
    volumeNo: number
    ownerUnit: string
    revision: 'initial' | 'amendment'
    revisionSeq: number
    receivedAt: number
    paperAllowances: PaperAllowance[]
    note: string
  }>
}

/**
 * 解析藏书单位发来的对账单（JSON）。
 * 接受两种形态：
 *   A. { receivedAt?, lines: ConsignmentLine[] }
 *   B. ConsignmentLine[]
 * 返回错误文案（空串表示通过）。只做形状校验，不做任何写库动作。
 */
export function parseConsignPacket(input: unknown, fallbackReceivedAt: number): { error: string; packet?: ValidatedConsignPacket } {
  let rawLines: unknown
  let packetReceivedAt: number | undefined
  if (Array.isArray(input)) {
    rawLines = input
  } else if (typeof input === 'object' && input !== null && Array.isArray((input as { lines?: unknown }).lines)) {
    rawLines = (input as { lines: unknown }).lines
    const stamp = (input as { receivedAt?: unknown }).receivedAt
    if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) packetReceivedAt = stamp
  } else {
    return { error: '来件应为送修行数组，或含 lines 数组的对账单对象' }
  }

  const lines: ValidatedConsignPacket['lines'] = []
  const seenIds = new Set<string>()
  const list = rawLines as unknown[]
  if (list.length === 0) return { error: '来件中没有任何送修行' }

  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index] as Record<string, unknown> | null
    const where = `第 ${index + 1} 行`
    if (typeof raw !== 'object' || raw === null) return { error: `${where} 不是对象` }
    const sendNo = typeof raw.sendNo === 'string' ? raw.sendNo.trim() : ''
    if (!sendNo) return { error: `${where} 缺少送修编号 sendNo` }
    const volumeNo = Number(raw.volumeNo)
    if (!Number.isInteger(volumeNo) || volumeNo <= 0) return { error: `${where} 册次号 volumeNo 必须是正整数` }
    const ownerUnit = typeof raw.ownerUnit === 'string' ? raw.ownerUnit.trim() : ''
    const revisionSeqRaw = Number(raw.revisionSeq)
    const revisionSeq = Number.isInteger(revisionSeqRaw) && revisionSeqRaw >= 1 ? revisionSeqRaw : 1
    const explicitRevision = raw.revision
    const revision: 'initial' | 'amendment' =
      explicitRevision === 'amendment' || (explicitRevision !== 'initial' && revisionSeq >= 2)
        ? 'amendment'
        : 'initial'
    const allowancesRaw = raw.paperAllowances
    if (!Array.isArray(allowancesRaw)) return { error: `${where} 缺少约定补纸清单 paperAllowances（空数组也需显式给出）` }
    const paperAllowances: PaperAllowance[] = []
    for (const allowanceRaw of allowancesRaw as unknown[]) {
      if (typeof allowanceRaw !== 'object' || allowanceRaw === null) return { error: `${where} 存在不合法的补纸约定` }
      const allowance = allowanceRaw as Record<string, unknown>
      const paperType = String(allowance.paperType ?? '')
      if (paperType !== 'bamboo' && paperType !== 'bark' && paperType !== 'xuan') {
        return { error: `${where} 纸种 paperType 只能是 bamboo / bark / xuan` }
      }
      const agreed = Number(allowance.agreedSheets)
      if (!Number.isFinite(agreed) || agreed < 0) return { error: `${where} 约定张数 agreedSheets 不能为负` }
      paperAllowances.push({ paperType, agreedSheets: agreed })
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `ext_${sendNo}_${volumeNo}_r${revisionSeq}`
    if (seenIds.has(id)) return { error: `${where} 行 id 重复：${id}` }
    seenIds.add(id)
    const receivedAt = typeof raw.receivedAt === 'number' && raw.receivedAt > 0 ? raw.receivedAt : fallbackReceivedAt
    lines.push({
      id,
      sendNo,
      volumeNo,
      ownerUnit,
      revision,
      revisionSeq,
      receivedAt: packetReceivedAt ?? receivedAt,
      paperAllowances,
      note: typeof raw.note === 'string' ? raw.note : ''
    })
  }
  return { error: '', packet: { receivedAt: packetReceivedAt ?? fallbackReceivedAt, lines } }
}
