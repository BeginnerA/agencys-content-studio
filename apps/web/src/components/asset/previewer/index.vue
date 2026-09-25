<script setup lang="ts">
// 统一资产预览查看器：图片（缩放/平移）/ 视频 / 音频 / Markdown / JSON / 纯文本 / 未知兜底
// 设计：沉浸式弹窗（与 Modal 体例同源），多资产可切换（← →），操作统一收敛顶栏（复制/下载/新标签）
// ---- 已拆分：交互逻辑经 use-asset-previewer.ts 装配（行为零变更）----
// ---- 舞台分支拆至 AssetStage.vue（状态真源仍在 composable）----
import type { Asset } from '../../../lib/types'
import Icon from '../../common/Icon.vue'
import AssetStage from './AssetStage.vue'
import VersionHistoryPanel from '../../version/VersionHistoryPanel.vue'
import { useAssetPreviewer } from './use-asset-previewer'

const props = defineProps<{
  assets: Asset[]
  index?: number
  removable?: boolean
  readonly?: boolean
}>()
const emit = defineEmits<{
  close: []
  changed: [asset: Asset]
  removed: [asset: Asset]
}>()

// ---- 装配：状态/操作经 composable；模板标识符解构直用 ----
const {
  MIN_SCALE,
  MAX_SCALE,
  idx,
  cur,
  hasPrev,
  hasNext,
  vkind,
  isTextLike,
  tooBig,
  TYPE_ICON,
  kindLabel,
  compliance,
  complianceLabel,
  complianceTip,
  metaLine,
  text,
  textLoading,
  textErr,
  jsonHtml,
  jsonBad,
  copied,
  copyText,
  scale,
  tx,
  ty,
  dragging,
  imgErr,
  stageEl,
  onImgLoad,
  resetImage,
  onWheel,
  zoomBy,
  toggleDouble,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  checkBusy,
  checkMsg,
  doCheck,
  tagDraft,
  tagBusy,
  tagErr,
  curTags,
  addTag,
  removeTag,
  removeBusy,
  removeErr,
  doRemove,
  editing,
  draft,
  editSaving,
  editErr,
  editDirty,
  canEdit,
  startEdit,
  saveEdit,
  showVersions,
  onVersionRestored,
  tryClose,
  prev,
  next,
  downloadHref,
} = useAssetPreviewer(props, emit)
</script>

