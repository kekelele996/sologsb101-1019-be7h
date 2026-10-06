/**
 * 送修对账核心规则的端到端断言（Node 运行，不依赖浏览器 / Dexie）：
 * 1. 初约 + 改约：晚到那份为有效约定；
 * 2. 领用超额拆分：额度内正常、超出挂起；后续领用继续按余量拆；
 * 3. 改约追加约定后，历史挂起在新约定够额时可补办入账（仍超额则拒绝）；
 * 4. 约定外纸种按 0 张处理，全额挂起；
 * 5. 非送修册一律正常；
 * 6. 有挂起即拦截验收；
 * 7. 来件 JSON 校验：缺编号 / 坏册次 / 坏纸种报错；数组形态也接受；重复 id 报错；
 * 8. 认不上的行通过分组可见（待认领由 UI 层 join 判定）。
 */
import {
  calcRequisition,
  effectiveLineOf,
  groupConsignments,
  hasPendingSupplement,
  parseConsignPacket,
  remainingOverflow,
  usageOf,
  type PaperUsage
} from '../src/utils/consignment'
import type { ConsignmentLine } from '../src/types/consignment'

let failures = 0
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

const now = Date.now()
function line(partial: Partial<ConsignmentLine> & Pick<ConsignmentLine, 'id' | 'sendNo' | 'volumeNo' | 'receivedAt' | 'revisionSeq'>): ConsignmentLine {
  return {
    ownerUnit: '甲馆',
    revision: partial.revisionSeq !== undefined && partial.revisionSeq >= 2 ? 'amendment' : 'initial',
    paperAllowances: [],
    note: '',
    createdAt: partial.receivedAt,
    updatedAt: partial.receivedAt,
    ...partial
  }
}

const lines: ConsignmentLine[] = [
  line({
    id: 'r1',
    sendNo: 'SX-1',
    volumeNo: 1,
    revisionSeq: 1,
    receivedAt: now - 10000,
    paperAllowances: [{ paperType: 'bamboo', agreedSheets: 20 }]
  }),
  line({
    id: 'r2',
    sendNo: 'SX-1',
    volumeNo: 1,
    revisionSeq: 2,
    receivedAt: now - 5000,
    paperAllowances: [{ paperType: 'bamboo', agreedSheets: 24 }]
  }),
  line({
    id: 'r1b',
    sendNo: 'SX-1',
    volumeNo: 2,
    revisionSeq: 1,
    receivedAt: now - 9000,
    paperAllowances: [{ paperType: 'bark', agreedSheets: 10 }]
  })
]

console.log('① 改约晚到那份为准')
const groups = groupConsignments(lines)
assert(groups.length === 2, `分组数应为 2，实际 ${groups.length}`)
const g1 = groups.find((g) => g.sendNo === 'SX-1' && g.volumeNo === 1)
assert(g1?.effective.id === 'r2', 'SX-1 第1册有效行是晚到的改约 r2（24 张）')
assert(g1?.lines.length === 2, '两批来件全部留痕（不覆盖）')
assert(effectiveLineOf(lines, 'SX-1', 1)?.id === 'r2', 'effectiveLineOf 选晚到行')

console.log('② 领用超额拆分')
const effective = g1!.effective
let prior: PaperUsage = { totalUsed: 0, pendingSheets: 0 }
const calc1 = calcRequisition({ effectiveLine: effective, paperType: 'bamboo', usedSheets: 20, priorUsage: prior })
assert(calc1.state === 'in_quota' && calc1.inQuotaSheets === 20 && calc1.pendingSheets === 0, '首笔 20 张全部在额度内')
prior = { totalUsed: 20, pendingSheets: 0 }
const calc2 = calcRequisition({ effectiveLine: effective, paperType: 'bamboo', usedSheets: 6, priorUsage: prior })
assert(calc2.state === 'pending_supplement' && calc2.inQuotaSheets === 4 && calc2.pendingSheets === 2, '第二笔 6 张：4 张正常 + 2 张挂起')
assert(calc2.basisLineId === 'r2' && calc2.basisAgreedSheets === 24, '落账依据指向改约行 r2 / 24 张')

