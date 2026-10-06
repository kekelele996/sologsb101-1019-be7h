<script setup lang="ts">
/**
 * <ConsignTag> 送修标记
 * 已对上送修编号的册次统一渲染该徽标（修复室台账、书叶页、验收页共用）；
 * 待认领送修行用 warning 色块，已对上用 success 色块。
 */
import { computed } from 'vue'
import { Connection, WarningFilled } from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    /** 送修编号；空串表示未送修（不渲染） */
    sendNo?: string
    /** 册次号（待认领态没有本侧册次时使用） */
    volumeNo?: number
    /** 状态：已对上 / 待认领 / 未送修 */
    status?: 'matched' | 'pending_claim' | 'none'
    size?: 'default' | 'small'
  }>(),
  {
    sendNo: '',
    volumeNo: undefined,
    status: 'matched',
    size: 'default'
  }
)

const visible = computed(() => props.status !== 'none' && (props.sendNo.length > 0 || props.status === 'pending_claim'))
const label = computed(() => {
  if (props.status === 'pending_claim') return `待认领${props.volumeNo ? `·第${props.volumeNo}册` : ''}`
  return `送修 ${props.sendNo}`
})
</script>

<template>
  <el-tag
    v-if="visible"
    :type="status === 'pending_claim' ? 'danger' : 'warning'"
    effect="plain"
    round
    :size="size === 'small' ? 'small' : 'default'"
    class="consign-tag"
  >
    <el-icon class="consign-tag__icon">
      <WarningFilled v-if="status === 'pending_claim'" />
      <Connection v-else />
    </el-icon>
    {{ label }}
  </el-tag>
</template>

<style scoped>
.consign-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.consign-tag__icon {
  font-size: 12px;
}
</style>
