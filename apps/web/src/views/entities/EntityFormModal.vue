<script setup lang="ts">
import Modal from '../../components/common/Modal.vue'
import Icon from '../../components/common/Icon.vue'
import type { EntitiesApi } from './use-entities'
const props = defineProps<{ s: EntitiesApi }>()
const { kind, cfg, projects, busy, showForm, form, formErr, assetOptions, assetsLoading, uploadEl, uploading, upNote, clones, cloneSel, onCloneSelChange, onPickProject, toggleRef, save, pickUpload, onUploadPick } = props.s
</script>

<template>
    <Modal
      v-if="showForm"
      :title="form.id ? `编辑${cfg.label}「${form.name}」` : `新建${cfg.label}`"
      :width="720"
      @close="showForm = false"
    >
      <!-- 基本信息 -->
      <div class="section">
        <div class="section-title">基本信息</div>
        <div class="frow">
          <label class="fld">
            {{ cfg.nameLabel }} <span class="req">*</span>
            <input v-model="form.name" type="text" :placeholder="cfg.namePh" />
          </label>
          <label class="fld">
            别名（逗号 / 顿号分隔）
            <input v-model="form.aliases" type="text" :placeholder="cfg.aliasPh" />
          </label>
        </div>
      </div>

      <!-- 视觉描述 -->
      <div class="section">
        <div class="section-title">视觉描述</div>
        <label class="fld">
          {{ cfg.apLabel }}
          <textarea v-model="form.appearance" rows="3" :placeholder="cfg.apPh" />
        </label>
        <label class="fld">
          必须剔除 negative
          <textarea v-model="form.negative" rows="2" :placeholder="cfg.negPh" />
        </label>
      </div>

      <!-- 声音设定（仅角色） -->
      <div v-if="kind === 'character'" class="section">
        <div class="section-title">声音设定</div>
        <label class="fld voice-fld">
          <span class="voice-label">声线 voice（TTS 声线链 L2）</span>
          <div class="voice-row">
            <textarea v-model="form.voice" rows="2" placeholder="如：软糯童声（或网关 模型:音色 格式）" class="voice-ta" />
            <!-- [M19 P8] 选克隆音色：选中写入 clone:{id}（服务端换克隆端点并覆盖为克隆绑定模型）；选首项仅清除克隆令牌 -->
            <select v-model="cloneSel" @change="onCloneSelChange" class="voice-sel">
              <option value="">{{ clones.length ? '选克隆音色（clone:{id}）…' : '音色库为空（先到 Settings → 音色库复刻）' }}</option>
              <option v-for="c in clones" :key="c.id" :value="String(c.id)">{{ c.name }}（{{ c.providerKey }} / {{ c.model }}）</option>
            </select>
          </div>
        </label>
      </div>

      <!-- 状态与简介 -->
      <div class="section">
        <div class="section-title">状态与简介</div>
        <label v-if="kind === 'character'" class="fld">
          状态变体 states（每行一条；格式「剧情节点：状态短语」；节点优先用「第N场 / 第N集」定位词，出图逐镜自动命中）
          <textarea v-model="form.states" rows="2" placeholder="如：第5场受伤：额头绷带" />
        </label>
        <label class="fld">
          简介 summary
          <input v-model="form.summary" type="text" :placeholder="cfg.summaryPh" />
        </label>
      </div>

      <div class="refbox">
        <div class="rhead">
          <span>{{ cfg.refLabel }}</span>
          <span v-if="!form.id" class="muted">
            归属：
            <select v-model.number="form.projectId" style="width: 200px" @change="onPickProject">
              <option :value="0">全局（不挂参考图）</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">项目#{{ p.id }} {{ p.name }}</option>
            </select>
          </span>
          <span v-else class="muted">归属：{{ form.projectId ? `项目#${form.projectId}（不可改）` : '全局（不可挂图）' }}</span>
          <button
            v-if="form.id && form.projectId"
            class="btn tiny"
            type="button"
            style="margin-left: auto"
            :disabled="uploading"
            @click="pickUpload"
          >
            <Icon name="plus" :size="12" /> {{ uploading ? '上传中…' : '上传新图' }}
          </button>
          <input ref="uploadEl" type="file" accept="image/*" class="hidden-file" @change="onUploadPick" />
        </div>
        <div v-if="upNote" class="up-note">{{ upNote }}</div>
        <template v-if="form.projectId">
          <div v-if="assetsLoading" class="muted" style="font-size: 12px">图片加载中…</div>
          <div v-else-if="!assetOptions.length" class="muted" style="font-size: 12px">该项目暂无图片资产（先出图或导入素材）</div>
          <div v-else class="thumbs">
            <button
              v-for="a in assetOptions"
              :key="a.id"
              class="thumb"
              :class="{ on: form.refIds.includes(a.id) }"
              :title="a.name"
              @click="toggleRef(a.id)"
            >
              <img :src="a.urls.thumb ?? a.urls.file" :alt="a.name" loading="lazy" />
              <span v-if="form.refIds.includes(a.id)" class="ck"><Icon name="check" :size="11" :stroke-width="2.6" /></span>
            </button>
          </div>
          <div class="muted" style="font-size: 11.5px">已选 {{ form.refIds.length }} 张（点击切换；建议覆盖主要角度/光线）</div>
        </template>
        <div v-else class="muted" style="font-size: 12px">先选项目再挑图（全局素材库不接受项目资产引用）</div>
      </div>

      <div v-if="formErr" class="err-text">{{ formErr }}</div>
      <template #footer>
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>
</template>

<style scoped>
.up-note {
  color: var(--ok);
  font-size: 12px;
}

.hidden-file {
  display: none;
}

/* ---- 分组 ---- */
.section {
  margin-bottom: 4px;
}

.section + .section {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.section-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 10px;
}

/* ---- 两栏行 ---- */
.frow {
  display: flex;
  gap: 12px;
}

.frow .fld {
  flex: 1;
}

/* ---- 声音行：textarea + select 并排 ---- */
.voice-fld {
  margin-bottom: 0;
}

.voice-label {
  display: block;
  margin-bottom: 5px;
}

.voice-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.voice-row .voice-ta {
  flex: 1;
  min-width: 0;
}

.voice-row .voice-sel {
  flex: none;
  width: 220px;
  margin-top: 5px;
  font-size: 12.5px;
}

/* ---- 参考图 ---- */
.refbox {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.rhead {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-2);
}

.thumbs {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding: 3px 2px 7px;
}

.thumb {
  position: relative;
  flex: none;
  width: 58px;
  height: 74px;
  padding: 0;
  border-radius: 7px;
  overflow: hidden;
  border: 2px solid var(--border);
  background: var(--panel-2);
  cursor: pointer;
  transition: border-color 0.15s;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb:hover {
  border-color: rgb(99 102 241 / 55%);
}

.thumb.on {
  border-color: var(--accent);
}

.thumb .ck {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn.tiny {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 7px;
}
</style>
