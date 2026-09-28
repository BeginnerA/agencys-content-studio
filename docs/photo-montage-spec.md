# M53 photo-montage 素材混剪成片 · 设计 spec

> 状态：设计定稿 · 编号 M53（M52 全局素材池在途，编号避让）
> 痛点：用户手上有现成的多张照片 / 多段视频（典型：婚宴大屏片、年会回顾、纪念相册片），只想"拼成一支成片 + 背景音乐 + 标题字幕"，但现状所有含合成步的模板都强制先走 LLM 写脚本/出图链路；`ffmpeg_merge` 虽有图片轮播与视频拼接两态，但**两态互斥**（照片+视频不能混排）、**视频原声默认丢弃**（誓言/欢呼声进不了成片）、**照片无 Ken Burns**（大盘略显呆板）、**无免 LLM 的成片入口模板**。

## 1. 目标与非目标

**目标**
1. 新增内置模板 `photo-montage`（素材混剪成片）：现成照片/视频 → 一支完整成片，**可全程零 LLM、零付费**。
2. 引擎增强（`ffmpeg_merge`）：
   - **G1 混排**：图片段 + 视频段同一镜头序列交替拼接；
   - **G2 原声保留**：视频段内嵌音轨进成片，并与 BGM/配音自动混音（`keep_clip_audio`）；
   - **G3 Ken Burns**：照片段缓推慢移动效（`ken_burns: in|out|alternate`）；
   - **G4 标题字幕**：`subtitle` 动作新增 `mode: fixed`（文本行 → 定长计时 SRT，零 LLM），供开场标题/祝福语烧录。
3. `probe-m53` 探针（纯函数断言 + 实弹 ffmpeg 合成零计费）+ `docs/templates.md` 活文档同步（18→19）。

**非目标（登记不混入）**
- 模板级 AI 祝福语生成（`ai_text`+gate 派生自定义模板即可，出厂保持零 LLM 默认）；
- 音频交叉淡化（原声轨间仅视频 xfade 淡化，音频硬接，婚宴场景以 BGM 为主可接受）；
- 旋转/翻转等编辑类转场（延续 xfade 枚举子集）；
- 人脸排序、EXIF 拍摄时间自动排序等相册管理功能（用户在素材选择框里自选顺序）；
- `manual_ingest` 之外的新上传通道（复用现有资产上传 → files 输入选资产链路）。

## 2. 设计总览

### 2.1 两段式合成（仅混剪态启用）

**触发条件**（`montageEnabled(params, hasVideoSeg, hasMixed)`，纯函数）：
`params.montage === true` 或（images 与 motion_clips 双输入并存 = 混排）或 `keep_clip_audio === true` 或 `ken_burns` 非 `none`。
**任一条件不满足 → 单段 legacy 链逐字节不变**（零 diff 红线，全部存量模板/探针/基线不受影响；纯照片轮播不带增强时仍走 legacy）。

混剪态执行流：

```
phase-1（逐段归一化，串行，临时 mp4 落 workspace tmp）
  图片段: -loop 1 -t d -i img → [kb=zoompan 缩放平移 | 直接] scale=W:H:force_original_aspect_ratio=increase,crop,setsar=1,fps,format=yuv420p
          + anullsrc 静音轨（保证每段都有 a 流）→ -t d 精确截长 → tmp_i.mp4（crf 18，一次代数损失）
  视频段: -i clip → trim/setpts 到 d（不足 → tpad clone 补帧 + apad 补静音）→ 同几何链
          + [原声 aresample=44100,stereo,atrim 到 d | 无 a 流 → anullsrc] → tmp_i.mp4
  （缺音频流的视频段用 ffprobe 探测 {#i:a} streams=audio 判定 —— probeHasAudioStream，注入点可 mock）

phase-2（最终合成，复用 buildComposeArgs 主体）
  segments 全部视为 kind='image'（定长、有 a 流、尺寸/fps 已定）→ montage=true 时：
  - 输入用 `-i path`（不再 -loop/-t）；per-seg 视频链跳过 scale/fps 重滤镜（已归一）
  - 新增音频通路：per-seg [i:a] → 与视频 xfade 同轴拼接 [clipa]（xfade 启用时各段 atrim=videoLens 精确等长，天然对齐）
  - keep_clip_audio 时 [clipa] 作为「连续现场轨」参与既有混音收口：
      有 voices → [clipa] 与配音 concat 轨 amix(normalize=0,duration=longest)+atrim=totalAll → 喂既有 [outa] 槽位
      无 voices → [clipa] 直接占 [outa]（BGM 存在则既有 amix duration=first 由 BGM 音量主导；配音仍在则 BGM 用既有 volume 先压低）
  - 字幕烧录/水印/片头尾/SFX/多画幅：**不改**，phase-2 沿用既有链（片头尾在 phase-2 拼接，不参与 phase-1）
```

