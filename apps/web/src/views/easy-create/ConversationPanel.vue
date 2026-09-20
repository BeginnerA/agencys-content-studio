<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import AssetPickerModal from './AssetPickerModal.vue'
import { assetApi } from '../../lib/api'
import { REF_ROLE_LABELS, REF_VALID_ROLES } from '../../lib/types'
import type {
  Asset,
  CreationChatMessage,
  CreationRefKind,
  CreationRefRole,
} from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
// [M31+] 从素材选取弹窗
const showPicker = ref(false)

// 新消息滚动到底部（尊重 reduced-motion：无平滑）
watch(
  () => [
    props.s.state.detail?.messages.length ?? 0,
    props.s.state.detail?.session.status,
  ],
  () =>
    void nextTick(() => {
      if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
    }),
)

const uploading = () => props.s.uploadingAttachments.value

function submit(): void {
  const text = draft.value.trim()
  if (!text || props.s.state.busySend || uploading()) return
  draft.value = ''
  void props.s.send(text)
}

// [M31] 参考附件：选件即预校验+上传（不计费）；role 默认按 kind 推断可改
function pickFiles(): void {
  fileInput.value?.click()
}
async function onFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  for (const f of files) await props.s.addAttachment(f)
}
// [M31+] 素材弹窗确认：逐个登记为参考（服务端校验/复制；托盘内去重与上限由状态机把守；串行保证托盘顺序）
async function onPickAssets(picked: Asset[]): Promise<void> {
  showPicker.value = false
  for (const a of picked) await props.s.addAssetReference(a)
}
function onRoleChange(clientId: string, role: string): void {
  void props.s.changeAttachmentRole(clientId, role as CreationRefRole)
}
function kindIcon(kind: CreationRefKind): string {
  return kind === 'image' ? 'photo' : kind === 'video' ? 'film' : 'doc'
}

// [M31+] 对话内参考素材：缩略图展示 + 点击查看（复用统一 AssetPreviewer，零新预览实现）
const previewAsset = ref<Asset | null>(null)
const refLoading = ref<number | null>(null)
const isAttachment = (m: CreationChatMessage): boolean =>
  m.payload?.kind === 'attachment' && typeof m.payload.assetId === 'number'
const refAssetId = (m: CreationChatMessage): number => m.payload?.assetId ?? 0
const refKind = (m: CreationChatMessage): CreationRefKind =>
  m.payload?.ref?.kind ?? 'image'
const refRoleLabel = (m: CreationChatMessage): string => {
  const role = m.payload?.ref?.role
  return role ? REF_ROLE_LABELS[role] : '参考'
}
// 文件名：剥离服务端消息前缀「已上传参考素材：」，回退整句
const refName = (m: CreationChatMessage): string =>
  m.content.replace(/^已上传参考素材：/, '').trim() || m.content
// 图片/视频走后端缩略图端点（与方案卡同源 ?v=2 破缓存）；音频无缩略图 → 图标
const refThumb = (m: CreationChatMessage): string | null =>
  refKind(m) === 'image' || refKind(m) === 'video'
    ? `/api/v1/assets/${refAssetId(m)}/thumb?v=2`
    : null
async function openRefPreview(m: CreationChatMessage): Promise<void> {
  const id = refAssetId(m)
  if (!id || refLoading.value === id) return
  refLoading.value = id
  try {
    const { asset } = await assetApi.detail(id)
    previewAsset.value = asset
  } catch (e) {
    props.s.state.error = `无法打开参考素材：${(e as Error).message}`
  } finally {
    refLoading.value = null
  }
}

