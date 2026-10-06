/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方；
 *   v2 → v3：外单位送修业务 —— 新增送修单 / 对认记录 / 补纸领用三表，旧册次回填送修标记为空按未送修显示）
 * - 九张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 *
 * 两个限界上下文物理分表，互不写对方：
 * - consignManifests 是外单位账本，修复室侧事务不包含它；
 * - 修复室写库失败只重试本侧若干表（见 withStudioRetry / STUDIO_TABLES）。
 */
import Dexie, { type Table } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { ConsignManifest } from '@/types/consignManifest'
import type { ConsignIntake } from '@/types/consignIntake'
import type { PaperRequisition } from '@/types/paperRequisition'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号 */
export const DB_VERSION = 3

/**
 * 修复室侧表集合：写库失败重试、对认 / 领用事务只碰这几张。
 * consignManifests（外单位送修单）刻意不在其中 —— 本侧失败重试不许动送修册原样。
 */
export const STUDIO_TABLES = [
  'books',
  'volumes',
  'leaves',
  'papers',
  'repairOrders',
  'bindings',
  'consignIntakes',
  'paperRequisitions'
] as const

export type StudioTableName = (typeof STUDIO_TABLES)[number]

/** 修复室侧一次写操作（事务闭包）；失败只重试本侧表，绝不带上 consignManifests */
export async function withStudioRetry<T>(
  tables: StudioTableName[],
  worker: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await db.transaction('rw', tables.map((name) => db.table(name)), worker)
    } catch (err) {
      lastError = err
      // IndexedDB 关闭 / 配额等错误重试无意义，直接抛出
      if (err instanceof Error && /QuotaExceeded|DatabaseClosed|InvalidState/i.test(err.name)) {
        throw err
      }
      if (attempt < attempts) {
        // 指数退避：40ms、80ms（本地库写入，仅需短暂避让）
        await new Promise((resolve) => window.setTimeout(resolve, 40 * 2 ** (attempt - 1)))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('修复室本地写入失败')
}

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBookId: null, lastVolumeId: null, repairSort: 'manual' }

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  volumes!: Table<Volume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  /** 外单位送修单（对方账本，只追加，本侧不改） */
  consignManifests!: Table<ConsignManifest, string>
  /** 修复室对认记录（对上 / 待认领） */
  consignIntakes!: Table<ConsignIntake, string>
  /** 修复室补纸领用（超约定部分待补办） */
  paperRequisitions!: Table<PaperRequisition, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(2)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })
      })
    // v3：外单位送修业务。旧册次没有送修标记，一律回填为空 —— 按未送修显示，原有破损 / 工序一律不动。
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, consignNo, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        consignManifests: 'id, consignNo, volumeNo, paperType, ownerUnit, receivedAt',
        consignIntakes: 'id, consignNo, volumeNo, volumeId, state, updatedAt',
        paperRequisitions: 'id, volumeId, paperType, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Volume>('volumes')
          .toCollection()
          .modify((volume) => {
            if (volume.consignNo === undefined) volume.consignNo = null
            if (volume.ownerUnit === undefined) volume.ownerUnit = null
          })
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Book → Volume → Leaf →（Paper / RepairOrder）＋ Volume → Binding */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    },
    {
      id: 'book_04',
      title: '淮南鸿烈解',
      edition: '明嘉靖刻本',
      era: '明',
      volumeCount: 1,
      collectionNo: '（外单位送修）',
      level: 'second',
      createdAt: now - day * 14,
      updatedAt: now - day * 1
    }
  ]

  const volumes: Volume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, bindingType: 'thread', state: 'repairing', consignNo: null, ownerUnit: null, createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, bindingType: 'wrapped', state: 'pending', consignNo: null, ownerUnit: null, createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, bindingType: 'thread', state: 'archived', consignNo: null, ownerUnit: null, createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, bindingType: 'butterfly', state: 'archived', consignNo: null, ownerUnit: null, createdAt: now - day * 55, updatedAt: now - day * 5 },
    // 外单位送修册：市图书馆送修 SX-2026-017 第 1 册，已对上并挂送修标记
    { id: 'vol_0401', bookId: 'book_04', volumeNo: 1, leafCount: 16, bindingType: 'thread', state: 'repairing', consignNo: 'SX-2026-017', ownerUnit: '市图书馆特藏部', createdAt: now - day * 14, updatedAt: now - day * 1 }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', createdAt: now - day * 49, updatedAt: now - day * 6 },
    // 送修册书叶：破损与工序照旧登记，与送修单互不干扰
    { id: 'leaf_040101', volumeId: 'vol_0401', leafNo: 4, damageType: 'worm', damageAreaCm2: 8.3, phValue: 6.2, state: 'repairing', createdAt: now - day * 12, updatedAt: now - day * 2 },
    { id: 'leaf_040102', volumeId: 'vol_0401', leafNo: 9, damageType: 'stain', damageAreaCm2: 5.5, phValue: 6.6, state: 'pending', createdAt: now - day * 12, updatedAt: now - day * 4 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 },
    // 送修册工序（修复师照旧登记；改约送修单不会改动这些工序）
    { id: 'order_040101', leafId: 'leaf_040101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-09-25', state: 'doing', createdAt: now - day * 10, updatedAt: now - day * 2 },
    { id: 'order_040102', leafId: 'leaf_040101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '陆敏', date: '2026-09-29', state: 'todo', createdAt: now - day * 9, updatedAt: now - day * 9 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  /* ---------- 外单位送修演示（对方账本与本室账本物理分表） ---------- */
  // 市图书馆 SX-2026-017 第 1 册：初约竹纸 16 张，后改约追加到 24 张（晚到一份为现行约定）
  const consignManifests: ConsignManifest[] = [
    {
      id: `cmf_SX-2026-017_v1_bamboo_${now - day * 14}`,
      consignNo: 'SX-2026-017',
      volumeNo: 1,
      ownerUnit: '市图书馆特藏部',
      paperType: 'bamboo',
      agreedSheets: 16,
      receivedAt: now - day * 14,
      remark: '初约',
      createdAt: now - day * 14,
      updatedAt: now - day * 14
    },
    {
      id: `cmf_SX-2026-017_v1_bark_${now - day * 14}`,
      consignNo: 'SX-2026-017',
      volumeNo: 1,
      ownerUnit: '市图书馆特藏部',
      paperType: 'bark',
      agreedSheets: 8,
      receivedAt: now - day * 14,
      remark: '初约',
      createdAt: now - day * 14,
      updatedAt: now - day * 14
    },
    {
      id: `cmf_SX-2026-017_v1_bamboo_${now - day * 6}`,
      consignNo: 'SX-2026-017',
      volumeNo: 1,
      ownerUnit: '市图书馆特藏部',
      paperType: 'bamboo',
      agreedSheets: 24,
      receivedAt: now - day * 6,
      remark: '第一次改约（虫蛀面积超出预估，追加竹纸）',
      createdAt: now - day * 6,
      updatedAt: now - day * 6
    },
    // 县档案馆 SX-2026-021 第 2 册：本室尚无对应册次，挂待认领
    {
      id: `cmf_SX-2026-021_v2_xuan_${now - day * 3}`,
      consignNo: 'SX-2026-021',
      volumeNo: 2,
      ownerUnit: '县档案馆',
      paperType: 'xuan',
      agreedSheets: 10,
      receivedAt: now - day * 3,
      remark: '初约',
      createdAt: now - day * 3,
      updatedAt: now - day * 3
    }
  ]

  const consignIntakes: ConsignIntake[] = [
    {
      id: 'cit_SX-2026-017_v1',
      consignNo: 'SX-2026-017',
      volumeNo: 1,
      ownerUnit: '市图书馆特藏部',
      volumeId: 'vol_0401',
      state: 'matched',
      claimedAt: now - day * 13,
      createdAt: now - day * 14,
      updatedAt: now - day * 13
    },
    {
      id: 'cit_SX-2026-021_v2',
      consignNo: 'SX-2026-021',
      volumeNo: 2,
      ownerUnit: '县档案馆',
      volumeId: null,
      state: 'unclaimed',
      claimedAt: null,
      createdAt: now - day * 3,
      updatedAt: now - day * 3
    }
  ]

  // 领用：竹纸领 26 张（改约后约定 24，仍超 2 张待补办，卡验收）；皮纸 6 张（约定 8，不超）
  const paperRequisitions: PaperRequisition[] = [
    {
      id: 'req_vol_0401_bamboo',
      volumeId: 'vol_0401',
      paperType: 'bamboo',
      usedSheets: 26,
      date: '2026-09-30',
      note: '虫蛀补破领用，其中 2 张待补办手续',
      createdAt: now - day * 8,
      updatedAt: now - day * 1
    },
    {
      id: 'req_vol_0401_bark',
      volumeId: 'vol_0401',
      paperType: 'bark',
      usedSheets: 6,
      date: '2026-09-28',
      note: '托裱局部加固',
      createdAt: now - day * 8,
      updatedAt: now - day * 7
    }
  ]

  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.consignManifests,
      db.consignIntakes,
      db.paperRequisitions
    ],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.consignManifests.bulkPut(consignManifests)
      await db.consignIntakes.bulkPut(consignIntakes)
      await db.paperRequisitions.bulkPut(paperRequisitions)
    }
  )
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
  consignManifests: ConsignManifest[]
  consignIntakes: ConsignIntake[]
  paperRequisitions: PaperRequisition[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, consignManifests, consignIntakes, paperRequisitions] =
    await Promise.all([
      db.books.toArray(),
      db.volumes.toArray(),
      db.leaves.toArray(),
      db.papers.toArray(),
      db.repairOrders.toArray(),
      db.bindings.toArray(),
      db.consignManifests.toArray(),
      db.consignIntakes.toArray(),
      db.paperRequisitions.toArray()
    ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    consignManifests,
    consignIntakes,
    paperRequisitions
  }
}

