import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { ActionNotImplemented } from '../types'

/** ai_video：M1 占位注册（spec §5.3），执行即失败并给明确指引 */
export async function aiVideo(_ctx: StepContext): Promise<StepResult> {
  throw new ActionNotImplemented('ai_video')
}