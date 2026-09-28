// ffmpeg_merge 执行辅助：从 index.ts 纯搬迁（行为保真拆分，不改编排/滤镜图/时长/字幕语义）。
// 职责：spawn ffmpeg 子进程，stderr 逐行转发为 step.log 事件，非零退出抛错（含尾部输出）。
import { spawn } from 'node:child_process'
import { emitStudioEvent } from '../../../services/events'
import type { StepContext } from '../../context'

/** ffmpeg 执行：stderr 逐行 → step.log 事件；非零退出抛错（含尾部输出） */
export function runFfmpeg(ctx: StepContext, ffmpeg: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, cwd })
    let tail = ''
    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8')
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        tail = trimmed.length > 300 ? trimmed.slice(-300) : trimmed
        emitStudioEvent({ type: 'step.log', runId: ctx.run.id, stepId: ctx.step.id, seq: Date.now(), chunk: trimmed })
      }
    })
    child.on('error', (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}：${tail}`))
    })
  })
}
