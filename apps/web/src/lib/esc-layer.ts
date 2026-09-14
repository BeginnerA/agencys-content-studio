// ===== Escape 响应层栈 =====
// 多个覆盖层同时打开时（如「启动流水线」弹窗上再开资产预览器），
// 文档级 Esc 监听会互相叠加，一次按键把两层一起关闭。
// 参与本栈的覆盖层在文档级 keydown 中先用 isTop() 仲裁，仅最顶层消费 Esc。

const layers: object[] = []

export interface EscLayer {
  /** 入栈（组件挂载时调用） */
  hold: () => void
  /** 出栈（组件卸载时调用） */
  release: () => void
  /** 是否位于栈顶（仅栈顶层应响应 Escape） */
  isTop: () => boolean
}

/** 注册一个 Esc 响应层（后挂载者位于栈顶） */
export function registerEscLayer(): EscLayer {
  const token: object = {}
  return {
    hold: () => {
      layers.push(token)
    },
    release: () => {
      const i = layers.indexOf(token)
      if (i >= 0) layers.splice(i, 1)
    },
    isTop: () => layers.length > 0 && layers[layers.length - 1] === token,
  }
}
