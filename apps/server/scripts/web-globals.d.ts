/**
 * 客户端探针（probe-m41 的 first-input-client 等）在服务端 tsconfig 下编译，会经 composable
 * 间接引入 `web/src/lib/api/assets.ts` 的上传实现（XMLHttpRequest 为 DOM 全局）。
 *
 * 服务端 tsconfig 不能整体引入 DOM lib —— 那样会与 node:stream/web 的 ReadableStream 定义冲突
 * （src/routes/assets.ts 等处的流式响应会报不兼容）。因此这里只补一份「仅编译期」的最小声明；
 * 客户端代码本身仍由 web 的 vue-tsc + DOM lib 正常检查。Node 运行期没有 XMLHttpRequest，
 * 服务端若真引用它，会在运行期立即暴露而不是被类型系统掩盖。
 */
declare class XMLHttpRequest {
  open(method: string, url: string): void
  send(body?: unknown): void
  readonly upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null
  }
  onload: (() => void) | null
  onerror: (() => void) | null
  readonly status: number
  readonly responseText: string
}
