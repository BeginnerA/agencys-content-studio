# 正版曲库入库标签规范（BGM Library Spec）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

> 适用范围：`MONTAGE_BGM_DIR` 曲库目录与项目内音频资产的 BGM 入库标注。真源实现：`apps/server/src/services/bgm-library.ts`（纯函数）。
> 目的：把「正版曲库为主 + AI 生成为补充」的 BGM 策略落到可执行的入库/选曲规范——正版曲（曲多多等）人工下载后按本规范标注入库，`bgm_mode=auto` 通道即可情绪驱动选曲。

## 1. 词表（单一真源，与 `bgm-library.ts` 常量同源）

| 维度 | 字段 | 取值 | 说明 |
| --- | --- | --- | --- |
| 情绪 | `mood` | 紧张 / 温情 / 反转 / 欢快 / 悲伤 / 悬疑 / 燃 / 治愈 / 庄严 / 日常 | 可多值；支持同义词自动归一（如「热血→燃」「急迫→紧张」），未命中枚举的词原样保留进 embedding 文本 |
| 风格 | `style` | 国风 / 钢琴 / 管弦 / 电子 / Lo-fi / 民谣 / 嘻哈 / 摇滚 / 氛围 | 可多值，可扩展 |
| 分轨 | `stems` | `full` / `instrumental` / `vocal` | BGM 首选 `instrumental`（无人声，混音不抢台词） |
| 节拍 | `bpm` | 正数 | 可选 |
| 描述 | `desc` | 文本 | 可选，参与情绪向量文本 |
| 授权 | `license` | `{source, order_id, scope, expires}` | 合规溯源，缺失仅告警不阻断 |

## 2. 载体：同名侧车 `*.bgm.json`

每支音频在同目录放同名侧车（就近可维护，不引新表）：

```
MONTAGE_BGM_DIR/
├── chase-tension.mp3
├── chase-tension.bgm.json
├── warm-family-piano.mp3
└── warm-family-piano.bgm.json
```

`chase-tension.bgm.json` 示例：

```json
{
  "mood": ["紧张", "反转"],
  "style": ["管弦", "电子"],
  "stems": "instrumental",
  "bpm": 128,
  "desc": "急促弦乐追逐戏",
  "license": { "source": "曲多多", "order_id": "AGM-2026-0001", "scope": "commercial", "expires": "2027-12-31" }
}
```

### 兜底与兼容
- **文件名内联提示**（侧车缺失时）：`chase[mood=紧张,反转|style=电子].mp3` —— `metaFromFilename` 正则解析。
- **完全无标注**：`mood/style = null`，该曲仍入库，退化为纯时长候选（逐字节 = 旧 `bgm_mode=auto` 行为，零回归）。
- **空壳侧车**（无任何信号字段）：视作无侧车。

## 3. 入库落位（`smart-bgm.ts:importLibraryTrack`）

复制入项目为 `purpose='source'` 音频行时：
- `tags` = `['bgm_library', ...mood, ...style]`（去重）。
- `params` = `{ source_file, bgm_sidecar_hash, mood, raw_moods, style, stems, bpm, desc, license, has_license, moodEmbedding?, moodEmbeddingModel? }`。
- **情绪向量落 `params.moodEmbedding`（JSON number[]），模型标识 `params.moodEmbeddingModel = {model}@{dims}`**——
  不复用 `assets.embedding` 列（该列语义约定 `kind='text'` 且被 `search.ts` 文本召回消费，塞音频向量有污染风险）。
- **幂等刷新**：侧车内容变化（`bgm_sidecar_hash` 不同）→ 重算情绪向量并回写 `tags/params`；无变化原样复用不重复付费/计算。
- embedding 不可用（本地模型缺失）→ `moodEmbedding=null`，选曲退化纯时长，绝不断链。

## 4. 消费（阶段二 `pickBgm` 情绪层）
- 合成期 `bgm_mode=auto`（或 music_gen 降级）时：`aggregateRunMood` 聚合本 run 台词/分镜情绪 → 情绪文本 → `embed` → `moodVec`。
- `pickBgm(cands, totalSec, { moodVec })`：时长可行性硬约束分档内，按 `cosine(moodVec, cand.moodEmbedding)` 降序；平票回落时长差 → `updated_at desc`。
- **零 diff 红线**：`moodVec` 为空或全体候选无 `moodEmbedding` → 排序逐字节 = 旧 `pickBgm`。

## 5. 运营流程（人在环）
1. 曲多多（无公开拉曲 REST）人工/AI 搜曲 → 下载分轨 → 放入 `MONTAGE_BGM_DIR` 并按本规范写侧车（`instrumental` 优先）。
2. 短剧链 `mengbao-episode` / 混剪链 `photo-montage` 设 `bgm_mode=auto` → 自动情绪选曲。
3. 少数特殊场景无合适素材 → `bgm_mode=music_gen`（Mureka/音潮，见 `docs/ai-config.md`），失败自动降级 auto。

## 6. 探针
- `probe-bgm-library.ts`：侧车解析（pure）+ 临时目录入库落位（live）；断言 moodEmbedding 落 `params` 且 `assets.embedding` 仍为 null（防污染文本搜索）。
- `probe-bgm-mood.ts`：`pickBgm` 情绪层排序与零 diff；`aggregateRunMood` 频率聚合。
