<script setup lang="ts">
/**
 * /consigns 送修对账
 * 两个限界上下文同屏分栏、各写各的表：
 * - 左：外单位送修单（对方账本），只做「接收 / 改约登记」（追加，晚到为准），修复室不可改；
 * - 右上：对认记录（修复室账本），按送修编号 + 册次号对账，认不上挂待认领、人工认册 / 撤销；
 * - 右下：补纸领用（修复室账本），超约定部分挂待补办，待补办不清不许验收。
 * 消费 ConsignManifest、ConsignIntake、PaperRequisition、Volume；复用 StatBadge、EmptyPanel。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, Plus, Refresh, Remove } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useConsignStore } from '@/stores/consignStore'
import { useConsignOverview } from '@/hooks/useConsignOverview'
import { BINDING_TYPE_LABEL } from '@/types/volume'
import { PAPER_TYPE_LABEL, PAPER_TYPE_OPTIONS, type PaperType } from '@/types/paper'
import type { ConsignManifestInput } from '@/types/consignManifest'
import {
  CONSIGN_INTAKE_STATE_COLOR,
  CONSIGN_INTAKE_STATE_LABEL,
  type ConsignIntake
} from '@/types/consignIntake'
import {
  createEmptyRequisitionDraft,
  type PaperRequisition,
  type PaperRequisitionDraft
} from '@/types/paperRequisition'

const bookStore = useBookStore()
const consignStore = useConsignStore()
const overview = useConsignOverview()

const stat = computed(() => ({
  manifestLines: consignStore.manifests.length,
  matched: overview.matchedCount.value,
  unclaimed: overview.unclaimedCount.value,
  pendingSupplement: overview.pendingSupplementCount.value
}))

/* --------------------------- 接收 / 改约送修单 --------------------------- */
const ingestDialog = ref(false)
const ingestForm = reactive({
  consignNo: '',
  volumeNo: 1,
  ownerUnit: '',
  paperType: 'bamboo' as PaperType,
  agreedSheets: 10,
  remark: '初约',
  receivedAt: ''
})

function openIngest(): void {
  ingestDialog.value = true
  ingestForm.consignNo = ''
  ingestForm.volumeNo = 1
  ingestForm.ownerUnit = ''
  ingestForm.paperType = 'bamboo'
  ingestForm.agreedSheets = 10
  ingestForm.remark = '初约'
  ingestForm.receivedAt = ''
}

async function submitIngest(): Promise<void> {
  if (!ingestForm.consignNo.trim()) {
    ElMessage.warning('请填写送修编号')
    return
  }
  if (!ingestForm.ownerUnit.trim()) {
    ElMessage.warning('请填写送修单位')
    return
  }
  if (ingestForm.agreedSheets < 0) {
    ElMessage.warning('约定张数不能为负')
    return
  }
  const receivedAt = ingestForm.receivedAt
    ? new Date(`${ingestForm.receivedAt}T00:00:00`).getTime()
    : Date.now()
  const line: ConsignManifestInput = {
    consignNo: ingestForm.consignNo.trim(),
    volumeNo: ingestForm.volumeNo,
    ownerUnit: ingestForm.ownerUnit.trim(),
    paperType: ingestForm.paperType,
    agreedSheets: ingestForm.agreedSheets,
    receivedAt,
    remark: ingestForm.remark.trim() || '初约'
  }
  // 同键已有更早记录且本次更晚 → 这是一次改约，提示晚到覆盖
  const sameKey = consignStore.manifests.filter(
    (item) =>
      item.consignNo === line.consignNo &&
      item.volumeNo === line.volumeNo &&
      item.paperType === line.paperType
  )
  const isAmendment = sameKey.some((item) => item.receivedAt <= receivedAt)
  const { added } = await consignStore.ingestBatch([line])
  ElMessage.success(
    isAmendment
      ? `已登记改约（晚到一份为现行约定，共 ${added} 行；已做完的工序不受影响）`
      : `已接收送修单 ${line.consignNo}（${added} 行），可执行对账`
  )
  ingestDialog.value = false
}

/* ------------------------------- 对账 / 认册 ------------------------------- */
async function runReconcile(): Promise<void> {
  const result = await consignStore.reconcile(bookStore.volumes)
  await bookStore.loadVolumes()
  ElMessage.success(
    `对账完成：对上 ${result.matched} 册，待认领 ${result.unclaimed} 册${
      result.created > 0 ? `（新建对认 ${result.created} 条）` : ''
    }`
  )
}

