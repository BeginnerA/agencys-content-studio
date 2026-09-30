# M55 本地全类型模型接入 Spec（双轨：LocalAI + ComfyUI）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

> 把用户自部署的 **LocalAI**（单二进制覆盖 LLM/图/视频/TTS/ASR/音乐）与 **ComfyUI**（节点式图/视频）作为两条本地轨接入。
> 判据沿用项目既有 doctrine：**接入看协议、不看位置**——说 OpenAI 方言的通道零代码挂 `openai_*` 行；私有协议通道在 kit 写适配器 + 宿主立目录行。

## 0. 前置裁定与红线（立项依据）

- **分类裁定**：LocalAI / ComfyUI 属「本地运行时真厂商」，与 `ollama`（本地）同源先例（VENDOR_SEEDS 内置款，非云端聚合网关）。因此**允许为其私有协议的视频/音乐按「厂商×能力」逐行逐适配器**，不受「非模型供应商网关遇私有协议整体移除」红线约束。该红线针对的是 SiliconFlow/Pollinations/OpenRouter 这类**云端模型聚合网关**，与用户自持的本地运行时性质不同。
- **解冻 kit**：本方案在 ai-provider-kit 新增协议适配器（改 `src/`）。本地联调期宿主将 `@agencys/ai-provider-kit` 切为源码直连（`pnpm link` → `link:../../../ai-provider-kit` + `main: ./src/index.ts`，tsx 运行、无构建产物），故新增适配器即时生效、无需发布/安装仪式；此 `link:` 仅供本地联调，**不得提交**（发布须 commit+tag+push 回到 git-tag 消费模型）。kit `package.json` 版本随附 bump（0.3.0 → 0.4.0）仅作 changelog 礼节。按「架构变更立项规范」单独立里程碑（本文 M55），不并入顺手重构。
- **用户授权**：全类型范围 + kit 新适配器 + 双轨，均由用户显式拍板，符合「禁止擅自新增未认可厂商目录行」。

## 1. 契约核实（官方文档坐实，禁止凭二级源）

