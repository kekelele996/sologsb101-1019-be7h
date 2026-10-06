/**
 * 送修对认记录（ConsignIntake）数据模型 —— 修复室侧账本
 * 收下送修册后按「送修编号 + 册次号」与本室册次对起来：
 * - matched   对上的册次挂送修标记（volumeId 指向本室册次）
 * - unclaimed 认不上的先挂待认领，等人工认册
 * 修复师登记的破损与工序不受对认影响，仍照旧挂在本室册次 / 书叶上。
 */

/** 对认状态：已对上 / 待认领 */
export type ConsignIntakeState = 'matched' | 'unclaimed'

export interface ConsignIntake {
  id: string
  /** 送修编号 */
  consignNo: string
  /** 外单位登记的册次号 */
  volumeNo: number
  /** 送修单位（认领时从送修单带到册次上） */
  ownerUnit: string
  /** 对上的本室册次 id；待认领时为 null */
  volumeId: string | null
  /** 对认状态 */
  state: ConsignIntakeState
  /** 对上的时间（自动对账或人工认领） */
  claimedAt: number | null
  createdAt: number
  updatedAt: number
}

export type ConsignIntakeDraft = Omit<ConsignIntake, 'id' | 'createdAt' | 'updatedAt'>

/** 对认记录主键：一个送修编号 + 册次号只有一条（改约不新增对认记录） */
export function consignIntakeId(consignNo: string, volumeNo: number): string {
  return `cit_${consignNo}_v${volumeNo}`
}

export const CONSIGN_INTAKE_STATE_LABEL: Record<ConsignIntakeState, string> = {
  matched: '已对上',
  unclaimed: '待认领'
}

export const CONSIGN_INTAKE_STATE_COLOR: Record<ConsignIntakeState, string> = {
  matched: '#1e8449',
  unclaimed: '#d68910'
}

export const CONSIGN_INTAKE_STATE_OPTIONS: ReadonlyArray<{
  value: ConsignIntakeState
  label: string
}> = [{ value: 'matched', label: '已对上' }, { value: 'unclaimed', label: '待认领' }]