<template>
  <Teleport to="body">
    <div class="mask" @click.self="tryClose">
      <div
        v-if="cur"
        class="viewer panel"
        :class="{ 'ec-readonly-preview': readonly }"
        role="dialog"
        aria-modal="true"
        :aria-label="`资产预览：${cur.name}`"
      >
        <!-- 顶栏：身份 + 操作 -->
        <header class="head">
          <Icon :name="TYPE_ICON[vkind]" :size="15" class="type-ic" />
          <span class="nm" :title="cur.name">{{ cur.name }}</span>
          <span class="badge">{{ kindLabel }}</span>
          <!-- 合规审核徽章（params.compliance；悬停看命中数与时间） -->
          <span
            v-if="compliance"
            class="badge"
            :class="`comp-${compliance.status}`"
            :title="complianceTip"
            >{{ complianceLabel }}</span
          >
          <span v-if="assets.length > 1" class="count mono"
            >{{ idx + 1 }} / {{ assets.length }}</span
          >
          <div class="ops">
            <button
              v-if="!readonly && cur.kind === 'image'"
              class="btn sm"
              :disabled="checkBusy"
              title="重新检测图片有效性（黑图 / 纯色空白 / 损坏；结果写入资产元数据）"
              @click="doCheck"
            >
              <Icon name="refresh" :size="12" />
              {{ checkBusy ? '检测中…' : '重新检测' }}
            </button>
            <button
              v-if="isTextLike && !tooBig"
              class="btn sm"
              :disabled="textLoading || !!textErr || !text"
              @click="copyText"
            >
              <Icon :name="copied ? 'check' : 'copy'" :size="12" />
              {{ copied ? '已复制' : '复制' }}
            </button>
            <!-- G2 文本内容编辑（白名单 purpose 入口；保存/取消收敛顶栏） -->
            <button
              v-if="canEdit && !editing"
              class="btn sm"
              :disabled="textLoading || !!textErr"
              title="编辑内容（保存后覆盖此文本资产）"
              @click="startEdit"
            >
              <Icon name="pencil" :size="12" /> 编辑
            </button>
            <!-- 历史·影响面板入口（可编辑文本资产；只读 + 显式还原 + 影响仅报告） -->
            <button
              v-if="canEdit && !editing"
              class="btn sm"
              :class="{ primary: showVersions }"
              title="查看版本历史与下游影响"
              @click="showVersions = !showVersions"
            >
              <Icon name="clock" :size="12" /> 历史·影响
            </button>
            <template v-if="editing">
              <button
                class="btn sm primary"
                :disabled="editSaving || !editDirty"
                @click="saveEdit"
              >
                <Icon name="check" :size="12" />
                {{ editSaving ? '保存中…' : '保存' }}
              </button>
              <button class="btn sm" :disabled="editSaving" @click="tryClose()">
                {{ editDirty ? '放弃修改' : '取消' }}
              </button>
            </template>
            <a class="btn sm" :href="downloadHref(cur)" :download="cur.name">
              <Icon name="download" :size="12" /> 下载
            </a>
            <a
              class="btn sm"
              :href="cur.urls.file"
              target="_blank"
              rel="noopener"
              title="浏览器新标签打开原文"
            >
              <Icon name="external" :size="12" /> 新标签
            </a>
            <button
              v-if="removable && !readonly"
              class="btn sm danger"
              :disabled="removeBusy"
              title="软删除该资产（回收空间前可回溯）"
              @click="doRemove"
            >
              <Icon name="trash" :size="12" />
              {{ removeBusy ? '删除中…' : '删除' }}
            </button>
            <button class="icon-btn" aria-label="关闭预览" @click="tryClose">
              <Icon name="x" :size="15" :stroke-width="2" />
            </button>
          </div>
        </header>

        <!-- 舞台 -->
        <div class="stagewrap">
          <div ref="stageEl" class="stage" :class="`stage-${vkind}`">
            <!-- 舞台分支 ：拆至 AssetStage.vue（状态真源仍在 composable；draft/imgErr 双向；stageEl 量测仍指本组件 .stage） -->
            <AssetStage
              v-model:draft="draft"
              v-model:img-err="imgErr"
              :cur="cur!"
              :vkind="vkind"
              :is-text-like="isTextLike"
              :too-big="tooBig"
              :editing="editing"
              :edit-saving="editSaving"
              :text="text"
              :text-loading="textLoading"
              :text-err="textErr"
              :json-html="jsonHtml"
              :json-bad="jsonBad"
              :scale="scale"
              :tx="tx"
              :ty="ty"
              :dragging="dragging"
              :MIN_SCALE="MIN_SCALE"
              :MAX_SCALE="MAX_SCALE"
              :download-href="downloadHref"
              :on-img-load="onImgLoad"
              :on-wheel="onWheel"
              :on-pointer-down="onPointerDown"
              :on-pointer-move="onPointerMove"
              :on-pointer-up="onPointerUp"
              :zoom-by="zoomBy"
              :toggle-double="toggleDouble"
              :reset-image="resetImage"
            />
          </div>

          <button
            v-if="hasPrev && !editing"
            class="nav prev"
            aria-label="上一个资产"
            @click="prev"
          >
            <Icon name="chevron-left" :size="18" />
          </button>
          <button
            v-if="hasNext && !editing"
            class="nav next"
            aria-label="下一个资产"
            @click="next"
          >
            <Icon name="chevron-right" :size="18" />
          </button>
        </div>

        <!-- 底栏：元信息 + 提示词快照 -->
        <footer class="foot">
          <div class="metaline mono">{{ metaLine }}</div>
          <div v-if="!readonly" class="tagedit">
            <span class="tglb">标签</span>
            <span v-for="t in curTags" :key="t" class="tgchip">
              {{ t }}
              <button
                class="tgx"
                type="button"
                :disabled="tagBusy"
                :aria-label="`删除标签 ${t}`"
                @click="removeTag(t)"
              >
                <Icon name="x" :size="10" :stroke-width="2.6" />
              </button>
            </span>
            <input
              v-model="tagDraft"
              type="text"
              class="tginput"
              placeholder="输入后回车添加"
              aria-label="新增标签"
              :disabled="tagBusy"
              @keydown.enter.prevent="addTag"
            />
            <span v-if="tagErr" class="err-text">{{ tagErr }}</span>
          </div>
          <div
            v-if="checkMsg"
            class="chk"
            :class="{ bad: checkMsg.startsWith('检测失败') }"
          >
            {{ checkMsg }}
          </div>
          <div v-if="removeErr" class="chk bad">{{ removeErr }}</div>
          <div v-if="editErr" class="chk bad">保存失败：{{ editErr }}</div>
          <details v-if="cur.prompt" class="prmt">
            <summary>提示词快照（可复制溯源）</summary>
            <pre class="prebox">{{ cur.prompt }}</pre>
          </details>
        </footer>

        <!-- 右侧「历史 · 影响」抽屉（可编辑文本资产；覆盖舞台右缘） -->
        <div
          v-if="!readonly && showVersions && cur"
          class="vdraw"
          role="complementary"
          aria-label="版本历史与影响"
        >
          <div class="vdraw-head">
            <span>历史 · 影响</span>
            <button
              class="icon-btn"
              aria-label="关闭历史面板"
              @click="showVersions = false"
            >
              <Icon name="x" :size="14" :stroke-width="2" />
            </button>
          </div>
          <div class="vdraw-body">
            <VersionHistoryPanel
              kind="asset"
              :obj-id="cur.id"
              @restored="onVersionRestored"
            />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ec-readonly-preview .head { flex-wrap: wrap; }
