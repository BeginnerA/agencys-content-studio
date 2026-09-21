<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import Icon from '../../common/Icon.vue'
import { TRANSITION_OPTIONS } from './internals'
import type { InspectorApi, InspectorForm } from './use-inspector-form'

const props = defineProps<{
  node: CanvasDocNode
  form: InspectorForm
  saveSpec: InspectorApi['saveSpec']
  openExpand: InspectorApi['openExpand']
  doExtract: InspectorApi['doExtract']
  openBrush: InspectorApi['openBrush']
}>()
const form = props.form
</script>

<template>
  <!-- ===== gen：spec 表单 ===== -->
  <template v-if="node.kind === 'gen'">
    <section class="sec">
      <div class="sec-h">生成参数</div>
      <div class="frow">
        <label class="flabel">生成类型</label>
        <select v-model="form.fGenKind">
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频（TTS）</option>
          <option value="compose">音视频合成</option>
          <option value="llm">LLM 文本处理</option>
        </select>
      </div>
      <div v-if="form.fGenKind !== 'compose'" class="frow">
        <label class="flabel">{{
          form.fGenKind === 'audio'
            ? '朗读文本'
            : form.fGenKind === 'llm'
              ? '指令'
              : '提示词'
        }}</label>
        <textarea
          v-model="form.fPrompt"
          rows="3"
          :placeholder="
            form.fGenKind === 'audio'
              ? '要朗读的文本…（留空则取「提示词」端口连线的文本节点）'
              : form.fGenKind === 'llm'
                ? '给 LLM 的指令（如：总结要点 / 改写风格 / 描述画面），留空则取「提示词」端口'
                : form.fEditMode === 'inpaint'
                  ? '要画什么（局部重绘必填）'
                  : form.fEditMode === 'erase'
                    ? '可留空（走消除默认提示词）'
                    : '描述要生成的画面…'
          "
        />
        <div class="frow-ops">
          <button
            type="button"
            class="btn sm"
            :disabled="form.opBusy || form.expandBusy"
            title="AI 扩写提示词/文本"
            @click="openExpand"
          >
            <Icon name="sparkles" :size="12" /> AI 扩写
          </button>
          <button
            type="button"
            class="btn sm"
            :disabled="form.opBusy"
            title="提取为独立文本节点"
            @click="doExtract"
          >
            <Icon name="doc" :size="12" /> 提取文本节点
          </button>
        </div>
      </div>
      <div v-if="form.fGenKind === 'image'" class="frow">
        <label class="flabel">画面尺寸</label>
        <input
          v-model="form.fSize"
          type="text"
          placeholder="如 832x1248（留空走项目/模板默认）"
        />
      </div>
      <template v-else-if="form.fGenKind === 'video'">
        <div class="frow">
          <label class="flabel">时长（秒）</label>
          <input
            v-model="form.fDuration"
            type="number"
            min="1"
            step="1"
            placeholder="如 5（留空走默认）"
          />
        </div>
        <div class="frow">
          <label class="flabel">分辨率</label>
          <input
            v-model="form.fResolution"
            type="text"
            placeholder="如 480p / 768p（留空走默认）"
          />
        </div>
        <div class="frow">
          <label class="flabel">画幅比</label>
          <input
            v-model="form.fAspectRatio"
            type="text"
            placeholder="如 9:16（留空走默认）"
          />
        </div>
      </template>
      <template v-else-if="form.fGenKind === 'audio'">
        <div class="frow">
          <label class="flabel">声线</label>
          <input
            v-model="form.fVoice"
            type="text"
            placeholder="如 zh-CN-XiaoxiaoNeural（留空走设置/实例声线）"
          />
        </div>
        <div class="frow">
          <label class="flabel">语速</label>
          <input
            v-model="form.fSpeed"
            type="number"
            step="0.05"
            min="0.25"
            max="4"
            placeholder="0.25–4（留空默认）"
          />
        </div>
      </template>
      <template v-else-if="form.fGenKind === 'llm'">
        <div class="frow">
          <label class="flabel">采样温度</label>
          <input
            v-model="form.fTemperature"
            type="number"
            step="0.1"
            min="0"
            max="2"
            placeholder="0–2（默认 0.7）"
          />
        </div>
        <div class="frow">
          <label class="flabel">最大 token</label>
          <input
            v-model="form.fMaxTokens"
            type="number"
            step="1"
            min="1"
            max="32000"
            placeholder="1–32000（默认 2048）"
          />
        </div>
        <div class="muted mini">
          输入：参考图（≤ 4）· 文本素材（≤ 4 段，合并为上下文）· 提示词（1
          条，优先级高于本表单指令）。产物为文本资产，可连入图/视频/LLM 节点。
        </div>
      </template>
      <template v-else>
        <div class="frow">
          <label class="flabel">分辨率</label>
          <input
            v-model="form.fResolution"
            type="text"
            placeholder="如 1080x1920（留空跟随首个视频源）"
          />
        </div>
        <div class="frow">
          <label class="flabel">帧率</label>
          <input
            v-model="form.fFps"
            type="number"
            min="1"
            step="1"
            placeholder="如 30（留空跟随源）"
          />
        </div>
        <div class="frow">
          <label class="flabel">画面适配</label>
          <select v-model="form.fFit">
            <option value="pad">信箱补边（完整画面）</option>
            <option value="crop">裁切满幅（铺满画幅）</option>
          </select>
        </div>
        <div v-if="form.fFit === 'crop'" class="warn-t mini">
          裁切会裁掉画面边缘（输入画面比例不一致时铺满整幅）。
        </div>
        <div class="frow">
          <label class="flabel">转场</label>
          <select v-model="form.fTransition">
            <option
              v-for="t in TRANSITION_OPTIONS"
              :key="t.value"
              :value="t.value"
            >
              {{ t.label }}
            </option>
          </select>
        </div>
        <div v-if="form.fTransition !== 'none'" class="frow">
          <label class="flabel">转场时长</label>
          <input
            v-model="form.fTransitionDuration"
            type="number"
            step="0.1"
            min="0.1"
            max="2"
            placeholder="秒（0.1–2，默认 0.5）"
          />
        </div>
        <div class="frow">
          <label class="flabel">背景音乐</label>
          <select v-model="form.fBgmAssetId">
            <option value="">无</option>
            <option
              v-for="a in form.bgmOptions"
              :key="a.id"
              :value="String(a.id)"
            >
              {{ a.name }}
            </option>
          </select>
        </div>
        <template v-if="form.fBgmAssetId">
          <div class="frow">
            <label class="flabel">BGM 音量</label>
            <input
              v-model="form.fBgmVolume"
              type="number"
              step="0.05"
              min="0"
              max="1"
              placeholder="0–1（默认 0.5）"
            />
          </div>
          <label class="chk">
            <input v-model="form.fBgmFade" type="checkbox" />
            <span>BGM 首尾淡入淡出（1.5s）</span>
          </label>
        </template>
        <label class="chk">
          <input v-model="form.fAlign" type="checkbox" />
          <span>音字对齐（视频段 ↔ 音频段依次配对，段长取较长者）</span>
        </label>
        <div class="frow">
          <label class="flabel">字幕</label>
          <select v-model="form.fSubtitle">
            <option value="none">无</option>
            <option value="auto">自动生成（取音轨文本）</option>
            <option value="asset">已有字幕资产</option>
          </select>
        </div>
        <div v-if="form.fSubtitle === 'asset'" class="frow">
          <label class="flabel">字幕资产</label>
          <select v-model="form.fSubtitleAssetId">
            <option value="">选择 SRT 资产…</option>
            <option
              v-for="a in form.subtitleOptions"
              :key="a.id"
              :value="String(a.id)"
            >
              {{ a.name }}
            </option>
          </select>
        </div>
        <div
          v-if="form.fSubtitle === 'asset' && !form.subtitleOptions.length"
          class="muted mini"
        >
          画布中暂无 SRT 资产：可先用「自动生成」产出，或从资产库将 .srt
          送入本画布。
        </div>
        <label v-if="form.fSubtitle !== 'none'" class="chk">
          <input v-model="form.fBurnSubtitles" type="checkbox" />
          <span>烧录字幕到画面（不勾选仅生成 SRT 资产）</span>
        </label>
        <div
          v-if="form.fAlign && form.fTransition !== 'none'"
          class="warn-t mini"
        >
          对齐模式与转场互斥，执行时将禁用转场。
        </div>
        <div
          v-if="form.fSubtitle !== 'none' && !form.fAlign"
          class="warn-t mini"
        >
          字幕生成依赖音字对齐，请先开启「音字对齐」。
        </div>
        <div class="muted mini">
          输入：视频端口（≥1，按连线创建序拼接）＋
          音频端口（可选，混音；有音轨时丢弃视频原声）。对齐开启时：视频段 ↔
          音频段依次配对，短段冻帧/静音补齐。
        </div>
      </template>

      <div class="frow">
        <label class="flabel">编辑模式</label>
        <select v-model="form.fEditMode" :disabled="form.fGenKind !== 'image'">
          <option value="">无（普通生成）</option>
          <option value="inpaint">局部重绘（涂抹后重画）</option>
          <option value="erase">消除（涂抹后去除）</option>
          <option value="outpaint">扩图（向外扩展画布）</option>
        </select>
      </div>
      <div
        v-if="form.fGenKind !== 'image' && form.fEditMode"
        class="muted mini"
      >
        非图片节点不支持编辑模式，保存时将忽略。
      </div>

      <template
        v-if="
          form.fGenKind === 'image' &&
          form.fEditMode &&
          form.fEditMode !== 'outpaint'
        "
      >
        <div class="maskrow">
          <div class="maskinfo">
            <span class="muted">蒙版：</span>
            <span v-if="form.currentMaskId != null" class="mono"
              >资产 #{{ form.currentMaskId }}</span
            >
            <span v-else class="warn-t">未设置（执行前必需）</span>
          </div>
          <button
            type="button"
            class="btn sm"
            :disabled="!form.sourceAsset"
            :title="
              form.sourceAsset
                ? '在源图上涂抹要编辑的区域'
                : '请先连接源图（source 端口）'
            "
            @click="openBrush"
          >
            <Icon name="brush" :size="12" /> 打开蒙版编辑器…
          </button>
        </div>
        <div v-if="!form.sourceAsset" class="muted mini">
          请从上游节点的输出端口连线到本节点左侧的「源图」输入端口，作为编辑底图。
        </div>
      </template>

      <div
        v-if="form.fGenKind === 'image' && form.fEditMode === 'outpaint'"
        class="expandrow"
      >
        <div class="frow3">
          <label class="flabel">旋转角</label>
          <input
            v-model="form.fAngle"
            type="number"
            step="1"
            placeholder="默认"
          />
        </div>
        <div class="frow3">
          <label class="flabel">横向倍率</label>
          <input
            v-model="form.fXScale"
            type="number"
            step="0.1"
            min="1"
            placeholder="如 1.5"
          />
        </div>
        <div class="frow3">
          <label class="flabel">纵向倍率</label>
          <input
            v-model="form.fYScale"
            type="number"
            step="0.1"
            min="1"
            placeholder="如 1.5"
          />
        </div>
      </div>

      <details class="fold">
        <summary>高级（端点覆盖 / 风格预设）</summary>
        <div class="frow">
          <label class="flabel">端点</label>
          <input
            v-model="form.fProvider"
            type="text"
            placeholder="如 aliyun_bailian_image（留空自动解析）"
          />
        </div>
        <div class="frow">
          <label class="flabel">模型</label>
          <input
            v-model="form.fModel"
            type="text"
            placeholder="如 wan2.6-t2i（留空走端点默认）"
          />
        </div>
        <label class="chk">
          <input v-model="form.fStyle" type="checkbox" />
          <span>套用项目风格预设（图片生成）</span>
        </label>
      </details>

      <div class="ops">
        <button
          type="button"
          class="btn sm"
          :disabled="form.opBusy"
          @click="saveSpec"
        >
          <Icon name="check" :size="12" /> 保存 spec
        </button>
        <span v-if="form.formTouched" class="muted mini"
          >有未保存修改（执行时会自动保存）</span
        >
      </div>
    </section>

    <!-- ===== gen：就绪度 ===== -->
    <section class="sec">
      <div class="sec-h">就绪度</div>
      <div v-if="node.specError" class="err-text">{{ node.specError }}</div>
      <template v-else-if="node.readiness">
        <div v-if="node.readiness.ready" class="ok-t">
          <Icon name="check" :size="12" /> 已就绪，可执行
        </div>
        <ul v-else class="prob">
          <li v-for="(p, i) in node.readiness.problems" :key="i">{{ p }}</li>
        </ul>
      </template>
      <div v-if="form.capHint" class="warn-t mini">{{ form.capHint }}</div>
      <ul v-if="form.readinessNotes.length" class="notes">
        <li v-for="(nt, i) in form.readinessNotes" :key="i">{{ nt }}</li>
      </ul>
    </section>
  </template>
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

.frow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.flabel {
  font-size: 11.5px;
  color: var(--text-3);
}

.frow select,
.frow input,
.frow textarea {
  font-size: 12.5px;
  padding: 6px 9px;
}

.frow3 {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.frow3 input {
  font-size: 12px;
  padding: 5px 8px;
}

.expandrow {
  display: flex;
  gap: 8px;
}

.maskrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.maskinfo {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.fold summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}

.fold summary:hover {
  color: #fff;
}

.fold {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.chk {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.chk input {
  width: auto;
}

.ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

.ok-t {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ok);
}

.warn-t {
  font-size: 12px;
  color: var(--warn);
}

.prob {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

/* ===== [M17] 新增块：frow-ops / notes / vsel / 画廊 / 弹窗 ===== */
.frow-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}
</style>
