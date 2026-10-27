# M66 AIGC 合规标识（design）

> 状态：✅ 已实施（2026-10-27）。来源：市面专业工具能力差距分析 → 用户确认开发（优先级第 1 项）。
> 关联：M19 成片品质与品牌化（三层品牌配置真源）、M12 图像检测（旁路不阻断先例）、M29 版本与追溯（旁路记录同律）、M50 剪辑工程交换包。

## 一、背景与触发

《人工智能生成合成内容标识办法》（网信办等四部门，2025-03-14 发布、**2025-09-01 施行**）第五条强制要求：生成合成内容须添加**显式标识**（文字/声音/图形提示）与**文件元数据隐式标识**；配套强制性国标 GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》规定元数据隐式标识六字段：`Label` / `ContentProducer` / `ProduceID` / `ReservedCode1` / `ContentPropagator` / `PropagateID`（字段语义参考闪剪 AI 开放平台实现范例与普华永道合规解读）。

**现状缺口（代码级坐实）**：本仓已有敏感词审核（`services/compliance.ts`）与品牌化水印（`ffmpeg-merge/watermark.ts` + `args.ts` overlay 链），但生成产物**零合规标识**——既无元数据隐式标识，也无显式「AI生成」提示；品牌水印不满足《标识办法》的标识要求。

**决策留痕（用户确认，2026-10-26）**：
- 范围 = **视频 + 图像做显式+隐式；音频做隐式；文本产物跳过**（文案标识由发布平台处理）。
- 显式角标**默认开、三层（平台/项目/run）逐级可关**（平台发布时自有打标场景由用户自行关闭）。
- 隐式元数据**始终写入、不可关**。

## 二、现状（代码级真源）

- **AI 生成媒体落盘单一咽喉**：[`services/net.ts::saveGeneratedMedia`](../../apps/server/src/services/net.ts)（L31 起）——`pipeline/actions/ai-image.ts`（L372）、`ai-video.ts`（L457）、`services/entity-refgen.ts`（L377）、`services/creation/gen/execute.ts`（L192）全部经此落盘登记。
- **语音/音乐**：`pipeline/actions/tts.ts`（L251）、`strict-tts.ts`（L50）、`services/music-gen.ts`（L49）各自 `registerAsset`。
- **成片**：`pipeline/actions/ffmpeg-merge/index.ts`（L641 成片 / L716 封面 / L740 派生）、`manual-display.ts`（L309 起）。
- **发布包**：`services/export.ts`（collectRunAssets → zip，L135 登记 archive）。
- **品牌配置三层模型**：平台 `settings.brand` / 项目 `projects.settings.brand` / run `input._compose.brand`（`services/brand-config.ts`，JSON 存储、`mergeBrand` 字段级覆盖、无新配置时调用方行为逐字不变）。
- **drawtext 基建已有**：`ffmpeg-merge/args.ts` L327/L349 水印 overlay（九宫格 `watermarkOverlayXY`）；`title-card.ts` 已解决 CJK fontfile 解析与 filtergraph 转义（L35/L68）。
- **ffmpeg 内置**（pnpm install 自动下载）——元数据写入与图像打标**零新依赖**。
- 资产 `params` 已是 JSON 列——ProduceID 等留痕走 `params.aigc`，**0 新列**。

## 三、方案（纯加法）

### 3.1 隐式标识（始终写入，不可关）

新服务 `services/compliance-label.ts`：

- `aigcMetadata(opts)`：纯函数产国标六字段 JSON——`Label:"1"`、`ContentProducer`（平台 brand `compliance.producer`，缺省「个人创作者」）、`ProduceID`（`crypto.randomUUID()`）、`ReservedCode1: ""`、`ContentPropagator` / `PropagateID`（生成阶段空串，发布包环节填）。**勘误**：早期版本误列 `ProduceTime` 为规范字段——国标六字段不含它；生成时间仅作非规范溯源入 `params.aigc.produceAt`。
- **写入通道按容器分三路**（技术风险面如实标注）：
  1. **视频（mp4/mov/m4v）与音频（mp3/m4a）**：ffmpeg `-c copy -metadata AIGC=<json>` 重封装（流复制，毫秒级、无重编码）。**勘误**：早期版本误列 wav——ffmpeg wav muxer 对未知 RIFF INFO 键的写入支持已移除（实测丢弃，打标不落盘），`REMUX_FORMAT` 不含 wav，wav 音频按不支持走失败旁路（tags `compliance_failed`）；如需支持可用 `-write_id3v2` TXXX 通道再议（遗留）。
  2. **图像 PNG**：纯 Node **tEXt 块插入**（`zlib.crc32` 计算 CRC；IHDR 块头廉价校验防误插；不动压缩数据——**非 ffmpeg 重封装**，实现期以纯 Node 取代早期 ffmpeg 方案，无重编码风险）。
  3. **图像 JPEG**：ffmpeg 容器级 metadata 写入能力弱 → 纯 Node **APP1 段头部插入**（SOI 后插 `AIGC\0` segment，不动压缩数据，仅长度字段计算，约 40 行零依赖）。
