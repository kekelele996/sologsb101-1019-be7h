/**
 * IndexedDB（fake-indexeddb）集成验证：
 * A. v2 旧库升级 v3：旧 volume 保留、无对账关系 → 按未送修显示；旧 paper 的 dyeRecipe 不丢；
 * B. 全新库播种：送修三表有演示数据；
 * C. 送修单接收只追加：同 id 重发幂等；
 * D. 本侧写失败（故障注入）→ 死信，送修单表数据原样不动；
 * E. 死信重放成功后本侧恢复、送修单仍不动；
 * F. 删册次级联：本侧领用 / 对账关系清掉，送修单保留（回待认领）。
 */
import 'fake-indexeddb/auto'
import Dexie, { type Table } from 'dexie'
import {
  DB_NAME,
  db,
  initDatabase,
  removeVolumeCascade
} from '../src/utils/db'
import { setActivePinia, createPinia } from 'pinia'
import { useConsignStore } from '../src/stores/consignStore'
import { armNextLocalFailure } from '../src/utils/localRetry'
import type { Volume } from '../src/types/volume'
import type { Paper } from '../src/types/paper'
import type { ConsignmentLine } from '../src/types/consignment'

let failures = 0
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

async function freshDb(name: string, version: number, volumes: Volume[], papers: Paper[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  const old = new Dexie(name)
  old.version(1).stores({
    books: 'id, title, era, level, updatedAt',
    volumes: 'id, bookId, volumeNo, state, updatedAt',
    leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
    papers: 'id, leafId, paperType, deltaE, updatedAt',
    repairOrders: 'id, leafId, seq, name, state, updatedAt',
    bindings: 'id, volumeId, verdict, finishDate, updatedAt'
  })
  old.version(2).stores({
    books: 'id, title, era, level, collectionNo, updatedAt',
    volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
    leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
    papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
    repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
    bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
  })
  await old.open()
  await old.table('volumes').bulkAdd(volumes)
  await old.table('papers').bulkAdd(papers)
  await old.close()
}

async function main(): Promise<void> {
  console.log('A. v2 旧库升级 v3：旧数据原样、按未送修显示')
  {
    await freshDb(DB_NAME, 2, [
      { id: 'old_vol_1', bookId: 'old_book_1', volumeNo: 1, leafCount: 3, bindingType: 'thread', state: 'pending', createdAt: 1, updatedAt: 1 }
    ] as Volume[], [
      { id: 'old_paper_1', leafId: 'old_leaf_1', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.2, dyeRecipe: '旧配方留存', createdAt: 1, updatedAt: 1 }
    ] as Paper[])

    // 以 v3 结构打开同一库（db 是单例，首次打开触发升级；无 books → 但 books 非空，故不播种）
    await db.open()
    const vol = await db.volumes.get('old_vol_1')
    assert(Boolean(vol), '旧库 volume 升级后仍在')
    const paper = await db.papers.get('old_paper_1')
    assert(paper?.dyeRecipe === '旧配方留存', '旧 paper 的 dyeRecipe 未被破坏')
    const links = await db.consignLinks.where('volumeId').equals('old_vol_1').count()
    assert(links === 0, '旧册次没有对账关系 → 按未送修显示')
    assert((await db.consignments.count()) === 0, '升级不凭空生成送修单')

    // 清空，给 B 准备全新环境
    await Promise.all([
      db.books.clear(),
      db.volumes.clear(),
      db.leaves.clear(),
      db.papers.clear(),
      db.repairOrders.clear(),
      db.bindings.clear(),
      db.consignments.clear(),
      db.consignLinks.clear(),
      db.paperRequisitions.clear()
    ])
    await db.close()
  }

  console.log('B. 全新库播种含送修数据')
  {
    await initDatabase()
    assert((await db.consignments.count()) === 5, '播种 5 条送修批次（含初约 / 改约 / 待认领）')
    assert((await db.consignLinks.count()) === 2, '播种 2 条本侧对账关系')
    assert((await db.paperRequisitions.count()) === 3, '播种 3 笔补纸领用')
  }

  setActivePinia(createPinia())
  const store = useConsignStore()
  await store.loadAll()

  console.log('C. 接收来件只追加 + 幂等')
  {
    const before = store.consignments.length
    const r = await store.receivePacket({
      lines: [
        { sendNo: 'SX-T-1', volumeNo: 1, revisionSeq: 1, paperAllowances: [{ paperType: 'bark', agreedSheets: 9 }] }
      ]
    })
    assert(r.ok && r.inserted === 1, `新批次入库（${r.message}）`)
    assert(store.consignments.length === before + 1, '送修表新增 1 条')
    const again = await store.receivePacket({
      lines: [
        { id: 'ext_SX-T-1_1_r1', sendNo: 'SX-T-1', volumeNo: 1, revisionSeq: 1, paperAllowances: [{ paperType: 'bark', agreedSheets: 9 }] }
      ]
    })
    assert(again.ok && again.inserted === 0, '同一批次重发幂等跳过，不改写')
    // 改约晚到
    const amend = await store.receivePacket({
      lines: [
        { sendNo: 'SX-T-1', volumeNo: 1, revisionSeq: 2, receivedAt: Date.now() + 5000, paperAllowances: [{ paperType: 'bark', agreedSheets: 12 }] }
      ]
    })
    assert(amend.ok && amend.inserted === 1, '改约批次追加（不覆盖初约）')
    const eff = store.groupOf('SX-T-1', 1)?.effective
    assert(eff?.revisionSeq === 2 && eff.paperAllowances[0]?.agreedSheets === 12, '有效约定取晚到的改约（12 张）')
    assert(store.consignments.filter((l) => l.sendNo === 'SX-T-1').length === 2, '初约与改约两条都在')
  }

  console.log('D. 本侧写失败 → 死信；送修单原样')
  {
    const group = store.groupOf('SX-T-1', 1)
    assert(group && store.pendingClaimGroups.some((g) => g.sendNo === 'SX-T-1'), '认上前该行待认领')
    // 制造一个本侧可认领的新册次（直接放本侧 volumes 表）
    await db.volumes.put({
      id: 'vol_test_1',
      bookId: 'book_01',
      volumeNo: 99,
      leafCount: 1,
      bindingType: 'thread',
      state: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    armNextLocalFailure()
    const failed = await store.linkVolume('SX-T-1', 1, 'vol_test_1')
    assert(!failed.ok && failed.message.includes('死信'), `本侧写失败落死信：${failed.message}`)
    assert(store.links.every((l) => l.volumeId !== 'vol_test_1'), '对账关系未挂上（写失败）')
    assert(store.deadLetters.length === 1, '死信队列 1 条')
    const consignRows = await db.consignments.where('sendNo').equals('SX-T-1').count()
    assert(consignRows === 2, '送修单 2 行原样未动（本侧失败不影响来件）')
  }

  console.log('E. 死信重放 → 本侧恢复，送修单仍不动')
  {
    const letter = store.deadLetters[0]
    assert(Boolean(letter), '取到死信')
    const retry = await store.retryDeadLetter(letter!.id)
    assert(retry.ok, `重放成功：${retry.message}`)
    assert(store.links.some((l) => l.volumeId === 'vol_test_1'), '对账关系已补上，册次挂送修标记')
    assert(store.isConsignedVolume('vol_test_1'), 'isConsignedVolume 为真')
    assert(store.deadLetters.length === 0, '死信已清空')
    assert((await db.consignments.where('sendNo').equals('SX-T-1').count()) === 2, '送修单仍是 2 行')
  }

  console.log('F. 领用超额挂起 + 改约后补办 + 删册次级联')
  {
    // 有效约定皮纸 12，领 15 → 12 正常 + 3 挂起
    let r = await store.registerRequisition({ volumeId: 'vol_test_1', paperType: 'bark', usedSheets: 15, operator: '测试员' })
    assert(r.ok && r.message.includes('挂起'), `超额领用挂起：${r.message}`)
    assert(store.volumeBlockedForAcceptance('vol_test_1'), '该册被验收拦截')
    const pendingRow = store.requisitionsOfVolume('vol_test_1').find((x) => x.state === 'pending_supplement')
    assert(pendingRow?.pendingSheets === 3 && pendingRow.inQuotaSheets === 12, '拆成 12 正常 / 3 挂起')
    // 约定仍 12 → 补办被拒
    const denied = await store.supplementRequisition(pendingRow!.id)
    assert(!denied.ok && denied.message.includes('仍有 3 张超额'), '未追加约定时拒绝补办入账')
    // 改约到 16 → 可补办
    await store.receivePacket({
      lines: [
        { sendNo: 'SX-T-1', volumeNo: 1, revisionSeq: 3, receivedAt: Date.now() + 9000, paperAllowances: [{ paperType: 'bark', agreedSheets: 16 }] }
      ]
    })
    const ok = await store.supplementRequisition(pendingRow!.id)
    assert(ok.ok, `改约够额后补办入账：${ok.message}`)
    assert(!store.volumeBlockedForAcceptance('vol_test_1'), '补办后解除验收拦截')

    // 删册次：本侧领用 / 关系清，送修单保留
    await removeVolumeCascade('vol_test_1')
    await store.loadAll()
    assert(store.requisitionsOfVolume('vol_test_1').length === 0, '册次删除后本侧领用级联清除')
    assert(store.links.every((l) => l.volumeId !== 'vol_test_1'), '本侧对账关系级联清除')
    const g = store.groupOf('SX-T-1', 1)
    assert(Boolean(g), '送修单仍在，该行回到待认领')
    assert(!store.links.some((l) => l.sendNo === 'SX-T-1' && l.volumeNo === 1), '待认领（无链接）')
  }

  if (failures > 0) {
    console.error(`\n${failures} 条断言失败`)
    process.exit(1)
  }
  console.log('\n全部集成断言通过')
}

void main()
