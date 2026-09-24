/**
 * [M10·拆分] probe-m10 拆分后的共享上下文契约（≤800 行红线拆分，行为零变更：
 * section 模块只接收 ctx 注入 + 自行动态 import 运行期服务，断言文案逐字保留自原单文件）。
 * 隔离环境（临时库 + workspace）由入口 probe-m10.ts 在任何 src 加载前建立；
 * 本目录模块只被入口在 setup 后动态 import，src 动态 import 顺序与拆分前等价。
 */
export interface M10Ctx {
  check: (cond: boolean, msg: string) => void
  errOf: (fn: () => Promise<unknown>) => Promise<unknown>
  /** 种子 run（completed），字段语义见入口注释 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seedRun: () => Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStep: (id: number) => Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAsset: (id: number) => Promise<any>
  /** 上传用字节（kind 由扩展名判定） */
  PNG_A: Uint8Array
}