| 能力 | LocalAI 端点（官方坐实） | 形态 | 结论 |
|---|---|---|---|
| LLM | `POST /v1/chat/completions` | OpenAI 兼容 | 零代码 |
| 图片-文生图 | `POST /v1/images/generations` | OpenAI 兼容（`data[].url/b64_json`，`response_format` 可选） | 零代码挂 `openai_image` |
| 图片-参考图 | `POST /v1/images/generations` + JSON `ref_images[]`（Flux Kontext）/ img2img `file` 字段 | **非** OpenAI `/images/edits` multipart | 需专属 `localai_image` 适配器 |
| 图片-放大 | `POST /v1/images/upscale`（multipart `model/scale/image`） | LocalAI 私有 | 可选，本期不接 |
| 视频 | `POST /video`（**根路径，非 /v1**）体 `{model,prompt,start_image,end_image,audio,width,height,num_frames,fps,seconds,size,seed,cfg_scale,step,response_format,params}`；响应 `{created,id,data:[{url\|b64_json}]}` | 同步直返、无轮询、非 Sora 协议 | 需 `localai_video` 适配器 |
| TTS | `POST /v1/audio/speech` | OpenAI 兼容（另存 `/tts` 私有别名） | 零代码挂 `openai_audio` |
| ASR | `POST /v1/audio/transcriptions` | OpenAI 兼容；`verbose_json` + `segments` 逐字时间戳**保真度待实机坐实** | 配音零代码；对白严格转写列为门禁项 |
| 音乐 | `POST /v1/sound-generation`（ElevenLabs 兼容）体 `{model_id,text,instrumental,duration_seconds,lyrics,bpm,keyscale,language,...}`；ACE-Step/musicgen 亦可经 `/v1/audio/speech` | 二进制音频直返（Content-Type=audio/*）、同步 | 需 `localai_music` 适配器（generate 收字节即契约） |

ComfyUI：图片/视频**均为** `POST /prompt` + WebSocket / `GET /history/{id}` 任务模型，无任何 OpenAI 端点 → 图/视频各需专属适配器；无 TTS/ASR/LLM/音乐能力。

## 2. 能力矩阵与接入路径

| 通道 | LocalAI | ComfyUI | 路径 |
|---|---|---|---|
| LLM | 零代码 | — | 实例挂 `openai_llm`，baseUrl 指 `:8080/v1` |
| 图片-文生图 | 零代码 | 新适配器 | LocalAI 挂 `openai_image`；ComfyUI `comfyui_image` |
| 图片-参考图 | 新适配器 | 新适配器 | `localai_image`（ref_images）/ `comfyui_image`（工作流输入节点） |
| 视频 | 新适配器 | 新适配器 | `localai_video`（/video 同步）/ `comfyui_video`（/prompt+WS） |
| TTS | 零代码 | — | 挂 `openai_audio` |
| ASR | 零代码（配门禁） | — | 挂 `openai_audio`，`asr_model/asr_protocol` 达标才入对白严格链 |
| 音乐 | 新适配器 | 不做 | `localai_music`（端点先坐实） |

## 3. 代码改动分区

### 3.1 ai-provider-kit（新增适配器与目录真源）

- `protocols/image/localai-image.ts`：`provider='localai_image'`，`referenceImages:'base64'`。
  - 文生图：`POST {base}/v1/images/generations`，请求 `response_format:'b64_json'`（规避 `/generated-images/…` 相对 url 不可达）；解析 `data[0].b64_json|url`。
  - 参考图：`referenceImages` 存在且非空 → 同一 `/v1/images/generations` 体加 `ref_images:[dataURI...]`（Flux Kontext 语义），**不走** OpenAIImageAdapter 的 multipart `/images/edits`。
  - `size` 透传 WxH；`extra.negative_prompt` 透传 `negative_prompt`。
- `protocols/video/localai-video.ts`：`provider='localai_video'`，`firstFrame:'base64'`、`referenceImages:'none'`。
  - `generate()`：单次 `POST {root}/video`（root 去 `/v1` 尾缀），映射 `prompt/model/start_image(=firstFrameUrl|imageUrl)/num_frames|fps|seconds(=duration)/width|height(=resolution)/seed`，`response_format:'b64_json'`；解析 `data[0].b64_json|url` → `GeneratedVideo`。
  - `query()`：同步协议，抛「不支持二次查询」或返回 completed（generate 已直返，管线不调用）。
  - `probe()`：`GET {base}/v1/models`（零成本，验可达+鉴权占位）。
- `protocols/image/comfyui-image.ts` + `protocols/video/comfyui-video.ts`：
  - `generate()`：`POST {base}/prompt` 提交工作流 JSON（模板来自实例 `extra.workflow_json`，占位符 `{{prompt}}/{{seed}}/{{width}}/{{height}}/{{frames}}/{{fps}}` 与首帧输入节点 `extra.image_node_id` 由适配器注入）→ 拿 `prompt_id` → `GET {base}/history/{prompt_id}` 轮询（默认 3s 间隔，长超时）→ 取输出节点产物 → `GET {base}/view?filename=&subfolder=&type=` 收字节转 base64。
  - `probe()`：`GET {base}/system_stats`。
  - 与图像适配器混合模式原则一致：内部轮询收字节，对管线呈同步契约。
- `protocols/music/localai-music.ts`：`provider='localai_music'`。`POST {base}/v1/sound-generation`（ElevenLabs 兼容），体 `{model_id,text,instrumental,duration_seconds,lyrics,...}` → 二进制直收返 `GeneratedMusic`（同步，无轮询）。
- `registry.ts`：`imageAdapters` 加 `localai_image/comfyui_image`；`videoAdapters` 加 `localai_video/comfyui_video`；`musicAdapters` 加 `localai_music`。
- `catalog/video-caps.ts`：为 `localai_video/comfyui_video` 增**已背书档位**（LocalAI：`num_frames/fps`→时长档、默认 512x512/832x480 等保守画幅；ComfyUI：按核实工作流）。未核实模型保持 fail-closed 返 null，须实例显式声明。
- `catalog/extra-params.ts`：新增 `localai_image`（size/negative_prompt）、`localai_video`（num_frames/fps/step/cfg_scale/seed/width/height）、`comfyui_image/video`（workflow_json/seed/尺寸/输入节点映射）schema 分支；`resolveExtraSchema` 覆盖。
- `index.ts`：透传新适配器/纯函数导出（供探针直接契约测试）。

### 3.2 宿主 agencys-content-studio

- `db/seed.ts`：
  - `VENDOR_SEEDS` += `{vendor:'localai',name:'LocalAI（本地）'}`、`{vendor:'comfyui',name:'ComfyUI（本地）'}`。
  - `PROVIDER_SEEDS` += `localai_image/localai_video/localai_music`（defaultUrl `http://localhost:8080`）与 `comfyui_image/comfyui_video`（defaultUrl `http://localhost:8188`）；`presetModels` 给保守示例并允许在线拉取覆盖。
  - `VENDOR_PRIORITY` 末尾追加 `localai/comfyui`。
  - LLM/TTS/ASR **不新建行**，经既有 `openai_llm/openai_image/openai_audio` 实例承载（baseUrl 指本地，Key 留空/占位）。
  - `seedProviders` 幂等补种；本地轨 pricing 记 0。
- `routes/api-configs.ts`：`TESTABLE_VIDEO_PROVIDER_KEYS` += `localai_video/comfyui_video`（已实现 `probe()`）。audio/image 的 OpenAI 兼容 ping 分支（宿主 `synthSpeech` + kit `testConnection` image 派发）已覆盖本地轨，确认零改动。
- `services/strict-asr.ts`：门槛 `asr_model==='whisper-1' && asr_protocol==='openai_verbose_json'` 不变；LocalAI 若实机坐实返回与之逐字对齐的 verbose_json+segments 则零改动复用，否则该实例只作配音、不入对白严格链（UI 显式提示，不静默降级）。

### 3.3 Web

无新增 Tab（能力页签固定：文本/图片/视频/语音/音乐/密钥），新厂商行落既有页签下，扩展参数表单由 `resolveExtraSchema` 自动渲染；模型在线拉取依赖 `/v1/models`（LocalAI 支持；ComfyUI 无 models 目录 → 手填，走 NO_CATALOG 兜底说明）。

## 4. 分阶段薄切片交付（各自可独立验证、可分别合入）

- **Phase 1｜零代码通道**：LocalAI LLM/TTS/ASR/文生图 纯配置接入 + 文档；坐实 ASR `verbose_json`+segments（实机），达标启用对白、否则标注仅配音。
- **Phase 2｜LocalAI 图（参考图）+ 视频**：`localai_image`/`localai_video` 适配器 + `video-caps` 背书 + 目录行 + 探针 + 实机最小生成。
- **Phase 3｜ComfyUI 图 + 视频**：`comfyui_image`/`comfyui_video`（/prompt+WS/history）+ 工作流 `extra` 约定 + 探针 + 实机。
- **Phase 4｜LocalAI 音乐**：`localai_music` 适配器（`/v1/sound-generation` 已官方坐实）+ 目录行 + `music-gen.ts` 派发覆盖 + 探针。
- 每阶段收口项：kit 适配器 + 宿主目录行 + 契约探针（fetch 桩零成本）+ 实机验证 + 串行 `pnpm probe:ci`（`--jobs=1`）门禁全绿，再进下一阶段。

## 5. 探针与验收（新增 probe-m55.ts）

- **registry 节**：`initDb` 后断言 `localai_*`/`comfyui_*` 目录行已 seed；`video` 服务面含两新行；music 面含 `localai_music`；`kit 注册表 ⊇ 宿主目录`。
- **pure 节**（契约纯函数，零 HTTP）：`buildLocalAIImageBody`（txt2img 带 response_format=b64_json；ref 带 ref_images）、`parseLocalAIImageResponse`（url/b64 双形态）、`buildLocalAIVideoBody`（num_frames/fps/size/seed 映射 + 根路径归一）、`parseLocalAIVideoResponse`（data[0].url|b64_json）、ComfyUI 工作流占位符注入纯函数、history 取产物节点归一。
- **live 节**（`globalThis.fetch` 桩全链路）：LocalAI 图/视频请求出线（端点路径 + b64 解析 + 首帧注入）、ComfyUI `POST /prompt → GET /history → GET /view` 三段链路 + 轮询节奏 + 失败态抛错；`getImageAdapter/getVideoAdapter` 派发与未注册 key 报错口径。
- **实机**：本地拉起服务真跑最小生成（图 256²、视频最小帧、TTS 一句 ping、ASR 样例音、音乐最短段），产出落资产并核字节/时长。

## 6. 风险与约束

- LocalAI 图片默认 `url` 为相对路径 `/generated-images/…` → 适配器统一强制 `response_format=b64_json`。
- 本地视频模型极重（LongCat 仅 CUDA；MiniMax-H3 单次数小时、需宿主 ffmpeg）→ `video-caps` 采保守默认档 + 文档标注硬件门槛，避免误选超时。
- ComfyUI 工作流形态高度自定义 → `extra.workflow_json` 为唯一事实源，适配器只做占位符注入与产物节点定位，不猜工作流内部结构；实机验证以用户给定模板为准。
- 凭证沿用 `ollama` 式「留空/占位」约定（本地无真实 Key），`localai_*`/`comfyui_*` 密钥可空即过 `noApiKey` 守卫（对齐 ollama_llm 现状）。
- ComfyUI 音乐轨不做（无成熟工作流），音乐仅 LocalAI。

## 7. 验证命令

```
cd apps/server
npx tsx scripts/probe-m55.ts                 # 单探针（registry|pure|live）
npx tsx scripts/run-probes.ts --jobs=1        # 权威门禁：全量串行
npm run typecheck                             # kit + server TSC
```