const claimDialog = ref(false)
const claiming = ref<ConsignIntake | null>(null)
const claimVolumeId = ref('')

const claimVolumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]}${
        volume.consignNo ? ` · 已挂 ${volume.consignNo}` : ''
      }`,
      volumeNo: volume.volumeNo,
      consignNo: volume.consignNo
    }))
  )
)

function openClaim(intake: ConsignIntake): void {
  claiming.value = intake
  // 默认带出册次号相同的候选，仍需人工确认
  const prefer = claimVolumeOptions.value.find(
    (item) => item.volumeNo === intake.volumeNo && !item.consignNo
  )
  claimVolumeId.value = prefer?.value ?? ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  if (!claiming.value) return
  const volume = bookStore.volumeById(claimVolumeId.value)
  if (!volume) {
    ElMessage.warning('请选择要认到的本室册次')
    return
  }
  try {
    await consignStore.claim(claiming.value, volume)
    await bookStore.loadVolumes()
    ElMessage.success(
      `已认到《${bookLabelOf(volume.bookId)}》第 ${volume.volumeNo} 册并挂送修标记 ${claiming.value.consignNo}`
    )
    claimDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '认册失败')
  }
}

async function runUnclaim(intake: ConsignIntake): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将摘除该册的送修标记，${intake.consignNo} 第 ${intake.volumeNo} 册退回待认领；送修单原样保留。`,
      '撤销对上',
      { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await consignStore.unclaim(intake)
  await bookStore.loadVolumes()
  ElMessage.success('已撤销对上，退回待认领')
}

/* ------------------------------- 补纸领用 ------------------------------- */
const reqDialog = ref(false)
const editingReq = ref<PaperRequisition | null>(null)
const reqForm = reactive<PaperRequisitionDraft>(createEmptyRequisitionDraft(''))

const reqVolumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册${volume.consignNo ? ` · ${volume.consignNo}` : '（本室）'}`
    }))
  )
)

function openCreateReq(): void {
  const first = reqVolumeOptions.value[0]
  if (!first) {
    ElMessage.warning('请先登记册次')
    return
  }
  editingReq.value = null
  Object.assign(reqForm, createEmptyRequisitionDraft(first.value))
  reqDialog.value = true
}

function openEditReq(row: PaperRequisition): void {
  editingReq.value = row
  Object.assign(reqForm, {
    volumeId: row.volumeId,
    paperType: row.paperType,
    usedSheets: row.usedSheets,
    date: row.date,
    note: row.note
  })
  reqDialog.value = true
}

async function submitReq(): Promise<void> {
  if (!reqForm.volumeId) {
    ElMessage.warning('请选择册次')
    return
  }
  if (reqForm.usedSheets < 0) {
    ElMessage.warning('领用张数不能为负')
    return
  }
  // 同册同纸种已有记录时按累计更新（保持一条）
  const existing =
    editingReq.value ??
    consignStore.requisitions
      .filter((item) => item.volumeId === reqForm.volumeId && item.paperType === reqForm.paperType)
      .find(Boolean)
  await consignStore.saveRequisition({ ...reqForm }, existing?.id)
  ElMessage.success('补纸领用已登记，超出约定的部分已挂待补办')
  reqDialog.value = false
}

async function removeReq(row: PaperRequisition): Promise<void> {
  try {
    await ElMessageBox.confirm('将删除该条补纸领用记录。', '删除领用', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await consignStore.removeRequisition(row.id)
  ElMessage.success('已删除')
}

/* ------------------------------- 展示辅助 ------------------------------- */
function bookLabelOf(bookId: string): string {
  return bookStore.bookById(bookId)?.title ?? ''
}

function intakeStateColor(state: string): string {
  return CONSIGN_INTAKE_STATE_COLOR[state as keyof typeof CONSIGN_INTAKE_STATE_COLOR] ?? '#8c8c8c'
}

function intakeStateLabel(state: string): string {
  return CONSIGN_INTAKE_STATE_LABEL[state as keyof typeof CONSIGN_INTAKE_STATE_LABEL] ?? state
}

function paperLabel(type: PaperType): string {
  return PAPER_TYPE_LABEL[type]
}

function reqRowVolume(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  return `《${bookLabelOf(volume.bookId)}》第 ${volume.volumeNo} 册`
}

/** 领用行的实时挂起结论（约定按现行送修单，改约晚到为准） */
function reqHolding(row: PaperRequisition) {
  return overview.holdingsOfVolume(row.volumeId).find((item) => item.paperType === row.paperType)
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>送修对账与补纸领用</h2>
        <p>
          外单位只登记送修编号、册次号与约定纸种张数；修复室只管古籍、册次、书叶与工序。两侧各写各的表，按「送修编号 +
          册次号」对账。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Refresh" @click="runReconcile">按送修单对账</el-button>
        <el-button type="primary" :icon="Plus" @click="openIngest">接收 / 改约送修单</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="送修单行（含改约）" :value="stat.manifestLines" suffix="行" tone="info" />
      <StatBadge label="已对上" :value="stat.matched" suffix="册" tone="success" />
      <StatBadge label="待认领" :value="stat.unclaimed" suffix="册" tone="warning" />
      <StatBadge label="待补办超领册" :value="stat.pendingSupplement" suffix="册" tone="danger" />
    </div>

    <el-row :gutter="16">
      <!-- 左：对方账本 -->
      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>外单位送修单（对方账本 · 只追加）</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openIngest">接收 / 改约</el-button>
            </div>
          </template>
          <el-alert
            type="info"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            title="中间改约登记晚到的一份即为现行约定；修复室不可修改或删除这些记录，已做完的工序不会被改回去。"
          />
          <EmptyPanel
            v-if="consignStore.manifests.length === 0"
            title="还没有收到送修单"
            description="外单位把送修编号、册次号、约定的补纸纸种与张数送过来后，在此逐行登记。"
            action-text="接收送修单"
            size="small"
            @action="openIngest"
          />
          <el-table v-else :data="consignStore.manifests" size="small" border max-height="520">
            <el-table-column prop="consignNo" label="送修编号" width="120" />
            <el-table-column prop="ownerUnit" label="送修单位" min-width="130" />
            <el-table-column label="册次" width="60">
              <template #default="{ row }">第{{ row.volumeNo }}册</template>
            </el-table-column>
            <el-table-column label="纸种 / 约定" width="110">
              <template #default="{ row }">{{ paperLabel(row.paperType) }} {{ row.agreedSheets }}</template>
            </el-table-column>
            <el-table-column label="到达时间" width="110">
              <template #default="{ row }">{{ new Date(row.receivedAt).toLocaleDateString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column prop="remark" label="说明" min-width="120" />
          </el-table>
        </el-card>
      </el-col>

      <!-- 右：本侧两个账本 -->
      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>对认记录（修复室账本）</span>
              <el-button size="small" :icon="Connection" @click="runReconcile">执行对账</el-button>
            </div>
          </template>
          <EmptyPanel
            v-if="overview.rows.value.length === 0"
            title="尚无对认记录"
            description="先接收送修单，再点「执行对账」：对上的册次自动挂送修标记，认不上的挂待认领。"
            action-text="接收送修单"
            size="small"
            @action="openIngest"
          />
          <el-table v-else :data="overview.rows.value" size="small" border>
            <el-table-column prop="intake.consignNo" label="送修编号" width="115" />
            <el-table-column label="册次" width="56">
              <template #default="{ row }">第{{ row.intake.volumeNo }}册</template>
            </el-table-column>
            <el-table-column prop="ownerUnit" label="送修单位" min-width="120" />
            <el-table-column label="约定纸种张数" min-width="150">
              <template #default="{ row }">
                <div>{{ row.agreementText }}</div>
                <el-tag v-if="row.hasPendingSupplement" type="danger" size="small" effect="plain" round style="margin-top: 2px">
                  超领待补办
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="对认状态 / 本室册次" min-width="170">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: intakeStateColor(row.intake.state), borderColor: `${intakeStateColor(row.intake.state)}66` }"
                  effect="plain"
                  size="small"
                  round
                >
                  {{ intakeStateLabel(row.intake.state) }}
                </el-tag>
                <div class="gb-muted" style="margin-top: 2px">{{ row.volumeLabel || '—' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button
                  v-if="row.intake.state === 'unclaimed'"
                  size="small"
                  type="primary"
                  text
                  :icon="Connection"
                  @click="openClaim(row.intake)"
                >
                  认册
                </el-button>
                <el-button
                  v-else
                  size="small"
                  text
                  type="warning"
                  :icon="Remove"
                  @click="runUnclaim(row.intake)"
                >
                  撤销
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>补纸领用（超约定部分挂待补办，卡验收）</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openCreateReq">登记领用</el-button>
            </div>
          </template>
          <el-alert
            type="warning"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            title="领用超出送修约定的部分先挂起待补办，不许并进验收；藏书单位改约追加（晚到为准）后自动解除。"
          />
          <EmptyPanel
            v-if="consignStore.requisitions.length === 0"
            title="还没有补纸领用记录"
            description="修复师领用补纸后在此按册次、纸种登记累计张数。"
            size="small"
          />
          <el-table v-else :data="consignStore.requisitions" size="small" border>
            <el-table-column label="册次" min-width="180">
              <template #default="{ row }">{{ reqRowVolume(row.volumeId) }}</template>
            </el-table-column>
            <el-table-column label="纸种" width="90">
              <template #default="{ row }">{{ paperLabel(row.paperType) }}</template>
            </el-table-column>
            <el-table-column prop="usedSheets" label="领用(张)" width="80" />
            <el-table-column label="约定 / 超出" width="120">
              <template #default="{ row }">
                <template v-if="reqHolding(row)">
                  {{ reqHolding(row)?.agreedSheets }} /
                  <el-tag :type="reqHolding(row)?.pendingSupplement ? 'danger' : 'success'" size="small" effect="plain" round>
                    {{ reqHolding(row)?.exceededSheets ?? 0 }}
                  </el-tag>
                </template>
                <span v-else class="gb-muted">本室自管</span>
              </template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="110" />
            <el-table-column prop="note" label="备注" min-width="120" />
            <el-table-column label="操作" width="130">
              <template #default="{ row }">
                <el-button size="small" text @click="openEditReq(row)">编辑</el-button>
                <el-button size="small" text type="danger" @click="removeReq(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 接收 / 改约送修单 -->
    <el-dialog v-model="ingestDialog" title="接收 / 改约送修单（外单位账本）" width="560px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        title="此操作只追加外单位送修单，不改动修复室任何册次、书叶与工序；同一纸种晚到的一份覆盖早到约定。"
      />
      <el-form label-width="100px">
        <el-form-item label="送修编号" required>
          <el-input v-model="ingestForm.consignNo" placeholder="如：SX-2026-017" />
        </el-form-item>
        <el-form-item label="送修单位" required>
          <el-input v-model="ingestForm.ownerUnit" placeholder="如：市图书馆特藏部" />
        </el-form-item>
        <el-form-item label="册次号" required>
          <el-input-number v-model="ingestForm.volumeNo" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="补纸纸种" required>
          <el-select v-model="ingestForm.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="约定张数" required>
          <el-input-number v-model="ingestForm.agreedSheets" :min="0" :max="9999" />
        </el-form-item>
        <el-form-item label="到达日期">
          <el-input v-model="ingestForm.receivedAt" type="date" placeholder="留空按今天（晚到改约请填实际到达日）" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="ingestForm.remark" placeholder="初约 / 第几次改约" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ingestDialog = false">取消</el-button>
        <el-button type="primary" @click="submitIngest">登记送修单</el-button>
      </template>
    </el-dialog>

    <!-- 人工认册 -->
    <el-dialog v-model="claimDialog" :title="`人工认册 · ${claiming?.consignNo ?? ''} 第 ${claiming?.volumeNo ?? ''} 册`" width="560px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        title="只能认到册次号相同、且未挂其他送修编号的本室册次；认上后挂送修标记，破损与工序照旧登记。"
      />
      <el-form label-width="100px">
        <el-form-item label="送修单位">
          <el-input :model-value="claiming?.ownerUnit ?? ''" disabled />
        </el-form-item>
        <el-form-item label="本室册次" required>
          <el-select v-model="claimVolumeId" style="width: 100%" filterable>
            <el-option v-for="item in claimVolumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="primary" @click="submitClaim">确认认册</el-button>
      </template>
    </el-dialog>

    <!-- 补纸领用 -->
    <el-dialog v-model="reqDialog" :title="editingReq ? '编辑补纸领用' : '登记补纸领用'" width="520px">
      <el-form label-width="100px">
        <el-form-item label="册次" required>
          <el-select v-model="reqForm.volumeId" style="width: 100%" filterable>
            <el-option v-for="item in reqVolumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="reqForm.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="累计张数" required>
          <el-input-number v-model="reqForm.usedSheets" :min="0" :max="9999" />
        </el-form-item>
        <el-form-item label="日期">
          <el-input v-model="reqForm.date" type="date" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="reqForm.note" type="textarea" :rows="2" placeholder="如：超领 2 张待对方补办手续" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reqDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReq">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
