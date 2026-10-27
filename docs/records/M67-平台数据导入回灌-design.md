# M67 平台数据导入回灌（design）

> 状态：✅ 已实施（2026-10-27）。来源：市面专业工具能力差距分析 → 用户确认开发（优先级第 2 项）。
> 关联：M04 打磨分发（publications 表 + 复盘模板）、`publication_ingest` 动作（复盘装配）、M66 发布包（导出侧先例：无状态单端点、纯函数解析器、0 新依赖风格）。

## 一、背景与触发

复盘闭环在 M04 已建成**下半段**：`publications` 表（platform/url/publishedAt/metrics/title/abGroup + runId/assetId 关联）→ `publication_ingest` 动作勾选发布记录装配「平台数据复盘」文档 → review 步骤消费。

**现状缺口（代码级坐实）**：数据进 `publications` 全靠手动——`POST /publications` 逐条敲、`POST /publications/batch` 需手搓 JSON（数组 ≤200 条）。各平台创作者中心（抖音/视频号/小红书/快手/B站）提供**数据导出文件**（多为 .xlsx，部分 CSV），列结构互异且随平台改版漂移——专业工具均支持「拖入导出文件 → 列映射 → 回灌」，本仓缺这半段。

**决策留痕（用户确认，2026-10-27）**：
- 范围 = **通用列映射器**，不做平台预设适配器——上传后用户手选「哪列是标题/URL/播放/点赞…」，映射可存为预设复用（不依赖真实平台样例文件，平台改版由用户调映射解决）。
- 匹配语义 = **自动匹配 + 预览确认**：URL 精确匹配优先，无 URL 时平台+标题全等+发布同日；重复导入同一文件 = 更新而非重复登记（幂等）。
- 解析器 = **0 新依赖手写**（xlsx 本质 zip+XML，用已有 fflate 解包 + 最小读取器；与 M66 纯 Node 手写 PNG/JPEG 同风格），边界场景由预览确认兜底。
- 端点形态 = **方案 C：无状态单端点**（`dry_run` 两阶段，文件传两次；不引入服务端会话暂存）。

## 二、现状（代码级真源）

- **表**：[`db/schema.ts:344`](../../apps/server/src/db/schema.ts) `publications`——platform 枚举 `douyin|wechat_channels|kuaishou|xiaohongshu|bilibili|other`；`metrics` JSON 列注释「仅存不算」。
- **端点**：[`routes/publications.ts`](../../apps/server/src/routes/publications.ts)——POST 登记（L19）、GET 列表+汇总（L52）、PUT 更新含指标回填（L75）、DELETE（L100）、batch 批量导入（L155）、trend 按日聚合（L194）、ab-groups A/B 对比（L227）。**全部零改动，本里程碑纯加法。**
- **复盘消费方**：[`pipeline/actions/publication-ingest.ts`](../../apps/server/src/pipeline/actions/publication-ingest.ts)——读 DB 勾选记录装配复盘文档；导入回灌直接受益，零改动。
- **上传先例**：Hono `c.req.formData()` multipart 已有 4 处（compose BGM/SFX、creation-chat 附件、characters 参考图）。
- **fflate 已在** `apps/server/package.json`（M66 zip 用它）——xlsx 解包零新依赖；Node 内置 ICU 支持 `TextDecoder('gb18030')`——GBK CSV 零新依赖。
- **前端落点**：`apps/web/src/views/stats/PublicationPanel.vue`（数据统计页发布面板）；web 端无 zip/xlsx 库——解析必须放服务端。
- **KV 预设存储**：[`db/schema.ts:203`](../../apps/server/src/db/schema.ts) `settings` 表（key unique + value JSON）——映射预设存此，**0 新表**。

## 三、方案（纯加法）

### 3.1 解析器（纯函数，新文件 `apps/server/src/services/table-parse.ts`）

- 入口 `parseTable(buf: Buffer, ext: 'xlsx' | 'csv' | 'xls'): { header: string[]; rows: string[][]; warnings: string[] }`——二维字符串数组，单元格统一字符串化。`.xls` 先嗅探 `PK` 魔数（不少平台导出实为 xlsx 改名）→ 按 xlsx 走；否则报「旧版二进制 xls 不支持，请另存为 xlsx/csv」。
- **xlsx 路**：fflate `unzipSync` → `xl/sharedStrings.xml`（共享字符串表）+ `xl/worksheets/sheet1.xml`（只读第一张表）+ `xl/styles.xml`；遍历 `<row>/<c>`，支持 `t="s"|"inlineStr"|"str"|"n"|"b"`；**日期判定**走 cell 样式 → numFmtId（内置 14–22）/自定义 formatCode 含 y/m/d/h → Excel 1900 序列号转 ms。富文本 run 拼接 `<t>`；公式单元格读 `<v>` 缓存值。
- **CSV 路**：手写 RFC4180 解析（引号包裹、内嵌逗号/换行、`""` 转义）；编码嗅探 UTF-8 严格解码失败 → `TextDecoder('gb18030')` 兜底（平台 CSV 常见 GBK）。
- 日期双通道：序列号（xlsx）或文本（`2024/5/1 12:30` 等 V8 可解析形态）→ ms；解析失败置空 + warning（预览可见，不阻断）。
- 上限：文件 ≤10MB、行 ≤2000（不含表头），超限抛 `HttpError`。首行即表头，不支持跳行（YAGNI）。

### 3.2 匹配与落库（纯函数）

