/**
 * [M50] 剪辑工程格式化器共享渲染上下文：媒体引用命名（relPath → 包内路径）与工程标题。
 * 三格式化器（OTIO / FCPXML / EDL）共用，彼此不互相依赖。
 */
import { basename } from 'node:path'

export interface FormatCtx {
  /** relPath → 包内媒体引用（含 media/ 前缀）；打包侧注入唯一命名映射 */
  nameOf: (relPath: string) => string
  title: string
}

/** 缺省命名：media/<原文件名>（relPath 已带时间戳前缀，基名近似唯一；打包侧会覆盖为强一致映射） */
export function defaultNameOf(relPath: string): string {
  return `media/${basename(relPath)}`
}

/** 由 ctx 派生默认实现（未注入 nameOf 时） */
export function makeCtx(title: string, nameOf?: (relPath: string) => string): FormatCtx {
  return { title, nameOf: nameOf ?? defaultNameOf }
}