Ken Burns 数学（phase-1 图片段，zoompan 单帧产出 + `-t` 撑长，规避 d= 复制帧时长膨胀陷阱）：
- `scale=w*iw:-2`（放大底图至输出宽 ×2 冗余，抑制亚像素抖动）→ `zoompan=z='min(1+0.00045*on,1.3)'|'max(1.3-0.00045*on,1)'`:x/y 向中心收拢 → `scale=W:H,crop,setsar=1,fps`；
- `alternate`：偶数镜 in、奇数镜 out；`in|out`：统一方向；速度增量按 6s/镜 ≈ 1→1.27 观感校准，探针只做参数形状断言，实弹看产物。

### 2.2 输入与顺序契约

- 模板 inputs：`photos`（files, accept 图片）、`clips`（files, accept 视频），**至少其一**（引擎校验，loader 无 cross-input required 表达）；
- 混排顺序 = `[...photoIds, ...clipIds]` 资产 id 拼接序（用户在选择框里的勾选顺序即时间轴顺序；照片后追加视频=片尾花絮，前置=开场花絮，语义清晰无需新输入类型）；
- 镜头资产 kind 由既有 `computeShotSegments` 分型：mode='mixed' 下 image 行→图片段、video 行→视频段、其余 skip+warn（存量 skip 语义不变）。

### 2.3 subtitle mode:fixed

`params.mode === 'fixed'`：跳过 LLM，输入台词逐行（`collectSource` 现状复用）→ `planFixedSrt(lines, {ms_per_line, lead_in_ms})`（导出纯函数，末行随总长收敛）→ 产物 params.mode='fixed'。供标题/祝福语零 LLM 定时；measured/estimated 分支零改动。

## 3. 模板 photo-montage.yaml（内置）

| 输入 | kind | 说明 |
|---|---|---|
| `photos` / `clips` | files | 照片（jpg/png/webp…）/ 视频（mp4/mov…），至少其一 |
| `title` | text | 选填；开场标题（如新人姓名+日期），定长烧录 |
| `lines_text` | files(.srt/.txt) | 选填；多行字幕文本，与 title 合并定时 |
| `duration_per_shot` | int 默认 4 | 每张停留秒 |
| `fps` | int 默认 30 | 大屏流畅度 |
| `resolution` | text 默认 `1920x1080` | 大屏 16:9；竖屏宴传 `1080x1920` |
| `transition` | text 默认 `fade` / `transition_duration` int 默认 0.7 | xfade |
| `ken_burns` | text 默认 `alternate` | none/in/out/alternate |
| `keep_clip_audio` | bool 默认 true | 视频原声保留（照片段静音自动补） |
| `bgm_volume` 0.35 / `bgm_fade` 2 | num | BGM run 级上传绑定（既有能力） |
| `confirm` | bool 默认 true | 成片人工审阅闸（驳回可附意见局部返修重合成） |

单步 `compose`（ffmpeg_merge, cover: true）+ 可选 `captions`（subtitle fixed, when title/lines_text 存在）；`scene: produce`，`genre: other`。BGM 不在模板步——沿用 run 级「合成设置-BGM 上传」既有通道（任意模板可用，零接线）。

## 4. 零 diff 红线与存量兼容

- 存量 18 模板无 `montage/keep_clip_audio/ken_burns` 键、无双输入 → `montageEnabled=false` → args/cwd 与今日逐字节一致；
- `buildComposeArgs` 新增字段全部可选，`images/motion_clips` 互斥抛错**仅当混剪未启用时保留**（防止存量模板 when 写错静默混排——报错文案更新提示 montage 开关）；
- strict/recipe/对白原生声链不受触发（混剪态与 strict 互斥：`strict_delivery=true` 时忽略 montage 输入 + warn 日志，保持批准链逐字节语义）；
- `timeline` 快照 / provenance / fit_voice / 音字对齐：混剪态下 voices 对齐按现状 best-effort（无 shots 输入 → 自然回退均分，日志同源）。

## 5. 验证（probe-m53）

1. **纯函数**：`montageEnabled` 真值表；`planFixedSrt` 定时/收敛；`buildNormalizeArgs` 图/视/KB in-out-alternate/缺音频分支形状；`buildComposeArgs(montage)` 与 legacy 同输入 diff 仅 montage 相关段；**legacy 零 diff**（无新键输入 args 逐字节比对既有用例）。
2. **实弹（零计费）**：tsx 生成 2 张测试图（color+drawtext）+ 1 段带原声测试视频（sine+testsrc）→ 直调引擎跑 photo-montage 全链（title 字幕 + BGM 用生成的 sine m4a）→ ffprobe 断言：输出时长 ≈ Σd、1920x1080@30、含 aac 音轨、混排段数正确；`transition=none` 与 `fade` 两态。
3. **模板静态**：`loadTemplate('photo-montage')` 合法 + action ∈ KNOWN_ACTIONS + `builtin: true` 标记读取。
4. **门禁**：双端 typecheck → `probe-m53` 全绿 → 全量 `run-probes --jobs=1` 串行零红灯（权威口径）。

## 6. 文档同步

- `docs/templates.md`：18→19 + `photo-montage` 行 + 工作流链「现成素材混剪」行；
- `docs/milestones.md`：M53 能力速览（新条目，不改历史快照）；
- 内置真源说明不变（模板 builtin 标记在 YAML 自身，无需改 `builtin-assets.ts`）。