// 追问问题：点击填入输入框，便于用户直接作答
function useQuestion(q: string): void {
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n${q}` : q
}

const planning = () =>
  props.s.state.detail?.session.status === 'planning' || props.s.state.busySend
</script>

<template>
  <section class="conv panel" aria-label="创作对话">
    <div ref="scroller" class="msgs" role="log" aria-live="polite">
      <div v-if="!s.state.detail?.messages.length" class="hello">
        <span class="hello-ic">
          <Icon name="sparkles" :size="20" />
        </span>
        <p class="hello-t">用一句话描述你想做的视频</p>
        <p class="muted">比如「做一条 30 秒的咖啡科普短视频，轻松一点」。</p>
        <p class="muted">
          未指定时默认竖屏 9:16、中文旁白、30
          秒、动态镜头。产品参数、价格、功效缺失不会编造。
        </p>
      </div>
      <div
        v-for="m in s.state.detail?.messages ?? []"
        :key="m.id"
        class="msg"
        :class="m.role"
      >
        <span class="avatar" :class="m.role" aria-hidden="true">
          <Icon :name="m.role === 'user' ? 'users' : 'wand'" :size="15" />
        </span>
        <div class="mcol">
          <div class="who">{{ m.role === 'user' ? '我' : '策划助手' }}</div>
          <div
            v-if="isAttachment(m)"
            class="bubble ref-bubble"
            role="button"
            tabindex="0"
            :aria-label="'查看参考素材：' + refName(m)"
            :aria-busy="refLoading === refAssetId(m)"
            @click="openRefPreview(m)"
            @keydown.enter.prevent="openRefPreview(m)"
            @keydown.space.prevent="openRefPreview(m)"
          >
            <span class="ref-thumb">
              <img
                v-if="refThumb(m)"
                :src="refThumb(m) ?? ''"
                :alt="refName(m)"
                loading="lazy"
              />
              <Icon v-else :name="kindIcon(refKind(m))" :size="18" />
              <span class="ref-view" aria-hidden="true">
                <Icon name="eye" :size="11" />
              </span>
              <span
                v-if="refLoading === refAssetId(m)"
                class="ref-load"
                aria-hidden="true"
              >
                <Icon name="refresh" :size="16" />
              </span>
            </span>
            <span class="ref-meta">
              <span class="ref-tag">
                <Icon :name="kindIcon(refKind(m))" :size="10" /> 参考 ·
                {{ refRoleLabel(m) }}
              </span>
              <span class="ref-file" :title="refName(m)">{{ refName(m) }}</span>
            </span>
          </div>
          <div v-else class="bubble">{{ m.content }}</div>
          <div
            v-if="m.payload?.kind === 'clarify' && m.payload.questions?.length"
            class="qs"
          >
            <div class="qs-h">
              <Icon name="chat" :size="12" /> 点击下方问题可直接作答
            </div>
            <button
              v-for="(q, i) in m.payload.questions"
              :key="i"
              class="qs-item"
              type="button"
              @click="useQuestion(q)"
            >
              <span class="qs-ic" aria-hidden="true">
                <Icon name="chevron-right" :size="14" />
              </span>
              <span class="qs-tx">{{ q }}</span>
            </button>
          </div>
        </div>
      </div>
      <div v-if="planning()" class="msg assistant">
        <span class="avatar assistant" aria-hidden="true">
          <Icon name="wand" :size="15" />
        </span>
        <div class="mcol">
          <div class="who">策划助手</div>
          <div class="bubble wait">
            <span class="dot" /><span class="dot" /><span class="dot" />
            正在理解需求并生成方案…（本步骤会调用大模型，产生少量费用）
          </div>
        </div>
      </div>
    </div>

    <div v-if="s.state.error" class="err-text pad">{{ s.state.error }}</div>
    <div v-if="s.state.notice && !s.state.error" class="muted pad note-text">
      {{ s.state.notice }}
    </div>

    <form class="composer" @submit.prevent="submit">
      <div v-if="s.state.attachments.length" class="atts">
        <div class="att-h">
          <Icon name="photo" :size="12" /> 参考素材 · 发送后编译进方案并影响制作
        </div>
        <div
          v-for="a in s.state.attachments"
          :key="a.clientId"
          class="att"
          :class="{ 'att-errored': a.error }"
        >
          <span class="att-thumb">
            <img
              v-if="a.thumbUrl"
              :src="a.thumbUrl"
              :alt="a.name"
              loading="lazy"
            />
            <Icon v-else :name="kindIcon(a.kind)" :size="16" />
          </span>
          <span class="att-main">
            <span class="att-name" :title="a.name">{{ a.name }}</span>
            <span class="att-sub">
              <span v-if="a.uploading" class="muted">上传中…</span>
              <span v-else-if="a.error" class="att-err">{{ a.error }}</span>
              <span v-else-if="a.assetId" class="ok">已就绪</span>
            </span>
          </span>
          <select
            class="att-role"
            :value="a.role"
            :disabled="a.uploading"
            :aria-label="'参考用途：' + a.name"
            @change="
              onRoleChange(
                a.clientId,
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option v-for="r in REF_VALID_ROLES[a.kind]" :key="r" :value="r">
              {{ REF_ROLE_LABELS[r] }}
            </option>
          </select>
          <button
            v-if="a.error && !a.uploading"
            class="icobtn"
            type="button"
            title="重试上传"
            aria-label="重试上传"
            @click="s.retryAttachment(a.clientId)"
          >
            <Icon name="refresh" :size="14" />
          </button>
          <button
            class="icobtn"
            type="button"
            title="移除参考"
            aria-label="移除参考"
            @click="s.removeAttachment(a.clientId)"
          >
            <Icon name="x" :size="14" />
          </button>
        </div>
      </div>
      <textarea
        v-model="draft"
        rows="2"
        :maxlength="6000"
        :disabled="planning()"
        placeholder="补充要求或修改方案，例如：换成温暖风格 / 改成图文模式 / 时长 45 秒"
        aria-label="创作需求"
        @keydown.enter.exact.prevent="submit"
      />
      <div class="crow">
        <input
          ref="fileInput"
          class="file-in"
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          @change="onFiles"
        />
        <button
          class="btn sm ghost att-btn"
          type="button"
          :disabled="planning() || uploading()"
          @click="pickFiles"
        >
          <Icon name="upload" :size="13" /> 添加参考
        </button>
        <button
          class="btn sm ghost att-btn"
          type="button"
          :disabled="planning() || uploading()"
          title="从各项目素材库选取存量图 / 视频 / 音频"
          @click="showPicker = true"
        >
          <Icon name="arrange" :size="13" /> 从素材选取
        </button>
        <span class="muted cost-hint">
          <Icon name="alert" :size="12" />
          上传/选取参考本身不计费；参考视频解析会额外调用多模态/转写，媒体制作在确认方案后进行。
        </span>
        <button
          class="btn primary"
          type="submit"
          :disabled="planning() || uploading() || !draft.trim()"
        >
          <Icon name="send" :size="14" />
          {{ uploading() ? '上传中…' : planning() ? '处理中…' : '发送' }}
        </button>
      </div>
    </form>

    <AssetPreviewer
      v-if="previewAsset"
      :assets="[previewAsset]"
      :index="0"
      @close="previewAsset = null"
    />

    <AssetPickerModal
      v-if="showPicker"
      @close="showPicker = false"
      @pick="onPickAssets"
    />
  </section>
</template>

<style scoped>
.conv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hello {
  margin: auto;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
  max-width: 380px;
}

.hello-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  margin-bottom: 10px;
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 35%);
  color: var(--accent-h);
}

.hello-t {
  margin: 0 0 6px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
}

.hello p {
  margin: 4px 0 0;
}

.msg {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.msg.user {
  flex-direction: row-reverse;
}

.avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  margin-top: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.avatar.assistant {
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 34%);
  color: var(--accent-h);
}

.avatar.user {
  background: var(--grad-brand);
  color: #fff;
  box-shadow: 0 4px 12px -6px rgb(79 70 229 / 60%);
}

.mcol {
  min-width: 0;
  max-width: 82%;
  display: flex;
  flex-direction: column;
}

.msg.user .mcol {
  align-items: flex-end;
}

.msg .who {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 4px;
  padding: 0 2px;
}

.bubble {
  display: inline-block;
  padding: 10px 14px;
  border-radius: 13px;
  font-size: 13.5px;
  line-height: 1.68;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-top-left-radius: 5px;
}

.msg.user .bubble {
  background: var(--grad-brand);
  border-color: rgb(99 102 241 / 55%);
  color: #fff;
  border-top-left-radius: 13px;
  border-top-right-radius: 5px;
  box-shadow: 0 6px 18px -12px rgb(79 70 229 / 70%);
}

/* [M31+] 参考素材卡片气泡：缩略图 + 文件名 + 查看角标（整卡可点，键盘可达） */
.ref-bubble {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  max-width: 100%;
  text-align: left;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    box-shadow 0.15s ease;
}

.ref-bubble:hover {
  filter: brightness(1.1);
  box-shadow: 0 8px 20px -12px rgb(79 70 229 / 85%);
}

.ref-bubble:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.ref-thumb {
  position: relative;
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 8px;
  overflow: hidden;
  background: rgb(0 0 0 / 22%);
  border: 1px solid rgb(255 255 255 / 28%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.ref-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ref-view {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  pointer-events: none;
}

.ref-load {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  color: #fff;
}

.ref-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ref-tag {
  font-size: 10.5px;
  opacity: 0.92;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.ref-file {
  font-size: 12.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}

.msg.assistant .bubble.wait {
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--run);
  display: inline-block;
  animation: blink 1.1s infinite;
}

.dot:nth-child(2) {
  animation-delay: 0.18s;
}

.dot:nth-child(3) {
  animation-delay: 0.36s;
}

.qs {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* 追问区标题：点明“可点击直接作答”的交互预期 */
.qs-h {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-3);
  padding-left: 2px;
}

.qs-h .ic {
  color: var(--accent-h);
}

/* 建议卡：左对齐整宽卡片（替代旧胶囊 pill），前置动作图标 + 悬停反馈 */
.qs-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border-strong);
  background: var(--raised);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.55;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}

.qs-ic {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 30%);
  color: var(--accent-h);
  margin-top: 1px;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.qs-tx {
  min-width: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.qs-item:hover {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: 0 6px 16px -12px rgb(79 70 229 / 70%);
  transform: translateX(2px);
}

.qs-item:hover .qs-ic {
  background: var(--grad-brand);
  border-color: transparent;
  color: #fff;
}

.qs-item:active {
  transform: translateX(0);
}

.qs-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.pad {
  padding: 0 16px;
  margin: 0;
}

/* 托盘提示（如重复选取）：弱于错误的中性反馈，避免误报红色 */
.note-text {
  padding-bottom: 6px;
  line-height: 1.5;
}

.composer {
  border-top: 1px solid var(--border);
  padding: 13px 16px;
  background:
    linear-gradient(180deg, transparent, rgb(99 102 241 / 4%)), var(--panel);
}

.composer textarea {
  font-size: 13.5px;
  line-height: 1.6;
}

.crow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 9px;
  flex-wrap: wrap;
}

.cost-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  text-align: right;
  line-height: 1.4;
}

.cost-hint .ic {
  color: var(--warn);
  flex: none;
}

.file-in {
  display: none;
}

.att-btn {
  flex: none;
}

.atts {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  padding: 9px 11px;
  margin-bottom: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.att-h {
  font-size: 11.5px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.att-h .ic {
  color: var(--accent-h);
}

.att {
  display: flex;
  align-items: center;
  gap: 8px;
}

.att-thumb {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--raised);
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.att-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.att-main {
  min-width: 0;
  /* 全局 select{width:100%} 曾把用途下拉撑满整行、文件名挤成竖排；下方 .att-role width:auto 修正后，这里再给最小可读宽度兜底 */
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.att-name {
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-sub {
  font-size: 11px;
}

.att-sub .ok {
  color: var(--run);
}

.att-err {
  color: var(--bad);
}

.att-role {
  flex: none;
  width: auto; /* 覆盖全局 select{width:100%}，防止撑满 .att 行挤没文件名 */
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 7px;
  background: var(--raised);
  border: 1px solid var(--border-strong);
  color: var(--text);
}

.icobtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: none;
  border: 1px solid transparent;
  color: var(--text-3);
  cursor: pointer;
}

.icobtn:hover {
  border-color: var(--border-strong);
  color: #fff;
}

@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
  }

  .qs-item,
  .qs-item:hover,
  .qs-item:active {
    transform: none;
  }
}
</style>
