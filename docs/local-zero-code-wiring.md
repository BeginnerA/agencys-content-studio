# M55 Phase 1｜本地模型「零代码通道」接线说明（LocalAI via `openai_*`）

> 判据：**接入看协议、不看位置**。LocalAI 中凡说 OpenAI 方言的通道（LLM / TTS / ASR / 文生图）**不新建目录行、不写适配器**——
> 只在既有 `openai_llm` / `openai_audio`（以及可选 `openai_image`）下建**实例**，把 `baseUrl` 指向本地端点即可。
> ComfyUI 无 OpenAI 方言端点（图/视频均为 `/prompt`+history 私有任务模型），**不属于本通道**，见 §4。
> 本文件只讲「改配置不改代码」的接入；私有协议能力（参考图/视频/音乐）见 [`docs/records/local-model-integration-spec.md`](./records/local-model-integration-spec.md) §3。

## 1. 前置：LocalAI 侧

- 部署含对应后端的 LocalAI，默认监听 `http://localhost:8080`，OpenAI 兼容前缀 `/v1`。
- 本地无真实密钥：`openai_*` 实例仍要求**非空** Key（kit `resolveEndpoint` 空 Key 抛 `noApiKey`），填占位串即可（如 `not-needed`），LocalAI 通常忽略鉴权。
  - 例外：本地轨专属适配器行（`localai_image/video/music`、`comfyui_image/video`）由宿主 `NO_AUTH_PROVIDER_KEYS` 旁路，**留空即过**（见 §3 与 spec §6）。

## 2. 逐通道接线（实例配置项）

| 通道 | 目录行（provider） | 实例 `baseUrl` | 模型 | 备注 |
|---|---|---|---|---|
| LLM | `openai_llm`（OpenAI（LLM）） | `http://localhost:8080/v1` | 在线拉 `/v1/models` 或手填（如 `codellama`） | `POST /v1/chat/completions`，标准 OpenAI 兼容 |
| TTS（配音） | `openai_audio`（OpenAI 语音） | `http://localhost:8080/v1` | 如 `tts-1` / Piper 后端模型 | `POST /v1/audio/speech`，OpenAI 兼容 |
| ASR（转写） | `openai_audio` | `http://localhost:8080/v1` | `whisper-1`（LocalAI 兼容别名） | `POST /v1/audio/transcriptions`，**严格对白见 §3 门禁** |
| 图片-文生图 | `localai_image`（推荐，Phase 2）/ `openai_image`（可选） | `http://localhost:8080/v1`（openai_image）或 `http://localhost:8080`（localai_image） | 如 `stablediffusion` / flux | 见下方「文生图取舍」 |

- 入口：Web「AI 配置」页 → 对应能力页签（文本/语音/图片）→ 选 provider → 新建实例填上述 `baseUrl` 与占位 Key。
- 「测试连接」：LLM/音频走 OpenAI 兼容 ping；本地服务可达即通过。

### 文生图取舍（重要）
LocalAI `/v1/images/generations` 默认响应里的 `data[].url` 是**相对路径** `/generated-images/…`，通用 `openai_image` 适配器不强制 `b64_json`，可能取不到图。
因此：
- **推荐**走 Phase 2 的 `localai_image` 适配器行（内部强制 `response_format=b64_json`，且覆盖参考图 `ref_images`）。
- 若坚持零代码 `openai_image`：仅在 LocalAI 已配置为返回可访问绝对 URL 时才可靠；否则改走 `localai_image`。

## 3. ASR 严格对白门禁（`verbose_json` + segments）

人物对白转写走「宽容失败」不可接受的严格链路（`services/strict-asr.ts`），门槛为实例 `extra` 同时满足：

```json
{ "asr_model": "whisper-1", "asr_protocol": "openai_verbose_json", "policy": "verbatim-segments-v1" }
```

- **达标**：LocalAI 的 `/v1/audio/transcriptions` 在 `response_format=verbose_json` 下返回与 OpenAI **逐字对齐**的 `segments[]`（含逐字时间戳）→ 该实例可直接用于对白严格转写，零代码改动。
- **未达标（默认保守）**：LocalAI 各后端 `verbose_json` 分段保真度**未经实机坐实**前，**不得**勾选 `openai_verbose_json`。此时该 ASR 实例只作**配音/非对白**用途；对白严格链会显式报 `missing_asr` 提示，而非静默降级。
- 验收动作（实机）：对同一段样例音频，核对 `segments` 是否含 `start/end/text` 且与 OpenAI 口径一致，再决定是否启用 `asr_protocol=openai_verbose_json`。若字段有出入，需在 kit `extra-params` 扩候选值并同步解析器（一处真源，两处对齐），本期不预设。

## 4. ComfyUI 不走零代码通道

ComfyUI 图片/视频均为 `POST /prompt` → `GET /history/{id}` → `GET /view` 私有任务模型，无任何 OpenAI 方言端点，且无 `/v1/models`（模型手填）。
→ 只能通过 Phase 3 的专属适配器行 `comfyui_image` / `comfyui_video` 接入，实例 `extra.workflow_json` 为唯一工作流事实源。详见 [`docs/records/local-model-integration-spec.md`](./records/local-model-integration-spec.md) §1、§3。

## 5. 验证清单（Phase 1）

1. 拉起 LocalAI，确认 `/v1/models` 可访问。
2. LLM：`openai_llm` 实例（baseUrl 指 `:8080/v1`、占位 Key）→ 测试连接通过 → 一次最小对话。
3. TTS：`openai_audio` 实例 → 合成一句 → 资产落音频、核字节。
4. ASR：样例音频跑 `verbose_json`，按 §3 判定是否启用严格对白；未达标则标注「仅配音」。
5. 图片：优先 `localai_image`（Phase 2 行）出 256²；或对 `openai_image` 验绝对 URL 可用。
6. 回归：`cd apps/server && npx tsx scripts/probe-m55.ts`（registry 断言本地轨目录行/注册表/caps 全绿）。
