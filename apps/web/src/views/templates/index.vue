<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import TemplateHelpModal from '../../components/template/TemplateHelpModal.vue'
import TemplateListPanel from './TemplateListPanel.vue'
import TemplateEditorPanel from './TemplateEditorPanel.vue'
import PromptListPanel from './PromptListPanel.vue'
import PromptEditorPanel from './PromptEditorPanel.vue'
import { useTemplates } from './use-templates'
import { usePrompts } from './use-prompts'

// ===== 顶层页签：模板 / 提示词 =====
const tab = ref<'tpl' | 'prompt'>('tpl')

const t = useTemplates()
const p = usePrompts({ refreshMetas: t.refreshMetas })
const {
  helpDlg,
  newDlg,
  newKey,
  newErr,
  creating,
  copyDlg,
  copyKey,
  copyErr,
  copying,
  doCreate,
  doCopy,
  refreshMetas,
} = t
const {
  newPromptDlg,
  newPromptName,
  newPromptErr,
  newPromptCreating,
  doCreatePrompt,
  refreshPrompts,
} = p

onMounted(() => {
  void refreshMetas(true)
  void refreshPrompts()
})
</script>

<template>
  <div>
    <div class="page-h">
      <h1>模板</h1>
      <span class="sub">workspace 文件即事实源 · 保存后下一 run 即时生效</span>
      <div class="tabs" role="tablist" aria-label="模板与提示词切换">
        <button
          class="tab"
          role="tab"
          :aria-selected="tab === 'tpl'"
          :class="{ on: tab === 'tpl' }"
          @click="tab = 'tpl'"
        >
          <Icon name="doc" :size="13" /> 模板
        </button>
        <button
          class="tab"
          role="tab"
          :aria-selected="tab === 'prompt'"
          :class="{ on: tab === 'prompt' }"
          @click="tab = 'prompt'"
        >
          <Icon name="sparkles" :size="13" /> 提示词
        </button>
      </div>
    </div>

    <!-- ===== 模板页签 ===== -->
    <div v-if="tab === 'tpl'" class="split">
      <TemplateListPanel :t="t" />

      <TemplateEditorPanel :t="t" />
    </div>

    <!-- ===== 提示词页签 ===== -->
    <div v-else class="split">
      <PromptListPanel :p="p" />

      <PromptEditorPanel :p="p" />
    </div>

    <!-- 字段速查 -->
    <TemplateHelpModal v-if="helpDlg" @close="helpDlg = false" />

    <!-- 新建模板 -->
    <Modal v-if="newDlg" title="新建模板" :width="500" @close="newDlg = false">
      <label class="fld">
        key（文件名，仅字母/数字/下划线/中划线）
        <input
          v-model="newKey"
          type="text"
          placeholder="my-template"
          @keydown.enter="doCreate"
        />
      </label>
      <div class="muted" style="margin-bottom: 10px">
        将以最小骨架创建（从素材导入起步），创建后直接进入编辑器。
      </div>

      <div class="caps">
        <div class="caps-h">一个模板可以配置什么？</div>
        <ul class="caps-list">
          <li>
            <span class="caps-t">启动表单</span
            >——运行时先让使用者填写的内容（文字 / 数字 / 开关 / 文件）
          </li>
          <li>
            <span class="caps-t">流水线步骤</span
            >——按顺序执行的动作：写稿、出图、配音、合成……
          </li>
          <li>
            <span class="caps-t">人工审阅闸门</span>——关键步骤暂停，等你批准 /
            驳回 / 跳过
          </li>
          <li>
            <span class="caps-t">批量与条件</span
            >——数组字段逐项批量执行；满足条件才执行某一步
          </li>
          <li>
            <span class="caps-t">默认参数</span>——模型 / 音色 /
            尺寸等预设，可在项目里覆盖
          </li>
          <li>
            <span class="caps-t">上下游接力</span
            >——完成后推荐下一个模板（运行页「下一步建议」）
          </li>
        </ul>
        <div class="caps-tip">改完点「字段速查」可查每个字段怎么填。</div>
      </div>
      <div v-if="newErr" class="err-text">{{ newErr }}</div>
      <template #footer>
        <button class="btn" @click="newDlg = false">取消</button>
        <button class="btn primary" :disabled="creating" @click="doCreate">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </template>
    </Modal>

    <!-- 另存为副本 -->
    <Modal
      v-if="copyDlg"
      title="另存为副本"
      :width="420"
      @close="copyDlg = false"
    >
      <label class="fld">
        新 key
        <input v-model="copyKey" type="text" @keydown.enter="doCopy" />
      </label>
      <div class="muted" style="margin-bottom: 8px">
        当前编辑器内容将存为新模板（yaml 内 key 同步替换）
      </div>
      <div v-if="copyErr" class="err-text">{{ copyErr }}</div>
      <template #footer>
        <button class="btn" @click="copyDlg = false">取消</button>
        <button class="btn primary" :disabled="copying" @click="doCopy">
          {{ copying ? '创建中…' : '创建副本' }}
        </button>
      </template>
    </Modal>

    <!-- 新建提示词 -->
    <Modal
      v-if="newPromptDlg"
      title="新建提示词"
      :width="460"
      @close="newPromptDlg = false"
    >
      <label class="fld">
        文件相对路径（支持子目录）
        <input
          v-model="newPromptName"
          type="text"
          placeholder="cover-talking.md"
          @keydown.enter="doCreatePrompt"
        />
      </label>
      <div class="muted" style="margin-bottom: 8px">
        将在 workspace/prompts 下创建空文件（限定目录内，防越界）
      </div>
      <div v-if="newPromptErr" class="err-text">{{ newPromptErr }}</div>
      <template #footer>
        <button class="btn" @click="newPromptDlg = false">取消</button>
        <button
          class="btn primary"
          :disabled="newPromptCreating"
          @click="doCreatePrompt"
        >
          {{ newPromptCreating ? '创建中…' : '创建' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ---------- 页签 ---------- */
.tabs {
  margin-left: auto;
  display: inline-flex;
  gap: 3px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 3px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  padding: 5px 13px;
  border-radius: 7px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}

.tab:hover {
  color: var(--text);
  background: var(--hover);
}

.tab.on {
  background: linear-gradient(
    135deg,
    rgb(139 92 246 / 26%),
    rgb(79 70 229 / 22%)
  );
  color: #fff;
}

/* ---------- 分栏骨架 ---------- */
.split {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

/* ---------- [说明书改造] 新建弹窗能力清单 ---------- */
.caps {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
}

.caps-h {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 7px;
}

.caps-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 5px;
}

.caps-list li {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}

.caps-t {
  color: var(--text);
  font-weight: 500;
}

.caps-tip {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