- **挂点（显式调用，导入素材不打标）**：`saveGeneratedMedia`（一处覆盖全部 AI 图像/视频）、`tts.ts` / `strict-tts.ts` / `music-gen.ts`；成片合成不重封装——merge 命令直接追加 `-metadata AIGC=`。实现计划须**枚举 `saveGeneratedMedia` 全部调用面核对 origin**（若混有非 AI 生成保存，加 `origin: 'ai' | 'imported'` 可选参数区分，缺省 `'ai'`，抓取/导入调用点显式传 `'imported'`——纯加法）。
- 留痕：`asset.params.aigc = { produceId, produceTime }`。
- **失败旁路**：写入失败不阻断生成——产物照常入库，`createLogger` warn + 资产 tags 追加 `compliance_failed`（下划线键；对齐 M12 检测 / M29 `safeRecordExecSnapshot` 先例，可见不静默）。

### 3.2 显式角标（默认开，逐级可关）

- `BrandConfig` 新增可选节 `compliance?: { enabled?: boolean; text?: string; position?: WatermarkPosition; margin_px?: number; producer?: string }`——复用 `mergeBrand` 字段级三层覆盖；`enabled` 平台层缺省 **true**；文字缺省「AI生成」、位置缺省 `br`、边距 24。**行为变更如实声明**：`enabled` 缺省即开，存量用户合成成片将开始出现角标——这是本里程碑的预期行为变更（用户决策「默认开」）；唯一逐字节不变式是 `enabled:false` 时输出与现状完全一致。
- **成片合成**（`ffmpeg-merge/args.ts`）：水印 overlay 链后追加 compliance drawtext 链（复用 title-card.ts 字体解析与转义 helper；合成本就重编码，追加零额外成本）。同位重叠（角标与品牌水印同角）**不做自动避让**（YAGNI），由配置错角解决。
- **发布包**（`services/export.ts`）：zip 内**图像产物**产 drawtext 打标副本（单帧，快）；**视频产物不重编码**（成片已在合成时带标；历史无标成片不做重编码——诚实边界，见 §五）；zip 附《AI生成内容说明.txt》声明文件（列 AI 生成产物清单 + ProduceID，`ContentPropagator/PropagateID` 在此环节补齐写入导出副本元数据）。
- 任意层 `enabled:false` → 无角标无声明文件；隐式不受影响。

### 3.3 红线

- **0 新表 0 新列 0 新 action 0 新付费面 0 新依赖**（ffmpeg 内置 + Node 内置 crypto）。
- 隐式标识不可关；显式默认开、逐级可关；关闭显式不影响隐式。
- 失败旁路不阻断生成；不碰文本产物；导入素材不打标。
- 模板 YAML 零改动（横切能力，不进 DAG）。

### 3.4 北极星三问

服务创作闭环？**是**——发布合规是「发布 → 复盘」闭环的准入前提。可模板化？标识为运行时横切能力，模板零感知。通用资产能承载？标识随 `params`/`tags`，资产语义不变。

## 四、验证（probe-m66，isolatedEnv，零付费面）

1. mp4 重封装后 `ffprobe format_tags` 读回 AIGC JSON，六字段逐项断言；
2. PNG tEXt 写入可读；
3. JPEG APP1 插入字节级校验（SOI 正确、APP1 长度字段合法、原压缩数据逐字节不变）；
4. 显式角标：`enabled:on` 时 args 含 drawtext；`off` 时输出 args **与现状逐字节一致**（红线断言）；
5. 三层覆盖合并行为（平台 on / 项目 off / run 缺省）；
6. 发布包：图像副本带标 + 声明文件存在 + 视频不重编码 + PropagateID 写入副本；
7. 导入素材不打标；注入 ffmpeg 失败 → tags `compliance:failed` 且生成不中断。

全仓 `pnpm ci:check` 端到端无回归。

## 五、遗留与边界（诚实标注）

- JPEG APP1 若实现中字节级风险超预期 → 降级「PNG 先行 + JPEG 仅声明文件标注」，在 review 如实记录。
- 历史存量产物（M66 之前生成）：工作区原件不回溯打标（如需回溯改写原件另立项）；发布包实现为**所有视频（含历史存量）**以 `-c copy` 重封装副本打标（非破坏性，原件不动）——早期「发布包对无标视频仅以声明文件兜底」的表述与实现不符，如实更正。
- 画布 compose 未接线：创作画布合成走 `creation/gen/compose-args.ts` 独立 ffmpeg 链，未注入合规角标 drawtext 与 `-metadata AIGC=`（其产物仍可在发布包环节获得重封装打标副本）；如需接线另立项。
- 音频显式标识（语音播报提示音）不做（范围决策：音频仅隐式）。
- 不做角标/水印自动避让；不做标识内容的国家标准全文逐字核对（国标全文付费墙，字段语义以闪剪范例 + 普华永道解读 + 探针互证为准，review 标注剩余不确定度）。