- 行的平台统一取**导入时用户所选**（不从文件推断；一次导入一个平台的文件）。
- 行 URL 非空（trim 归一）：与现有**同平台**记录 URL 精确相等 → 命中=更新；未命中=新建。
- URL 缺失：平台 + 标题全等 + `publishedAt` 同日 → 更新；否则新建。
- **更新只回填**：`metrics` 逐项非零才覆盖；`url/publishedAt/title` 仅原值为空时补齐；`runId/assetId/abGroup/note` 永不动。
- 新建行：`runId/assetId/abGroup/note` 留空，`publishedAt/metrics/title/url` 按映射装配（缺列 → 指标置 0 + warning）。
- 同文件内重复行（同匹配键）：取最后一条为准，预览标注重复数。

### 3.3 API 契约（`routes/publications.ts` 追加）

- `POST /publications/import?project_id=&dry_run=0|1`（multipart）：`file` + `platform`（枚举校验）+ `mapping` JSON（`{title?,url?,publishedAt?,views?,likes?,comments?,favorites?,shares?,abGroup?}` → 0 基列索引）+ 可选 `preset`（保存本次映射为具名预设）。
  - `dry_run=1` → `{ columns: [{index,name,sample[3]}], preview: { updateCount, newCount, duplicates }, sampleRows, warnings }`（mapping 可省——省略时退化为仅解析预览，无 preview 块，供前端列映射 UI 取列清单）；两种形态**均零写库**；**零写库**。
  - `dry_run=0` → `{ created, updated, warnings }`；服务端逐块写库（不受 batch 200 上限约束，行上限 2000 独立生效）。
- `GET/PUT /publications/import/presets`：预设存 `settings` KV（key `publication_import_presets`，value 为 `名称 → {platform, mapping}` JSON）；PUT 校验 mapping 形状。

### 3.4 前端（`PublicationPanel.vue` 纯加法）

「导入平台数据」按钮 → 弹层三步：**① 文件+平台** → **② 列映射**（列名下拉选择，预设一键套用/另存）→ **③ 预览确认**（更新 N / 新建 M / 重复 / 警告 + 示例行）→ 确认提交（同一文件对象重传）。复用既有 multipart 上传模式。

### 3.5 红线

- **0 新表 0 新列 0 新依赖 0 新付费面**（fflate 已有 + Node 内置 ICU/TextDecoder）；现有 `/publications*` 端点与 `publication_ingest` 行为零变更。
- 解析与匹配全纯函数（可独立探测）；`dry_run=1` 零写库（探针断言）。
- 模板 YAML 零改动；不进 DAG（面板能力，非流水线步骤）。

### 3.6 北极星三问

服务创作闭环？**是**——回灌补全「发布 → 平台数据 → 复盘」闭环唯一缺失的数据入口。可模板化？导入为面板横切能力，模板零感知。通用资产能承载？数据落 `publications` 既有表，不造新载体。

## 四、验证（probe-m67，isolatedEnv，零付费面）

1. xlsx 解析：探针内用 fflate **现场打包** fixture（sharedStrings/sheet/styles 日期格式）→ 表头与单元格逐项读回断言（共享字符串/内联字符串/数字/日期序列号）；
2. CSV：RFC4180 引号/逗号/换行/双引号转义；**GBK 字节字面量 fixture** → gb18030 兜底解码断言；
3. 日期双通道：序列号与文本各一例，异常格式置空 + warning；
4. 匹配幂等：同一文件 `dry_run=0` 两次 → 第二次 `created=0` 且总数不变；
5. 更新保护：已有 `runId/assetId/abGroup/note` 不被清空；空缺 url/publishedAt 补齐；metrics 非零覆盖；
6. 同文件重复行取最后 + 预览标注；
7. 映射缺列/列索引越界 → 指标置 0 + warning，不抛；
8. `dry_run=1` 零副作用（导入前后库内计数不变）；
9. 上限拒绝（>2000 行 / >10MB）、platform 枚举拒绝；
10. 预设 GET/PUT 往返 + 形状校验；
11. 端到端闭环：导入 → `publication_ingest` 复盘文档含导入行（回灌最终受益证据）。

全仓 `pnpm ci:check` 端到端无回归。

## 五、遗留与边界（诚实标注）

- 合并单元格不展开（仅首格有值）；多 sheet 只读第一张；加密工作簿与旧版二进制 xls（BIFF）不支持（明确报错，提示另存为 xlsx/csv）。
- xlsx 为**最小读取器**：日期判定覆盖 numFmt 内置 14–22 与含 y/m/d/h 的自定义格式；异常格式置空走预览兜底，不追求全覆盖。
- 不做列自动推断/智能识别（通用映射器哲学：用户手选 + 预设复用；平台改版由用户调映射解决）。
- URL 匹配仅精确相等（不做 slug/短链归一）。
- matchRows claimed 兜底：文件内两行以**不同去重键**命中同一既有记录（同一发布既被 URL 行命中、又被标题+同日行命中）时，仅首个命中行更新、后者转新建，可能对同一发布重复登记——预览 `newCount` 可见该行为（probe-m67 route 节已记录现行为）；属罕见构造路径，同文件同键重复行取最后一条的语义不受影响。
- 方案 C 固有：预览与确认各传一次文件（本地回环零成本）。
- 表头行固定首行：个别平台导出含推广语首行的场景不支持，用户需先手工删行（记录在 UI 提示）。
