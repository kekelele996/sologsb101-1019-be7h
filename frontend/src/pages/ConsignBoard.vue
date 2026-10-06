<script setup lang="ts">
/**
 * /consigns 送修对账与补纸领用
 * 藏书单位与修复室各管各的、人工对账：
 * 1. 接收来件（JSON 对账单 / 手工登记批次，含初约与改约），来件只追加、晚到那份为准；
 * 2. 凭送修编号 + 册次号认本侧册次，对上的册挂送修标记，认不上的挂待认领；
 * 3. 补纸领用按有效约定测算，超额部分挂起待补办、不许并进验收，改约够额后可补办入账；
 * 4. 本侧写库失败只重试本侧（死信队列可人工重放），送修单原样不动。
 * 消费 ConsignmentLine / ConsignLink / PaperRequisition 及 Volume / Leaf；
 * 复用 <StatBadge>、<EmptyPanel>、<ConsignTag>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Connection,
  Download,
  RefreshRight,
  Remove,
  ScaleToOriginal,
  Upload,
  Warning
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import ConsignTag from '@/components/common/ConsignTag.vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useConsignStore } from '@/stores/consignStore'
import {
  CONSIGN_LINE_STATUS_COLOR,
  CONSIGN_LINE_STATUS_LABEL,
  CONSIGN_REVISION_COLOR,
  CONSIGN_REVISION_LABEL,
  createEmptyConsignLineDraft,
  formatAllowances,
  revisionKindOf,
  type ConsignLineDraft
} from '@/types/consignment'
import { PAPER_TYPE_LABEL, PAPER_TYPE_OPTIONS, type PaperType } from '@/types/paper'
import { REQUISITION_STATE_COLOR, REQUISITION_STATE_LABEL } from '@/types/paperRequisition'
import { agreedSheetsOf, usageOf, type ConsignGroup } from '@/utils/consignment'
import { armNextLocalFailure } from '@/utils/localRetry'
import { download } from '@/utils/export'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const consignStore = useConsignStore()

/* ------------------------------ 通用展示 ------------------------------ */

function groupStatus(group: ConsignGroup): 'matched' | 'pending_claim' {
  return consignStore.links.some((link) => link.sendNo === group.sendNo && link.volumeNo === group.volumeNo)
    ? 'matched'
    : 'pending_claim'
}

function linkedVolumeId(group: ConsignGroup): string | undefined {
  return consignStore.links.find((link) => link.sendNo === group.sendNo && link.volumeNo === group.volumeNo)?.volumeId
}

