# M54 智能混剪增强 Spec（photo-montage 二期：智能缓推 / 拼贴版式 / 智能 BGM）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

> 承接 M53（docs/records/photo-montage-spec.md）。用户选定四块全做：kb:auto 智能缓推、LLM 构图感知（可选开关）、多图同屏拼贴、智能 BGM（库内自动 + AI 生成分档）。
> 红线沿用 M53：未触发新键时 legacy args 逐字节不变；strict_delivery 恒不进混剪链；photo-montage 默认零 LLM 零付费（G2/G4b 显式开启才生效并记用量）。

## 1. 能力与目标

| # | 能力 | 触发 | 付费 |
|---|---|---|---|
| G1 | kb:auto 智能缓推：横图（w/h≥1.05）缓推、竖图（h/w≥1.05）缓拉、其余推近；方向锚点可偏置 | `ken_burns: auto` | 零 |
| G2 | LLM 构图感知：image_analyze 反推 composition 文本 → 关键词分类主体左右 → zoompan 锚点偏置 | `analyze_composition: true`（默认关） | 多模态调用 |
| G3 | 多图同屏拼贴：duo 两联 / grid 四宫格 / auto（首尾 hero 单图、中间拼屏），拼屏段整体吃 Ken Burns | `layout: duo\|grid\|auto`（默认 single=现状） | 零 |
| G4a | BGM 库内自动选曲：未手绑 BGM 时从项目音频资产 + 可选 `MONTAGE_BGM_DIR` 曲库按时长就近自动绑定 | `bgm_mode: auto`（模板默认） | 零 |
| G4b | AI 生成 BGM：kit 新增 music 协议族（首供 MiniMax music），产物落 purpose=bgm；端点缺失/超时 → 降级 G4a，绝不断链 | `bgm_mode: music_gen` | 按生成计费 |

## 2. 设计

### 2.1 G1/G2：kb:auto + 锚点（montage.ts / index.ts / segments.ts）
- `KenBurns` 联合扩 `'auto'`；`kbDirectionFor(mode, index, hint?)` 向后兼容扩参：
  - auto：hint 缺失（探测失败宽容）→ 'in'；`ratioW/ratioH` ≥1.05 → 'in'、≤0.953（即竖图）→ 'out'、其余 → 'in'；
  - in/out/alternate/none 行为与返回值逐字节不变（探针锁零 diff）。
- 新增 `kbAnchorFor(hint): { xw: number; yw: number } | null`（纯函数）：产出 zoompan x/y 表达式的锚点权重——
  `x='(iw-iw/zoom)*X'`，X 默认 1（现行居中形态不变）；composition 关键词「主体偏左/left」→ X=0.7（推向左侧）、偏右 → 1.3；vertical 同理 Y。null → 现行公式逐字节。
- `buildNormalizeArgs` opts 扩 `anchor?: { xw: number; yw: number } | null`（仅 kb 分支消费；缺省产出现行表达式）。
- index.ts：kb==='auto' 或 analyze 通道存在时，对图片段逐段探测宽高——`probeImageSize(abs)` 用 ffprobe `-show_entries stream=width,height`（assets.width 对 source 图片不保证填充，ffprobe 为唯一事实源，失败 → null 宽容）；anchor 由 composition 文本分类（`classifyAnchor(text)` 纯函数，左右/中三分）按 `ImageReverseItem.file` 名映射到段。
- 标量桥白名单扩 2 键：`layout`、`bgm_mode`（`analyze_composition` 经步 inputs 映射 `input.analyze_composition` 同样走桥，bool）。

### 2.2 G3：collage 拼贴段（segments.ts / montage.ts；args.ts 不动）
- `Segment` 增可选 `paths?: string[]`（成员本地路径，`path` 恒 = paths[0]；消费点仅 phase-1）。
- 纯函数 `planCollageSegments(segments, layout, durationPerShot)`：
  - single → 原样返回（同引用，零 diff）；
  - duo → 相邻图片段两两合并（奇数末段保持单图）；grid → 四四合并（余数 1 保持单、2/3 降级 duo）；
  - auto → 图片数 <4 全单图；≥4 时首段、末段单图 hero，中间每 3 张一组 grid（不足 3 降级 duo/单）；
  - 视频段原样透传且充当组边界；拼屏段 durSec = durationPerShot、`explicit` false。
- phase-1 collage 分支：N 路 `-i` → 各路 `scale=cellW:cellH:force_original_aspect_ratio=increase,crop=cellW:cellH` → `xstack=inputs=N:layout=0_0|w0_0`（duo）或 `0_0|w0_0|0_h0|w0_h0`（grid）→ 出整屏后接既有 zoompan/定帧 + anullsrc 链（拼屏段可整体缓推）。cell 尺寸：duo 各半宽满高、grid 半宽半高（对 width/height 取偶整除）。
- 溯源 params.montage 增 `layout`、`collage_segments` 计数；`params.images` 计数仍按原始照片数（segKindOrig 口径不变，collage 合并后 image 段变少 → 计数改用 rows 分流原值，探针锁定）。