console.log('③ 改约追加后补办入账')
// 模拟改约前两笔领用后的台账
const reqs = [
  { volumeId: 'v1', paperType: 'bamboo' as const, usedSheets: 20, pendingSheets: 0, state: 'in_quota' },
  { volumeId: 'v1', paperType: 'bamboo' as const, usedSheets: 6, pendingSheets: 2, state: 'pending_supplement' }
]
assert(hasPendingSupplement(reqs, 'v1'), '有挂起 → 验收被拦截')
// 当前约定 24：累计 26，仍超 2
assert(remainingOverflow(24, reqs, 'v1', 'bamboo') === 2, '约定 24 / 已用 26：仍超额 2 张，拒绝补办')
// 再来一份改约 26：无超额，可补办
assert(remainingOverflow(26, reqs, 'v1', 'bamboo') === 0, '改约到 26：超额被吸收，可补办入账')
const r3 = line({
  id: 'r3',
  sendNo: 'SX-1',
  volumeNo: 1,
  revisionSeq: 3,
  receivedAt: now - 1000,
  paperAllowances: [{ paperType: 'bamboo', agreedSheets: 26 }]
})
assert(effectiveLineOf([...lines, r3], 'SX-1', 1)?.id === 'r3', '第三批晚到 → 自动成为有效约定')

console.log('④ 约定外纸种按 0 张')
const calcXuan = calcRequisition({
  effectiveLine: r3,
  paperType: 'xuan',
  usedSheets: 3,
  priorUsage: { totalUsed: 0, pendingSheets: 0 }
})
assert(calcXuan.state === 'pending_supplement' && calcXuan.pendingSheets === 3, '约定没有宣纸：3 张全部挂起')

console.log('⑤ 非送修册不校验')
const calcSelf = calcRequisition({ paperType: 'bamboo', usedSheets: 999, priorUsage: { totalUsed: 0, pendingSheets: 0 } })
assert(calcSelf.state === 'in_quota' && calcSelf.inQuotaSheets === 999 && calcSelf.basisAgreedSheets === null, '自修册领用无约定约束')
assert(!hasPendingSupplement([], 'v2'), '无台账 → 不拦截验收')

console.log('⑥ usageOf 汇总（已补办行不计挂起）')
const mixed = [
  { volumeId: 'v1', paperType: 'bamboo' as const, usedSheets: 20, pendingSheets: 0, state: 'in_quota' },
  { volumeId: 'v1', paperType: 'bamboo' as const, usedSheets: 6, pendingSheets: 2, state: 'pending_supplement' },
  { volumeId: 'v1', paperType: 'xuan' as const, usedSheets: 5, pendingSheets: 1, state: 'supplemented' }
]
const usage = usageOf(mixed, 'v1', 'bamboo')
assert(usage.totalUsed === 26 && usage.pendingSheets === 2, '竹纸累计 26 张、挂起 2 张；宣纸行不串纸种')

console.log('⑦ 来件校验')
const fallback = now
assert(parseConsignPacket({}, fallback).error.includes('来件应为'), '空对象报错')
assert(parseConsignPacket([], fallback).error.includes('没有任何送修行'), '空数组报错')
assert(parseConsignPacket([{ sendNo: 'X', volumeNo: 0, paperAllowances: [] }], fallback).error.includes('正整数'), '册次 0 报错')
assert(
  parseConsignPacket([{ sendNo: 'X', volumeNo: 1, paperAllowances: [{ paperType: 'rice', agreedSheets: 1 }] }], fallback).error
    .includes('bamboo / bark / xuan'),
  '非法纸种报错'
)
assert(
  parseConsignPacket([{ sendNo: 'X', volumeNo: 1, paperAllowances: [{ paperType: 'bamboo', agreedSheets: -1 }] }], fallback).error
    .includes('不能为负'),
  '负张数报错'
)
const okArray = parseConsignPacket(
  [{ sendNo: 'SX-9', volumeNo: 3, revisionSeq: 2, paperAllowances: [{ paperType: 'bark', agreedSheets: 6 }] }],
  fallback
)
assert(okArray.error === '' && okArray.packet?.lines.length === 1, '数组形态合法')
assert(okArray.packet?.lines[0]?.revision === 'amendment', 'revisionSeq=2 推导为改约')
assert((okArray.packet?.lines[0]?.id ?? '').startsWith('ext_SX-9_3_r2'), '缺省 id 形如 ext_<编号>_<册次>_r<批次>')
const dup = parseConsignPacket(
  [
    { id: 'same', sendNo: 'X', volumeNo: 1, paperAllowances: [] },
    { id: 'same', sendNo: 'Y', volumeNo: 2, paperAllowances: [] }
  ],
  fallback
)
assert(dup.error.includes('重复'), '同包重复 id 报错')
const objForm = parseConsignPacket({ receivedAt: 123, lines: [{ sendNo: 'Z', volumeNo: 1, paperAllowances: [] }] }, fallback)
assert(objForm.error === '' && objForm.packet?.receivedAt === 123 && objForm.packet.lines[0]?.receivedAt === 123, '对象形态采用包级 receivedAt')

console.log('⑧ SX-1 第 2 册无链接时由 UI 判为待认领（纯数据层可检出该组）')
assert(groups.some((g) => g.sendNo === 'SX-1' && g.volumeNo === 2), '认不上的来件行仍在分组中，等待人工认领')

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