function groupVolumeLabel(group: ConsignGroup): string {
  const volumeId = linkedVolumeId(group)
  if (!volumeId) return '—'
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '本侧册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

function allowanceText(group: ConsignGroup): string {
  return formatAllowances(group.effective.paperAllowances, PAPER_TYPE_LABEL)
}

function revisionColor(kind: keyof typeof CONSIGN_REVISION_LABEL): string {
  return CONSIGN_REVISION_COLOR[kind]
}

function revisionText(seq: number): string {
  return CONSIGN_REVISION_LABEL[revisionKindOf(seq)]
}

function statusColor(status: 'matched' | 'pending_claim'): string {
  return CONSIGN_LINE_STATUS_COLOR[status]
}

function statusText(status: 'matched' | 'pending_claim'): string {
  return CONSIGN_LINE_STATUS_LABEL[status]
}

function requisitionColor(state: string): string {
  return REQUISITION_STATE_COLOR[state as keyof typeof REQUISITION_STATE_COLOR] ?? '#6b6257'
}

function requisitionText(state: string): string {
  return REQUISITION_STATE_LABEL[state as keyof typeof REQUISITION_STATE_LABEL] ?? state
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function volumeLabelById(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

function leafLabel(leafId: string): string {
  if (!leafId) return '整册领用'
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  return `第 ${leaf.leafNo} 叶`
}

const stats = computed(() => ({
  groups: consignStore.groups.length,
  pendingClaim: consignStore.pendingClaimCount,
  matched: consignStore.matchedGroups.length,
  pendingSupplement: consignStore.pendingSupplementCount,
  deadLetters: consignStore.deadLetters.length
}))

/* ------------------------------ 认领（对账） ------------------------------ */

const linkChoices = reactive<Record<string, string>>({})

/** 认领下拉：只允许选择尚未挂送修标记的本侧册次 */
const unlinkedVolumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore
      .volumesOfBook(book.id)
      .filter((volume) => !consignStore.isConsignedVolume(volume.id))
      .map((volume) => ({
        value: volume.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册（本侧叶数 ${volume.leafCount}）`
      }))
  )
)

async function confirmLink(group: ConsignGroup): Promise<void> {
  const volumeId = linkChoices[group.effective.id] ?? ''
  if (!volumeId) {
    ElMessage.warning('请先选择要认上的本侧册次')
    return
  }
  const result = await consignStore.linkVolume(group.sendNo, group.volumeNo, volumeId)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.error(result.message)
}

async function confirmUnlink(group: ConsignGroup): Promise<void> {
  const link = consignStore.links.find((item) => item.sendNo === group.sendNo && item.volumeNo === group.volumeNo)
  if (!link) return
  try {
    await ElMessageBox.confirm(
      `取消后 ${link.sendNo} 第 ${link.volumeNo} 册回到「待认领」，仅删除本侧对账关系，送修单原样保留。`,
      '取消本侧对账',
      { type: 'warning', confirmButtonText: '确认取消对账', cancelButtonText: '再想想' }
    )
  } catch {
    return
  }
  const result = await consignStore.unlink(link.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.error(result.message)
}

/* ------------------------------ 补纸领用 ------------------------------ */

const reqVolumeId = ref('')

const reqVolumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => {
      const link = consignStore.linkOfVolume(volume.id)
      return {
        value: volume.id,
        label: `${book.title} 第 ${volume.volumeNo} 册${link ? ` · 送修 ${link.sendNo}` : ' · 本馆自修'}`
      }
    })
  )
)

const reqLeafOptions = computed(() => {
  if (!reqVolumeId.value) return []
  return leafStore.leavesOfVolume(reqVolumeId.value).map((leaf) => ({
    value: leaf.id,
    label: `第 ${leaf.leafNo} 叶`
  }))
})

const reqForm = reactive({
  leafId: '',
  paperType: 'bamboo' as PaperType,
  usedSheets: 1,
  operator: '',
  date: new Date().toISOString().slice(0, 10),
  note: ''
})

const effectiveLine = computed(() => (reqVolumeId.value ? consignStore.effectiveLineForVolume(reqVolumeId.value) : undefined))

/** 落账前的实时测算预览 */
const reqPreview = computed(() => {
  if (!reqVolumeId.value) return null
  const used = Math.max(0, Math.floor(reqForm.usedSheets) || 0)
  const line = effectiveLine.value
  if (!line) {
    return { agreed: null, usedTotal: used, inQuota: used, pending: 0, isConsigned: false }
  }
  const agreed = agreedSheetsOf(line, reqForm.paperType)
  const prior = usageOf(consignStore.requisitions, reqVolumeId.value, reqForm.paperType)
  const remaining = Math.max(0, agreed - prior.totalUsed)
  const inQuota = Math.min(used, remaining)
  return {
    agreed,
    usedTotal: prior.totalUsed + used,
    inQuota,
    pending: used - inQuota,
    isConsigned: true
  }
})

async function submitRequisition(): Promise<void> {
  if (!reqVolumeId.value) {
    ElMessage.warning('请选择册次')
    return
  }
  const result = await consignStore.registerRequisition({
    volumeId: reqVolumeId.value,
    leafId: reqForm.leafId,
    paperType: reqForm.paperType,
    usedSheets: reqForm.usedSheets,
    operator: reqForm.operator,
    date: reqForm.date,
    note: reqForm.note
  })
  if (result.ok) {
    ElMessage[result.message.includes('挂起') ? 'warning' : 'success'](result.message)
    reqForm.usedSheets = 1
    reqForm.note = ''
  } else {
    ElMessage.error(result.message)
  }
}

async function supplement(row: { id: string }): Promise<void> {
  const result = await consignStore.supplementRequisition(row.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

async function removeRequisition(row: { id: string }): Promise<void> {
  try {
    await ElMessageBox.confirm('仅删除本侧这笔领用台账，送修单不受影响。', '删除领用记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await consignStore.removeRequisition(row.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.error(result.message)
}

/* ------------------------------ 来件接收 ------------------------------ */

const packetDialog = ref(false)
const packetText = ref('')
const receiving = ref(false)

const samplePacket = `{
  "lines": [
    {
      "id": "ext_demo_001_3_r1",
      "sendNo": "SX-2026-099",
      "volumeNo": 3,
      "ownerUnit": "丙府文保所",
      "revisionSeq": 2,
      "paperAllowances": [
        { "paperType": "bamboo", "agreedSheets": 30 },
        { "paperType": "bark", "agreedSheets": 6 }
      ],
      "note": "改约样例：可把 revisionSeq 调大后再次接收，晚到那份自动成为有效约定"
    }
  ]
}`

function openPacketDialog(): void {
  packetText.value = samplePacket
  packetDialog.value = true
}

function downloadTemplate(): void {
  download('consign-packet-template.json', samplePacket, 'application/json;charset=utf-8')
}

async function submitPacket(): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(packetText.value)
  } catch {
    ElMessage.error('JSON 解析失败，请检查对账单格式')
    return
  }
  receiving.value = true
  try {
    const result = await consignStore.receivePacket(parsed)
    if (!result.ok) {
      ElMessage.error(result.message)
      return
    }
    ElMessage.success(result.message)
    packetDialog.value = false
  } finally {
    receiving.value = false
  }
}

const manualDialog = ref(false)
const manualForm = reactive<ConsignLineDraft>(createEmptyConsignLineDraft())

function openManual(): void {
  Object.assign(manualForm, createEmptyConsignLineDraft())
  manualDialog.value = false
  manualDialog.value = true
}

function addAllowance(): void {
  const types: PaperType[] = ['bamboo', 'bark', 'xuan']
  const used = new Set(manualForm.paperAllowances.map((item) => item.paperType))
  const nextType = types.find((type) => !used.has(type))
  if (!nextType) {
    ElMessage.info('竹纸 / 皮纸 / 宣纸都已添加')
    return
  }
  manualForm.paperAllowances.push({ paperType: nextType, agreedSheets: 0 })
}

function removeAllowance(index: number): void {
  manualForm.paperAllowances.splice(index, 1)
}

async function submitManual(): Promise<void> {
  const result = await consignStore.receiveManual({ ...manualForm })
  if (!result.ok) {
    ElMessage.error(result.message)
    return
  }
  ElMessage.success(result.message)
  manualDialog.value = false
}

/* ------------------------------ 死信与故障演练 ------------------------------ */

async function retryLetter(letter: { id: string }): Promise<void> {
  const result = await consignStore.retryDeadLetter(letter.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.error(result.message)
}

async function dismissLetter(letter: { id: string }): Promise<void> {
  await consignStore.dismissDeadLetter(letter.id)
}

function armFailure(): void {
  armNextLocalFailure()
  ElMessage.warning('已演练：下一次本侧写入（认领 / 领用 / 补办）将失败并重试，最终进入死信队列；送修单不受影响')
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>送修对账与补纸领用</h2>
        <p>
          藏书单位管送修编号与约定纸种张数，修复室管册次、书叶与工序；凭送修编号 +
          册次号人工对账。改约以晚到那份为准，超额领用挂起待补办，不许并进验收。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Upload" @click="openPacketDialog">接收对账单</el-button>
        <el-button type="primary" :icon="Download" @click="openManual">登记来件批次</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="送修册次（有效行）" :value="stats.groups" suffix="册" tone="primary" />
      <StatBadge label="待认领" :value="stats.pendingClaim" suffix="册" tone="danger" :icon="'WarningFilled'" />
      <StatBadge label="已对上" :value="stats.matched" suffix="册" tone="success" />
      <StatBadge label="挂起待补办领用" :value="stats.pendingSupplement" suffix="笔" tone="warning" />
      <StatBadge label="本侧失败待重试" :value="stats.deadLetters" suffix="条" tone="info" />
    </div>

    <!-- 待认领优先提示 -->
    <el-alert
      v-if="stats.pendingClaim > 0"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 16px"
      :title="`有 ${stats.pendingClaim} 册送修单认不上本侧册次，先挂待认领，不得并进验收`"
    >
      <template #default>
        认不上的送修行：
        <span v-for="group in consignStore.pendingClaimGroups" :key="group.effective.id" style="margin-right: 12px">
          <ConsignTag status="pending_claim" :send-no="group.sendNo" :volume-no="group.volumeNo" size="small" />
        </span>
      </template>
    </el-alert>

    <el-row :gutter="16">
      <!-- 左：对账 -->
      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>送修册次对账（初约 / 改约全部留痕）</span>
              <el-tag type="info" effect="plain" round>共 {{ stats.groups }} 册</el-tag>
            </div>
          </template>

          <EmptyPanel
            v-if="consignStore.groups.length === 0"
            title="还没有收到任何送修单"
            description="点右上「接收对账单」导入藏书单位来件，或手工登记来件批次；修复室只接收不改写。"
            action-text="接收对账单"
            size="small"
            @action="openPacketDialog"
          />

          <el-table v-else :data="consignStore.groups" size="small" border>
            <el-table-column label="送修编号 / 状态" min-width="170">
              <template #default="{ row }">
                <div style="display: flex; flex-direction: column; gap: 4px">
                  <strong>{{ row.sendNo }}</strong>
                  <el-tag
                    :style="{ color: statusColor(groupStatus(row)), borderColor: `${statusColor(groupStatus(row))}66` }"
                    effect="plain"
                    size="small"
                    round
                  >
                    {{ statusText(groupStatus(row)) }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="volumeNo" label="册次" width="60" />
            <el-table-column prop="ownerUnit" label="藏书单位" min-width="110" />
            <el-table-column label="当前有效约定（晚到那份）" min-width="190">
              <template #default="{ row }">
                <div>{{ allowanceText(row) }}</div>
                <div class="gb-muted">
                  <el-tag
                    :style="{ color: revisionColor(row.effective.revision), borderColor: `${revisionColor(row.effective.revision)}66` }"
                    effect="plain"
                    size="small"
                    round
                  >
                    第 {{ row.effective.revisionSeq }} 批 · {{ revisionText(row.effective.revisionSeq) }}
                  </el-tag>
                  收到于 {{ formatTime(row.effective.receivedAt) }}
                </div>
              </template>
            </el-table-column>
            <el-table-column label="本侧册次" min-width="160">
              <template #default="{ row }">
                <ConsignTag
                  v-if="groupStatus(row) === 'matched'"
                  :send-no="row.sendNo"
                  :volume-no="row.volumeNo"
                  size="small"
                />
                <div style="margin-top: 4px">{{ groupVolumeLabel(row) }}</div>
              </template>
            </el-table-column>
            <el-table-column label="人工对账" width="270">
              <template #default="{ row }">
                <template v-if="groupStatus(row) === 'pending_claim'">
                  <el-select
                    v-model="linkChoices[row.effective.id]"
                    placeholder="选择本侧册次"
                    size="small"
                    filterable
                    style="width: 100%; margin-bottom: 4px"
                  >
                    <el-option
                      v-for="option in unlinkedVolumeOptions"
                      :key="option.value"
                      :label="option.label"
                      :value="option.value"
                    />
                  </el-select>
                  <el-button size="small" type="primary" :icon="Connection" @click="confirmLink(row)">认上此册</el-button>
                </template>
                <div v-else>
                  <el-button size="small" text type="danger" :icon="Remove" @click="confirmUnlink(row)">取消对账</el-button>
                  <el-button
                    v-if="consignStore.volumeBlockedForAcceptance(linkedVolumeId(row) ?? '')"
                    size="small"
                    text
                    type="warning"
                    :icon="Warning"
                    disabled
                  >
                    验收拦截
                  </el-button>
                </div>
              </template>
            </el-table-column>

            <el-table-column type="expand">
              <template #default="{ row }">
                <div style="padding: 6px 12px">
                  <div class="gb-muted" style="margin-bottom: 6px">来件批次记录（同键晚到者为有效约定，本侧不回改）：</div>
                  <el-table :data="row.lines" size="small" border>
                    <el-table-column label="批次" width="110">
                      <template #default="{ row: line }">
                        <el-tag
                          :style="{ color: revisionColor(line.revision), borderColor: `${revisionColor(line.revision)}66` }"
                          effect="plain"
                          size="small"
                          round
                        >
                          {{ revisionText(line.revisionSeq) }} #{{ line.revisionSeq }}
                        </el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column label="约定补纸" min-width="180">
                      <template #default="{ row: line }">{{ formatAllowances(line.paperAllowances, PAPER_TYPE_LABEL) }}</template>
                    </el-table-column>
                    <el-table-column label="收到时刻" width="180">
                      <template #default="{ row: line }">{{ formatTime(line.receivedAt) }}</template>
                    </el-table-column>
                    <el-table-column prop="note" label="备注" min-width="160" />
                  </el-table>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- 死信 -->
        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>本侧写库失败 · 死信队列（只重试本侧，送修单原样不动）</span>
              <el-button size="small" plain :icon="ScaleToOriginal" @click="armFailure">故障演练：下一次本侧写失败</el-button>
            </div>
          </template>
          <EmptyPanel
            v-if="consignStore.deadLetters.length === 0"
            title="没有待重试的本侧失败操作"
            description="本侧三张表写入失败时会立即重试 3 次，仍失败才进入这里，可人工重放；送修单从不参与本侧重试。"
            size="small"
          />
          <el-table v-else :data="consignStore.deadLetters" size="small" border>
            <el-table-column prop="description" label="失败的本侧操作" min-width="220" />
            <el-table-column prop="table" label="本侧表" width="150" />
            <el-table-column prop="attempts" label="已尝试" width="80" />
            <el-table-column prop="lastError" label="错误" min-width="160" />
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <el-button size="small" type="primary" :icon="RefreshRight" @click="retryLetter(row)">重试本侧</el-button>
                <el-button size="small" text @click="dismissLetter(row)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <!-- 右：补纸领用 -->
      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>补纸领用登记</template>
          <el-form label-width="92px">
            <el-form-item label="册次" required>
              <el-select v-model="reqVolumeId" placeholder="选择本侧册次" filterable style="width: 100%">
                <el-option v-for="option in reqVolumeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="用途书叶">
              <el-select v-model="reqForm.leafId" clearable placeholder="整册通用可不选" style="width: 100%">
                <el-option v-for="option in reqLeafOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="纸种">
              <el-radio-group v-model="reqForm.paperType">
                <el-radio-button v-for="option in PAPER_TYPE_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="领用张数">
              <el-input-number v-model="reqForm.usedSheets" :min="1" :max="9999" />
            </el-form-item>
            <el-form-item label="领用人">
              <el-input v-model="reqForm.operator" placeholder="如：沈玉" />
            </el-form-item>
            <el-form-item label="日期">
              <el-input v-model="reqForm.date" type="date" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="reqForm.note" type="textarea" :rows="2" />
            </el-form-item>
          </el-form>

          <el-alert
            v-if="reqPreview"
            :type="reqPreview.pending > 0 ? 'error' : 'success'"
            show-icon
            :closable="false"
            style="margin: 4px 0 12px"
          >
            <template #title>
              <template v-if="!reqPreview.isConsigned">
                本馆自修册：不做约定校验，本次 {{ reqForm.usedSheets }} 张全部正常领用
              </template>
              <template v-else>
                有效约定 {{ PAPER_TYPE_LABEL[reqForm.paperType] }} {{ reqPreview.agreed }}
                张；本次额度内 {{ reqPreview.pending > 0 ? reqPreview.inQuota : reqForm.usedSheets }} 张
                <strong v-if="reqPreview.pending > 0" style="color: #b03a2e">
                  ，超出 {{ reqPreview.pending }} 张挂起待补办，不许并进验收
                </strong>
              </template>
            </template>
          </el-alert>

          <el-button type="primary" style="width: 100%" :icon="Download" @click="submitRequisition">登记领用</el-button>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>领用台账（超额挂起 / 改约补办）</span>
              <el-tag type="info" effect="plain" round>{{ consignStore.requisitions.length }} 笔</el-tag>
            </div>
          </template>
          <EmptyPanel
            v-if="consignStore.requisitions.length === 0"
            title="还没有补纸领用记录"
            description="领用时按当前有效约定自动测算：约定内正常，超额挂起待补办；改约够额后可在此补办入账。"
            size="small"
          />
          <el-table v-else :data="consignStore.requisitions" size="small" border max-height="420">
            <el-table-column label="册次 / 用途" min-width="150">
              <template #default="{ row }">
                <div>{{ volumeLabelById(row.volumeId) }}</div>
                <div class="gb-muted">{{ leafLabel(row.leafId) }} · {{ row.date }} · {{ row.operator || '未填' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="纸种 / 张数" width="110">
              <template #default="{ row }">
                {{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}
                <strong>×{{ row.usedSheets }}</strong>
                <div v-if="row.pendingSheets > 0" style="color: #b03a2e">挂起 {{ row.pendingSheets }}</div>
              </template>
            </el-table-column>
            <el-table-column label="约定依据" width="100">
              <template #default="{ row }">{{ row.basisAgreedSheets === null ? '自修' : `${row.basisAgreedSheets} 张` }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: requisitionColor(row.state), borderColor: `${requisitionColor(row.state)}66` }"
                  effect="plain"
                  size="small"
                  round
                >
                  {{ requisitionText(row.state) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button
                  v-if="row.state === 'pending_supplement'"
                  size="small"
                  type="primary"
                  text
                  @click="supplement(row)"
                >
                  补办入账
                </el-button>
                <el-button size="small" text type="danger" @click="removeRequisition(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 接收对账单 -->
    <el-dialog v-model="packetDialog" title="接收藏书单位对账单（JSON）" width="680px">
      <p class="gb-muted">
        来件只追加进送修单表，同一批次（id 相同）重发自动跳过；同一送修编号 +
        册次号的改约全部留痕，有效约定取晚到那份。本侧任何失败都不会改写或回滚来件。
      </p>
      <el-input v-model="packetText" type="textarea" :rows="14" placeholder="粘贴对账单 JSON" />
      <div style="margin-top: 8px">
        <el-button text type="primary" @click="downloadTemplate">下载来件模板</el-button>
      </div>
      <template #footer>
        <el-button @click="packetDialog = false">取消</el-button>
        <el-button type="primary" :loading="receiving" @click="submitPacket">接收入库</el-button>
      </template>
    </el-dialog>

    <!-- 手工登记来件批次 -->
    <el-dialog v-model="manualDialog" title="手工登记来件批次" width="620px">
      <el-form label-width="96px">
        <el-form-item label="送修编号" required>
          <el-input v-model="manualForm.sendNo" placeholder="如：SX-2026-099" />
        </el-form-item>
        <el-form-item label="册次号" required>
          <el-input-number v-model="manualForm.volumeNo" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="藏书单位">
          <el-input v-model="manualForm.ownerUnit" placeholder="如：甲县图书馆" />
        </el-form-item>
        <el-form-item label="批次序号">
          <el-input-number v-model="manualForm.revisionSeq" :min="1" :max="99" />
          <span class="gb-muted" style="margin-left: 8px">
            1 = 初约，≥2 = 改约（晚到那份为准，已完成工序不会被改回去）
          </span>
        </el-form-item>
        <el-form-item label="约定补纸">
          <div style="width: 100%">
            <div
              v-for="(allowance, index) in manualForm.paperAllowances"
              :key="allowance.paperType"
              style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px"
            >
              <el-select v-model="allowance.paperType" style="width: 130px">
                <el-option v-for="option in PAPER_TYPE_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-input-number v-model="allowance.agreedSheets" :min="0" :max="9999" />
              <span class="gb-muted">张</span>
              <el-button text type="danger" :icon="Remove" @click="removeAllowance(index)" />
            </div>
            <el-button size="small" @click="addAllowance">添加纸种</el-button>
          </div>
        </el-form-item>
        <el-form-item label="来件备注">
          <el-input v-model="manualForm.note" type="textarea" :rows="2" placeholder="如：第 2 批改约，竹纸追加 4 张" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="manualDialog = false">取消</el-button>
        <el-button type="primary" @click="submitManual">登记接收</el-button>
      </template>
    </el-dialog>
  </div>
</template>