.ec-readonly-preview .ops { flex-wrap: wrap; }
.ec-readonly-preview .ops .btn, .ec-readonly-preview .icon-btn { min-width: 44px; min-height: 44px; }
.ec-readonly-preview button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mask {
  position: fixed;
  inset: 0;
  background: rgb(3 6 14 / 72%);
  backdrop-filter: blur(5px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
  animation: fade-in 0.15s ease-out;
}

.viewer {
  width: min(94vw, 1080px);
  height: min(92vh, 820px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  animation: pop-in 0.18s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mask,
  .viewer {
    animation: none;
  }
}

/* ---------- 顶栏 ---------- */
.head {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* 顶栏操作多时换行，避免窄窗口 / 长名称下最右的下载/新标签/删除/关闭被 .viewer 的 overflow:hidden 裁切 */
  row-gap: 8px;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  min-height: 48px;
  flex: none;
}

.type-ic {
  color: var(--accent-h);
}

.nm {
  font-weight: 600;
  font-size: 13.5px;
  max-width: 36%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  color: var(--text-3);
  font-size: 11.5px;
}

/* 合规徽章三态（配色对齐全局 badge 语义：ok/warn/bad） */
.comp-pass {
  background: var(--ok-weak);
  color: var(--ok);
}

.comp-warn {
  background: rgb(245 158 11 / 12%);
  color: #d97706;
}

.comp-block {
  background: var(--bad-weak);
  color: var(--bad);
}

.ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.15s;
  flex: none;
}

.icon-btn:hover {
  color: #fff;
  background: var(--hover);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: none;
}

.head .icon-btn:hover {
  color: var(--bad);
}

/* ---------- 舞台 ---------- */
.stagewrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    radial-gradient(
      900px 420px at 50% -10%,
      rgb(139 92 246 / 5%),
      transparent 60%
    ),
    var(--code-bg);
}

.stage.stage-markdown,
.stage.stage-json,
.stage.stage-text {
  overflow-y: auto;
  align-items: flex-start;
  padding: 18px 22px;
}

.prebox {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.65;
  color: #c7d3e6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* ---------- 资产切换 ---------- */
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  z-index: 2;
}

.nav:hover {
  color: #fff;
  border-color: rgb(99 102 241 / 60%);
  background: var(--raised);
}

.nav.prev {
  left: 12px;
}

.nav.next {
  right: 12px;
}

/* ---------- 底栏 ---------- */
.foot {
  border-top: 1px solid var(--border);
  padding: 8px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  max-height: 32%;
  overflow-y: auto;
}

.metaline {
  font-size: 11.5px;
  color: var(--text-3);
}

/* 标签编辑（回车添加 / chip × 删除；变更即存） */
.tagedit {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.tglb {
  color: var(--text-3);
  font-size: 11.5px;
}

.tgchip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11.5px;
  line-height: 18px;
  padding: 0 6px 0 9px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--text-2);
}

.tgx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}

.tgx:hover {
  color: var(--bad);
  background: var(--hover);
}

.tgx:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tginput {
  width: 150px;
  font-size: 11.5px;
  padding: 3px 8px;
}

/* 重检结果（成功绿 / 失败红） */
.chk {
  font-size: 11.5px;
  color: var(--ok);
}

.chk.bad {
  color: var(--bad);
}

.prmt summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}

.prmt .prebox {
  margin-top: 6px;
  max-height: 140px;
  overflow-y: auto;
  font-size: 11.5px;
}

/* 右侧「历史 · 影响」抽屉（覆盖舞台右缘，不阻断主预览） */
.vdraw {
  position: absolute;
  top: 48px;
  right: 0;
  bottom: 0;
  width: min(400px, 62%);
  display: flex;
  flex-direction: column;
  background: var(--panel, rgb(10 14 24 / 96%));
  border-left: 1px solid var(--border-strong);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  z-index: 3;
}

.vdraw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  flex: none;
}

.vdraw-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 14px;
}
</style>