/** 修复室原有的六张业务表集合（备份必须具备） */
const CORE_SNAPSHOT_KEYS = ['books', 'volumes', 'leaves', 'papers', 'repairOrders', 'bindings'] as const

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  for (const key of CORE_SNAPSHOT_KEYS) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  return ''
}

/** 旧版本备份导入时补齐 v3 集合与旧册次送修标记（旧数据一律按未送修） */
export function normalizeSnapshot(snapshot: RestoreSnapshot): RestoreSnapshot {
  const consignManifests = snapshot.consignManifests ?? []
  const consignIntakes = snapshot.consignIntakes ?? []
  const paperRequisitions = snapshot.paperRequisitions ?? []
  const volumes = snapshot.volumes.map((volume) => ({
    ...volume,
    consignNo: volume.consignNo ?? null,
    ownerUnit: volume.ownerUnit ?? null
  }))
  return { ...snapshot, volumes, consignManifests, consignIntakes, paperRequisitions }
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  const normalized = normalizeSnapshot(snapshot)
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.consignManifests,
      db.consignIntakes,
      db.paperRequisitions
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.consignManifests.clear(),
        db.consignIntakes.clear(),
        db.paperRequisitions.clear()
      ])
      await db.books.bulkPut(normalized.books)
      await db.volumes.bulkPut(normalized.volumes)
      await db.leaves.bulkPut(normalized.leaves)
      await db.papers.bulkPut(normalized.papers)
      await db.repairOrders.bulkPut(normalized.repairOrders)
      await db.bindings.bulkPut(normalized.bindings)
      await db.consignManifests.bulkPut(normalized.consignManifests)
      await db.consignIntakes.bulkPut(normalized.consignIntakes)
      await db.paperRequisitions.bulkPut(normalized.paperRequisitions)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.consignManifests,
      db.consignIntakes,
      db.paperRequisitions
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.consignManifests.clear(),
        db.consignIntakes.clear(),
        db.paperRequisitions.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, consignManifests, consignIntakes, paperRequisitions] =
    await Promise.all([
      db.books.count(),
      db.volumes.count(),
      db.leaves.count(),
      db.papers.count(),
      db.repairOrders.count(),
      db.bindings.count(),
      db.consignManifests.count(),
      db.consignIntakes.count(),
      db.paperRequisitions.count()
    ])
  return { books, volumes, leaves, papers, repairOrders, bindings, consignManifests, consignIntakes, paperRequisitions }
}

/**
 * 本侧册次消失时的对认处置：不删对认记录，只退回「待认领」并摘开本侧册次。
 * 外单位送修单（consignManifests）完全不动 —— 对方账本原样保留，可日后重新认领。
 */
async function detachIntakesForVolumes(volumeIds: string[]): Promise<void> {
  if (volumeIds.length === 0) return
  await db.consignIntakes
    .where('volumeId')
    .anyOf(volumeIds)
    .modify((intake) => {
      intake.state = 'unclaimed'
      intake.volumeId = null
      intake.claimedAt = null
      intake.updatedAt = Date.now()
    })
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 本侧领用；对上的送修册退回待认领 */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.consignIntakes, db.paperRequisitions],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
        await db.paperRequisitions.where('volumeId').anyOf(volumeIds).delete()
        await detachIntakesForVolumes(volumeIds)
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 本侧领用；对上的送修册退回待认领 */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.consignIntakes, db.paperRequisitions],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.paperRequisitions.where('volumeId').equals(volumeId).delete()
      await detachIntakesForVolumes([volumeId])
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}
