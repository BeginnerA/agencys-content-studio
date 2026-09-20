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

## 记忆与模型

- 记忆 = 本地向量库（`memories` 通用表 + `bge-small-zh-v1.5` ONNX 推理，512 维）；`memory_recall / memory_write` 为模板可用的两个 action（查询 = 项目域 + 全局合并按相似度排序）
- 模型就绪：`pnpm --filter @acs/server model:prepare`（只检查并打印指引；`-- --download` 经 hf-mirror 优先逐文件下载；`-- --from-toonflow` 兜底复制本地 all-MiniLM，384 维）
- 模型目录：`data/models/bge-small-zh-v1.5/`（`tokenizer.json / config.json / onnx/*.onnx`）；`GET /api/v1/memories/status` 报告模型 / 维度 / 条数 / 待补向量数
- 无模型降级：`memory_*` action 报错并附 `model:prepare` 指引；其余流水线不受影响