### 2.3 G4a：库内自动选曲（compose-config.ts / index.ts）
- 合成期决策，不动 phase-2 音频链：`params.bgm_mode === 'auto'` 且 `loadBgmAsset(run.id)` 为 null 时：
  1. 候选 = 项目 `kind='audio'` 未删且未绑其他 run 的资产 ∪ `MONTAGE_BGM_DIR` 目录扫描（mp3/m4a/wav，逐文件 probeMediaDuration，首次使用 registerAsset 复制行入项目 purpose='source' tags=[bgm_library]）；
  2. 纯函数 `pickBgm(candidates, totalSec)`：时长 ≥ 片长优先 → 其中与片差最小 → updated_at desc 稳定序；0 候选 → null + log（不抛错）；
  3. 命中 → 走既有 bgmPath 链（-stream_loop/-amix 零改动），params.bgm 溯源加 `auto_selected: true`。
- 用户已手绑 BGM 永远优先（loadBgmAsset 非 null 直接采用，auto 不覆盖）。

### 2.4 G4b：music_gen（ai-provider-kit + 宿主）
- kit 仓库（跨仓库，Git 标签依赖）：
  - `core/types.ts` service 联合扩 `'music'`；`protocols/music/minimax-music.ts`：POST `/v1/music_generation`（异步 task 查询，鉴权/轮询模式参照 protocols/speech/minimax.ts），产物音频 URL 回传；registry 注册 + index 导出；版本 bump + README + 新 Git 标签。
- 宿主：
  - seed.ts `PROVIDER_SEEDS` 增 `minimax_music`（service_type='music'，vendor=minimax）；service_type 为自由 text 无枚举约束（schema.ts:162 注释仅文档性）→ 零迁移；
  - web AI 配置页 Tab 若为静态清单需补「音乐」类（实施时核实 web 端 serviceType 消费点，一次收口）；
  - ffmpeg-merge 合成期：`bgm_mode==='music_gen'` → `resolveEndpoint('music')` 未配置 → log 降级 G4a；已配置 → kit music 请求（prompt 取 `bgm_prompt` 输入或标题文案兜底「温暖抒情的婚礼背景音乐」），异步轮询超时 240s → 降级 G4a；成功 → 下载落项目音频 + registerAsset(purpose='bgm', runId)（后续重合成经 loadBgmAsset 直接复用，不重复付费）；usage_records 记一次生成（付费可见口径同既有 video 轮询）；
  - `bgm_prompt` 加入桥白名单。
- 零付费防线：探针 live 节 fetch 桩契约测试（断言请求形状 + 降级链），不真调外部付费 API。

## 3. 模板 photo-montage.yaml 输入面（v1 → version 2，步 2 → 3）
- 新输入：`layout`(text default single)、`bgm_mode`(text default auto)、`analyze_composition`(bool default false)、`bgm_prompt`(text optional)。
- 新步 `analyze`：action `image_analyze`，`when: input.analyze_composition == true`，inputs `{ images: input.photos }`；compose 步 `after: [captions, analyze]` + 既有 `after_skipped: continue`（两依赖皆可跳），inputs 增 `composition: steps.analyze.assets`、`bgm_mode/bgm_prompt/layout: input.*`。
- gate/其余保持 M53 形态。

## 4. 零 diff 红线
- legacy 非混剪模板：桥白名单新键仅在 inputs 显式映射时入桥（存量模板不映射）→ params 逐字节不变；
- kb in/out/alternate 的 zoompan 表达式、单图段 phase-1 args、layout=single 的段序列、未设 bgm_mode 的 BGM 路径（loadBgmAsset 语义不变）全部逐字节锁定（probe-m54 args/pure 节 + 既有 probe-m53 复跑）。

## 5. 测试（probe-m54 四节）
- pure：kbDirectionFor auto 三态 + 既有模式零 diff、kbAnchorFor/classifyAnchor、planCollageSegments 五组形态（single 同引用/duo 奇数/grid 余数/auto 首尾 hero/视频段边界）、pickBgm 规则、montageEnabled 对 auto 触发；
- args：buildNormalizeArgs collage duo/grid xstack 形状 + cell 尺寸 + kb 叠加；无 paths 段 = M53 基线逐字节；anchor 偏置表达式形态与缺省居中不变；
- template：version 2 输入面/3 步/when 门控/桥映射；
- live：①4 图 duo + kb:auto 实弹出片（时长/尺寸/拼屏段数溯源）；②bgm_mode=auto：sine 生 2 个 mp3 入项目 → 自动绑定断言 `params.bgm.auto_selected=true` + 音轨非静音；③music_gen fetch 桩：端点缺失降级断言 + 桩成功路径产物落 purpose=bgm（不真付费）；④analyze_composition=false 默认 → analyze 步 skipped 且 compose 不被连带跳过。

## 6. 门禁与文档
- `npx tsc --noEmit` 双端 + validate-templates（19 份步数变化）+ 全量 `run-probes --jobs=1` 零红灯 + web build。
- docs/templates.md photo-montage 行改写（v2）；docs/milestones.md 追加 M54 能力速览（只增不改）；kit README 能力矩阵。
- 提交分枚：引擎(A+B)/BGM(C)/模板(E)/kit+接线(D)/文档，各枚独立可回滚。

## 7. 决策记录
- BGM 不做模板 files 输入：purpose='bgm' run 级绑定是全局机制（compose-config 头注），模板输入桥仅传标量 mode，选曲/生成发生在合成期——避免为单模板开特例。
- music 适配器落 kit 而非宿主：协议实现抽包既定架构（provider.ts 头注），宿主只做 glue。
- collage 走 phase-1 归一化而非 phase-2 滤镜：phase-2 消费点（xfade 计划/时长契约）按「一段一 -i」不变量设计，拼屏在段物化阶段解决可令 args.ts 零改动。
