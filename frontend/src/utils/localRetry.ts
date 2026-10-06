/**
 * 修复室本侧写库失败的重试 / 死信工具。
 *
 * 规则边界（对应业务约定）：
 * - 只允许包装修复室本侧表（consignLinks / paperRequisitions / 既有六张业务表）的写入；
 * - 送修单（consignments）是藏书单位侧数据，接收时单独写入，绝不进入本侧重试，
 *   也不会因为本侧写入失败而被改写或回滚；
 * - 立即重试有限次数后仍失败的操作进入死信队列持久化，待写库恢复后由人工「重试本侧」。
 *
 * 为便于演示该恢复路径，保留一个一次性故障注入开关：
 * armNextLocalFailure() 后下一次 runLocalWrite 必然失败并重试。
 */

/** 本侧写操作（幂等：死信重放时会被再次执行） */
export type LocalWrite = () => Promise<void>

export interface LocalWriteResult {
  ok: boolean
  attempts: number
  error: string
}

/** 死信队列条目：操作描述 + 可执行写动作构造信息 */
export interface DeadLetter {
  id: string
  kind: string
  description: string
  table: string
  payload: unknown
  attempts: number
  lastError: string
  failedAt: number
}

const DEAD_LETTER_KEY = 'gbbookrestore:dead-letters'
/** 立即重试次数（含首次） */
const MAX_ATTEMPTS = 3
const BACKOFF_MS = [0, 120, 320] as const

/**
 * 故障注入：作用于「下一次 runLocalWrite 的整段尝试」，
 * 即 3 次尝试全部失败（模拟写库持续不可用）→ 进入死信队列。
 * run 结束后自动复位；真实环境没有调用方时不产生任何影响。
 */
let failNextWriteFully = false

/** 演练用：让下一次本侧写的全部重试都失败（演示死信与人工重放） */
export function armNextLocalFailure(): void {
  failNextWriteFully = true
}

export function isFailureArmed(): boolean {
  return failNextWriteFully
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 执行一次本侧写：最多尝试 MAX_ATTEMPTS 次；
 * 全部失败后落死信队列，返回 ok:false。本函数不抛出。
 */
export async function runLocalWrite(write: LocalWrite, letter: Omit<DeadLetter, 'id' | 'attempts' | 'lastError' | 'failedAt'>): Promise<LocalWriteResult> {
  const armed = failNextWriteFully
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (armed) throw new Error('模拟本侧写库失败（故障演练）')
      await write()
      return { ok: true, attempts: attempt, error: '' }
    } catch (err) {
      lastError = err instanceof Error ? err.message : '本侧写库失败'
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt] ?? 300)
    }
  }
  failNextWriteFully = false
  enqueueDeadLetter({ ...letter, attempts: MAX_ATTEMPTS, lastError })
  return { ok: false, attempts: MAX_ATTEMPTS, error: lastError }
}

/* ------------------------------ 死信队列 ------------------------------ */

/**
 * 死信同时保留内存镜像与 localStorage 持久化：
 * 隐私模式 / 存储不可用时 localStorage 写入会失败，内存队列仍能保证当次会话可重放。
 */
const memoryLetters: DeadLetter[] = []

export function loadDeadLetters(): DeadLetter[] {
  const persisted: DeadLetter[] = []
  try {
    const raw = localStorage.getItem(DEAD_LETTER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) persisted.push(...(parsed as DeadLetter[]))
    }
  } catch {
    /* localStorage 不可用时只用内存队列 */
  }
  const seen = new Set(persisted.map((item) => item.id))
  memoryLetters.forEach((item) => {
    if (!seen.has(item.id)) persisted.push(item)
  })
  return persisted.sort((a, b) => a.failedAt - b.failedAt)
}

function persistDeadLetters(list: DeadLetter[]): void {
  try {
    localStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式下无法持久化：内存队列仍在 */
  }
}

export function enqueueDeadLetter(
  letter: Omit<DeadLetter, 'id' | 'failedAt'> & { failedAt?: number }
): DeadLetter {
  const row: DeadLetter = {
    id: `dl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    kind: letter.kind,
    description: letter.description,
    table: letter.table,
    payload: letter.payload,
    attempts: letter.attempts,
    lastError: letter.lastError,
    failedAt: letter.failedAt ?? Date.now()
  }
  memoryLetters.push(row)
  // 以「合并后全集」回写，避免内存条目在持久化时丢失
  const merged = loadDeadLetters()
  if (!merged.some((item) => item.id === row.id)) merged.push(row)
  persistDeadLetters(merged)
  return row
}

export function removeDeadLetter(id: string): void {
  const index = memoryLetters.findIndex((item) => item.id === id)
  if (index >= 0) memoryLetters.splice(index, 1)
  persistDeadLetters(loadDeadLetters().filter((item) => item.id !== id))
}

export function clearDeadLetters(): void {
  memoryLetters.length = 0
  persistDeadLetters([])
}
