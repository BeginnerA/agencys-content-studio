<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import { KIND_TEXT, fmtMs, fmtTime } from '../../../lib/format'
import { TASK_TEXT, assetThumb, stCls } from './internals'
import type { InspectorApi, InspectorForm } from './use-inspector-form'

const props = defineProps<{
  node: CanvasDocNode
  form: InspectorForm
  openPreview: (assetId: number | null) => Promise<void>
  cancelTaskRow: InspectorApi['cancelTaskRow']
  adoptResult: InspectorApi['adoptResult']
}>()
const form = props.form
</script>

<template>
  <!-- ===== gen：任务历史 ===== -->
  <section v-if="node.kind === 'gen'" class="sec">
    <div class="sec-h">任务历史（最近 {{ node.tasks.length }} 条）</div>
    <div v-if="!node.tasks.length" class="muted">暂无任务</div>
    <div v-else class="tlist">
      <div v-for="t in node.tasks" :key="t.id" class="trow">
        <span class="mono tid">#{{ t.id }}</span>
        <span class="badge" :class="stCls(t.status)">{{
          TASK_TEXT[t.status] ?? t.status
        }}</span>
        <span v-if="t.attempts > 1" class="muted">尝试 {{ t.attempts }}</span>
        <span
          v-if="t.status === 'succeeded' && t.completedAt"
          class="muted mono"
          >{{ fmtMs(t.completedAt - t.createdAt) }}</span
        >
        <span v-if="t.errorMsg" class="t-err" :title="t.errorMsg">{{
          t.errorMsg
        }}</span>
        <span class="sp" />
        <button
          v-if="t.status === 'succeeded' && t.resultAssetId != null"
          type="button"
          class="btn sm"
          @click="openPreview(t.resultAssetId)"
        >
          查看
        </button>
        <button
          v-if="t.status === 'pending' || t.status === 'processing'"
          type="button"
          class="btn sm danger"
          :disabled="form.opBusy"
          @click="cancelTaskRow(t)"
        >
          取消
        </button>
      </div>
    </div>
  </section>

  <!-- ===== gen：显示产物 + 结果画廊（采纳） ===== -->
  <section v-if="node.kind === 'gen'" class="sec">
    <div class="sec-h">
      显示产物
      <span v-if="node.adoptedTaskId != null" class="muted mini"
        >· 采纳任务 #{{ node.adoptedTaskId }}</span
      >
      <span v-else-if="node.displayTaskId != null" class="muted mini"
        >· 任务 #{{ node.displayTaskId }}</span
      >
    </div>
    <div
      v-if="node.displayTask && node.displayTask.asset"
      class="resbox static"
    >
      <audio
        v-if="node.displayTask.asset.kind === 'audio'"
        controls
        :src="node.displayTask.asset.urls.file"
      />
      <video
        v-else-if="node.displayTask.asset.kind === 'video'"
        controls
        :src="node.displayTask.asset.urls.file"
      />
      <button
        v-else
        type="button"
        class="unstyle"
        title="点击预览"
        @click="openPreview(node.displayTask.resultAssetId)"
      >
        <img
          v-if="assetThumb(node.displayTask.asset)"
          :src="assetThumb(node.displayTask.asset)!"
          alt=""
        />
        <span v-else class="muted">{{
          KIND_TEXT[node.displayTask.asset.kind] ?? node.displayTask.asset.kind
        }}</span>
      </button>
    </div>
    <button
      v-else-if="node.assetId != null && node.asset"
      type="button"
      class="resbox"
      title="点击预览"
      @click="openPreview(node.assetId)"
    >
      <img
        v-if="assetThumb(node.asset)"
        :src="assetThumb(node.asset)!"
        alt=""
      />
      <span v-else class="muted">{{
        KIND_TEXT[node.asset.kind] ?? node.asset.kind
      }}</span>
    </button>
    <div v-else class="muted">暂无产物</div>

    <div class="sec-h">结果画廊（最近成功 {{ node.results.length }} 张）</div>
    <div v-if="!node.results.length" class="muted">暂无成功产物</div>
    <div v-else class="gallery">
      <div
        v-for="r in node.results"
        :key="r.taskId"
        class="gitem"
        :class="{ adopted: r.taskId === node.adoptedTaskId }"
      >
        <button
          type="button"
          class="gthumb"
          :title="`任务 #${r.taskId} · ${fmtTime(r.createdAt)}（点击大图）`"
          @click="openPreview(r.assetId)"
        >
          <img
            v-if="r.asset && (r.asset.urls.thumb || r.asset.kind === 'image')"
            :src="r.asset.urls.thumb ?? r.asset.urls.file"
            alt=""
          />
          <span v-else class="muted mini">{{
            r.asset ? (KIND_TEXT[r.asset.kind] ?? r.asset.kind) : '缺失'
          }}</span>
        </button>
        <div class="gmeta">
          <span v-if="r.taskId === node.adoptedTaskId" class="badge succeeded"
            >已采纳</span
          >
          <span
            v-else-if="r.taskId === node.displayTaskId"
            class="badge pending"
            >最新</span
          >
          <span class="mono mini">#{{ r.taskId }}</span>
        </div>
        <button
          type="button"
          class="btn sm"
          :disabled="form.opBusy"
          @click="adoptResult(r)"
        >
          {{ r.taskId === node.adoptedTaskId ? '取消采纳' : '采纳' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.sec-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

.tlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  padding: 3px 0;
  min-width: 0;
  flex-wrap: wrap;
}

.tid {
  color: var(--text-3);
  flex: none;
}

.t-err {
  flex: 1;
  min-width: 90px;
  color: var(--bad);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resbox {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  min-height: 84px;
}

.resbox:hover {
  border-color: var(--accent);
}

.resbox img {
  display: block;
  width: 100%;
  max-height: 190px;
  object-fit: contain;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}

.gitem {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  padding: 5px;
}

.gitem.adopted {
  border-color: var(--accent);
}

.gthumb {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  border-radius: 6px;
  overflow: hidden;
  padding: 0;
  cursor: pointer;
  min-height: 56px;
  color: var(--text-3);
}

.gthumb img {
  display: block;
  width: 100%;
  height: 62px;
  object-fit: cover;
}

.gmeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-height: 18px;
}

.resbox.static {
  cursor: default;
}

.resbox audio,
.resbox video {
  width: 100%;
}

.unstyle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-3);
}

.unstyle img {
  display: block;
  width: 100%;
  max-height: 190px;
  object-fit: contain;
}
</style>
