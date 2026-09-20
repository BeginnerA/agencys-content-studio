# AI 配置与记忆模型

「AI 配置」页（`/settings`）四个能力通道的配置指引，以及本地向量记忆与 embedding 模型说明。

## AI 配置指引（四通道）

「AI 配置」页（`/settings`）按能力分四个 tab；每个 tab 可建多个供应商实例，同类型内 `is_default` 为默认通道（未设默认按 priority）。

| tab | service_type | 说明 |
|---|---|---|
| 文本生成 | `llm` | OpenAI 兼容 Chat Completions；未建实例时回退 `.env` 的 AGENT_LLM_* 网关 |
| 图片生成 | `image` | OpenAI 兼容图片接口（支持在线拉取模型列表） |
| 视频生成 | `video` | 轮询型视频供应商（提交任务 + 轮询回查）；duration / resolution / aspect_ratio 由项目设置与模板 `defaults.video` 级联 |
| 语音合成 | `audio` | OpenAI 兼容 `POST /audio/speech`（mp3 落盘） |

- 密钥只存 `data/secrets.json`（0600，不入库不进 git）；编辑实例时 api_key 留空 = 不改密钥
- 实例可「测试」连通（文本 1 次最小对话 / 图片 1 张真实出图）
- 对应通道未配置时 action 报错带指引（如 `gen_motion` → 视频生成 tab）
- 模板 `defaults` 指定的 `provider`（如 `openai_image`）需存在同 providerKey 实例；不符时按报错指引补建实例，或在项目设置中覆盖 provider
- 提示：视频通道改配置（型号/参数）**立即影响后续任务**（含运行中 run 的待执行任务）——改前请确认型号与项目 `settings.video` 参数兼容
- 「一句话成片」轻松创作能力（M32·Tier A）：视频模型的时长 / 分辨率 / 生成模式档位以服务端「单一真源表」（`apps/server/src/adapters/video-capabilities.ts`）为准——命中背书（MiniMax / 火山 Seedance / 万相 / Pollinations）时预检自动按表推导、前端自动预填，**无需再逐项勾选「已核实」**（执行前预检卡仍可复核，并可「改为手动声明」覆盖）；未背书（如 SiliconFlow，产出时长未文档化）则回退手填实例 extra 的 `creationCapabilities`。前端经 `GET /api/v1/api-configs/video-caps?provider_key=&model=` 查询背书档位
- AI 配置「选中即生成」（M33·Tier A）：新建 / 编辑实例选供应商 + 模型后，系统按服务端「定价真源表」（`apps/server/src/adapters/pricing-capabilities.ts`）**自动带出参考定价**（命中→预填、可改、标注来源锚点；未命中→回落手填并提示核实），与 M32 视频能力档位背书 + 「该通道首个实例自动建议设为默认」共同实现「选模型即生成完整实例草稿」。跨通道建议端点：`GET /api/v1/api-configs/model-suggest?provider_key=&service_type=&model=`。纪律：参考定价**仅用于建实例预填**，不注入事后计价（计价仍是 实例 pricing → 全局 `settings.pricing` → 未计价）；表内只登记经供应商公开定价页核实的条目（首批 DeepSeek / 通义 / 万相图像），未核实一律回落手填、绝不塞通用默认价
- 语音通道可声明情绪透传：实例 extra 设 `emotion_param`（如 `emotion`）+ `emotion_map`（基调词 → 供应商值）后，tts 按台词 `emotion_hint` 自动透传该参数；未声明则仅记录 `asset.params.emotion_key` 不透传
- 扩展参数已结构化（M38·Tier A）：实例表单不再只有一个「鬼才知道配啥」的裸 JSON 框——系统按服务端「扩展参数单一真源表」（`apps/server/src/adapters/extra-params.ts`）为每个供应商**动态渲染已知字段**（音色下拉 / 出图尺寸 / 参考素材 URL 列表 / 生成音频·水印开关 / 随机种子 / 视觉理解勾选 / 火山 `appid`（标必填）等），带中文标签、默认预填、用途说明；前端经 `GET /api/v1/api-configs/extra-schema?provider_key=&service_type=` 拉取字段清单。裸 JSON 降级进「高级 · 其他透传参数」，仅用于真源表未覆盖的自定义网关参数，普通用户无需触碰。轻松创作音色：未配置时按供应商真源默认兜底（阿里→`Cherry`、OpenAI/Pollinations→`alloy`、火山→`BV700_streaming`），**不再强制手填**；SiliconFlow「模型:音色」无通用默认，仍需在「音色」字段显式填写（不猜测、不注入占位音色）
- 音色/尺寸已逐模型化（M39·承接 M38）：扩展参数表单按实例**所选模型**给出专属候选与默认（对齐 Toonflow voices[] 声明范式）——如 qwen3-tts-flash 系 36 音色（含方言/美语）、gpt-4o-mini-tts 11 音色 vs tts-1 系 9、CosyVoice2 官方 8 预置（选后自动拼「模型:音色」存库，未配 voice 时预检直接取模型级默认 alex）；尺寸命中官方档位模型（wan2.7 系 1K/2K/4K、qwen-image-max/plus 仅固定 5 档）呈现下拉，**切换模型后自动联动重拉**（用户手改过的值不被冲掉）。枚举未核实的模型（如 Pollinations elevenlabs/kokoro 实例）仍为文本框且无默认，预检继续显式要求配置（不猜）；事实均逐条来源于供应商文档/实测核实，未注册模型回落 provider 级（行为同 M38）

## 记忆与模型

- 记忆 = 本地向量库（`memories` 通用表 + `bge-small-zh-v1.5` ONNX 推理，512 维）；`memory_recall / memory_write` 为模板可用的两个 action（查询 = 项目域 + 全局合并按相似度排序）
- 模型就绪：`pnpm --filter @acs/server model:prepare`（只检查并打印指引；`-- --download` 经 hf-mirror 优先逐文件下载；`-- --from-toonflow` 兜底复制本地 all-MiniLM，384 维）
- 模型目录：`data/models/bge-small-zh-v1.5/`（`tokenizer.json / config.json / onnx/*.onnx`）；`GET /api/v1/memories/status` 报告模型 / 维度 / 条数 / 待补向量数
- 无模型降级：`memory_*` action 报错并附 `model:prepare` 指引；其余流水线不受影响
