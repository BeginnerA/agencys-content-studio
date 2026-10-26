/**
 * Node 侧字节体类型别名（探针/夹具专用）。
 *
 * `Response` / `Blob` 由 @types/node 的 undici 声明提供，但 DOM 的 `BodyInit` / `BlobPart`
 * 名字并不在 Node 全局里（服务端 tsconfig 也没有引入 DOM lib）。桩响应与上传夹具需要把
 * Buffer/Uint8Array 塞进这两个构造函数时，用此处从构造函数签名推导出的别名，避免各脚本
 * 各自写 `any` 或依赖并不存在的全局类型。
 */
export type ResponseBody = NonNullable<ConstructorParameters<typeof Response>[0]>

export type BlobBytes = ConstructorParameters<typeof Blob>[0] extends ReadonlyArray<infer P> ? P : never
