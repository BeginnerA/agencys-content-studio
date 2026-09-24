/**
 * 创作画布执行通道（不复用 pipeline actions——其全为批处理/分镜驱动）：
 * - startCanvasNodeRun：readiness 预检 → 建 gen_tasks 行（runId/stepId 恒 null，canvasNodeId 归属）→ 入队异步执行；
 * variants（1-4）：一次循环建 N 条任务，随信号量排队；响应 { taskId, taskIds }（taskId = 首条，兼容）；
 * - 执行镜像 ai_image / ai_video 的 runOneTask 生命周期：attempts 递增、processing→succeeded/failed、
 *   落盘 saveGeneratedMedia + scheduleImageCheck + recordUsage、失败自动重试 1 次（1.5s 间隔）；
 * - 五执行径：编辑/图片/视频（既有）+ audio（services/tts 声线四级链 + synthSpeech → purpose=creation_audio
 *   + recordUsage(tts/char)）+ compose（buildComposeArgs 纯函数 + resolveFfmpeg spawn → purpose=creation_compose）
 *   + llm（ 指令 + 文本素材 + 参考图多模态 → chatCompleteDetailed → writeTextAsset(purpose=creation_llm) + recordLlmUsage）；
 * - prompt 端口语义：执行 prompt = plan.promptText（text 节点内容）> spec.prompt 兜底；
 * - 取消：复用 POST /tasks/:id/cancel（改 status=cancelled）；执行器各检查点弃存（视频轮询每轮检查；
 *   图片/音频生成不可中断、合成本地进程不可中断——完成后若已取消则弃存）；
 * - 并发：进程内信号量 ≤CANVAS_MAX_CONCURRENCY；崩溃恢复 recoverCanvasTasks（启动时调用）。
 */

export { appendStyleSnippet, buildEditParams, buildNodeTaskParams, extendTaskParams, parseResolution } from './params'
export type { ComposeSize } from './params'
export { buildComposeArgs } from './compose-args'
export { FRAME_SEEK_BACKOFFS, buildFrameExtractArgs, extractNodeFrame, extractVideoFrame, frameTimeOf } from './frame'
export type { FrameMode } from './frame'
export { preflightNode, previewCanvasRun } from './preflight'
export type { NodePreflight, PreviewCanvasResult, PreviewNodeItem, PreviewUnitLine } from './preflight'
export { CANVAS_MAX_CONCURRENCY, cancelCanvasTasks, recoverCanvasTasks, startCanvasNodeRun } from './queue'
