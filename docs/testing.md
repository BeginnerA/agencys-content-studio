# 全链路回归路径

日常自测的端到端回归清单：UI 手工路径、API 快捷冒烟、data/ 重置。双端启动方式见 [README](../README.md)。

## M3 全链路回归路径

### A. UI 手工路径（推荐，一次约 10–15 分钟）

1. 双端启动：`pnpm dev`，浏览器打开 http://127.0.0.1:5273
2. **建项目**：项目列表「新建项目」（或选已有「萌宝冒烟」跳到 3）；模板可选 `mengbao-episode`（T3 短剧）/ `talking-clip`（T2 口播）/ `note-clip`（T1 图文）
3. **传素材**：项目详情页「上传素材」，用途可选 brief / 设定底稿 / 角色参考图 / 归档；同内容重复上传应去重（同名仅保留一份）
4. **启动流水线**：「启动流水线」→ 填 brief 与集号、勾选开关（`motion` 动效 / `with_storyboard_review` 分镜审阅 / `with_character_refs` 角色定妆照）→ 提交后自动跳运行页
5. **看流式日志**：write_script 步骤日志滚动 → 停在「等待审阅」（gate）；M3 步骤带徽标：记忆「召回 N 条 · top X」/「记忆已写 name」、角色「建档 N 新增 / M 更新」
6. **gate 审阅**：预览剧本 markdown → 可「审阅修改」（以修改版续跑）或直接**批准**；驳回需附意见（回流 LLM 重跑）；分镜闸门挂起时可点「免审直接出图」（skip）
7. **等出片**：批准后自动分镜 →（静态分支）批量出图 /（动效分支）批量视频 → 合成成片；时间线可见并行段与 skipped 灰显（原因 badge）；任务面板逐任务状态与 prompt 溯源
8. **看成片**：完成态 run 的产物资产（final_video）点开即播放（浏览器 Range 拉流）；封面 thumb 与全尺寸图可预览
9. **记忆沉淀巡检**：run 完成后打开 `/memories`：可见该 run 写入的风格样本（类型 / 域 / 溯源）；输入**近义表达**检索应语义命中（非字面匹配）；可编辑 / 删除；模型切换后用「重建索引」补向量
10. **角色库巡检**：打开 `/characters`：查看建档角色（外观锚定 / 别名 / 声线 / 定妆照缩略图，全局与项目域分组）；T3 勾选 `with_character_refs` 再跑一集 → 定妆照生成并入档；镜头出图任务 prompt 含「角色锚定（…）」「必须剔除：…」
11. **模板在线管理**：`/templates` 编辑 YAML（错误内联）→ 保存 → 新 run 用新模板；运行中 run 仍按快照执行
12. **断点续跑**：failed / cancelled run 详情页「从断点续跑」→ 新 run 仅重跑未完成步骤（已成功产物复用）
13. **AI 配置**：`/settings` 四 tab（文本 / 图片 / 视频 / 语音）查看实例，「测试」验证连通；通道未配 / 失败可切换默认实例后重试

### B. API 快捷冒烟

```bash
curl http://127.0.0.1:3001/api/v1/health               # ok/db/ffmpeg/workspace 全绿
curl "http://127.0.0.1:3001/api/v1/runs?project_id=3"  # 项目 3 运行列表（最新在前）
curl http://127.0.0.1:3001/api/v1/runs/26              # completed run 详情（steps 产物链）
curl http://127.0.0.1:3001/api/v1/templates            # 模板列表（含引用体检）
curl http://127.0.0.1:3001/api/v1/assets/166/file      # 成片 mp4（支持 Range: bytes=…）
curl -X POST http://127.0.0.1:3001/api/v1/runs/24/resume   # 断点续跑（failed/cancelled）
curl http://127.0.0.1:3001/api/v1/memories/status          # 记忆基建：模型 / 维度 / 条数 / 待补向量
curl "http://127.0.0.1:3001/api/v1/memories?q=放松"        # 语义检索（近义表达 top1 命中）
curl "http://127.0.0.1:3001/api/v1/characters?project_id=1" # 角色库（含定妆照引用）
```

### C. 清理 data/ 重来

```powershell
# 1) 停掉 pnpm dev（两个终端 Ctrl+C）
# 2) 清库与产物（密钥可保留，不清 secrets.json 则无需重配）
Remove-Item data/studio.db* -ErrorAction SilentlyContinue
Remove-Item workspace/projects/* -Recurse -Force -ErrorAction SilentlyContinue
# 3) 重新 pnpm dev —— 自动 migrate + seed，从空白开始
```

> 模板/提示词经 Web 模板页保存后即时生效；已开始的 run 保持创建时快照语义（M2），续跑不受模板改动影响。

## M4 全链路回归路径

### A. UI 手工路径（M4 增量，约 10 分钟）

1. **配定价**：`/settings` → 底部「用量单价」→ 添加 LLM 行（参数如 `deepseek-chat` / tokens_in / tokens_out）→ 保存
2. **批量运行**：项目页「批量运行」→ 选模板 → 3 行输入（或批量粘贴 JSON）→ 提交 → 自动跳批次页
3. **看批次**：进度与计数随 run 推进（串行时活跃 ≤1）；gate 挂起批次暂停 → 运行页批准 → 回来继续；完成后可「批量导出」
4. **成本核对**：运行页右栏「本 run 成本」（按 kind + 未计价徽标）；`/stats` 概览卡与成本构成核对
5. **导出**：运行页「导出发布包」→ 勾选产物（默认全选）→ 生成 → 下载 zip 解压（manifest.json + 分目录）
6. **发布登记**：运行页「标记发布」（平台/链接/指标）→ 项目页发布记录区块；`/stats` 发布数与播放量同步
7. **复盘**：`/stats` 切 7/30/90 天、项目筛选、成本构成分组切换；项目对比表逆向核对

### B. API 快捷冒烟

```bash
curl http://127.0.0.1:3001/api/v1/stats/overview
curl "http://127.0.0.1:3001/api/v1/stats/usage?group_by=kind"
curl "http://127.0.0.1:3001/api/v1/batches?project_id=1"
curl "http://127.0.0.1:3001/api/v1/publications?project_id=1"
```
