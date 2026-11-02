/**
 * M70 SFC 编译探针（真实产品编译器路径）。
 *
 * 动机：M70 交付时 `vue-tsc --noEmit` 全绿，但浏览器侧 `[plugin:vite:vue] Error parsing JavaScript
 * expression` 仍然炸开——vue-tsc 对模板内联事件表达式容错，@vitejs/plugin-vue 用的
 * `vue/compiler-sfc` 不走那条判定。故本探针直接调用 vite 插件同款编译器编译 M70 全部交付 SFC，
 * 把「只有 dev/build 才暴露」的模板语法缺口前移到离线契约面。
 *
 * 离线：只读源码文件并调用编译器，不起服务、不联网、不写盘、不碰真实配置与数据。
 * 用法：node .superpowers/sdd/M70-计划/safe-run.mjs script ../web/scripts/probe-m70-sfc.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScript, parse } from 'vue/compiler-sfc'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '../src')

/** M70 交付面（任务 11–12 新增/接线的界面）：逐个必须真实编译通过。 */
const M70_SFC_FILES = [
  'components/project/continuity/ContinuityPanel.vue',
  'components/project/continuity/EntryEditor.vue',
  'components/project/continuity/ImpactPanel.vue',
  'components/project/continuity/SourcePicker.vue',
  'components/run/ContinuityPreview.vue',
  'components/run/RunFormModal.vue',
  'components/project/SeriesBoard.vue',
  'components/pipeline-canvas/overview/chain-builder.vue',
  'components/pipeline-canvas/overview/workflows-section.vue',
  'views/easy-create/AgentDecisionCard.vue',
  'views/easy-create/ChainAwaitingCard.vue',
  'views/project-detail/AssetsPanel.vue',
]

let passed = 0
const results: string[] = []

function check(ok: boolean, message: string): void {
  if (ok) {
    passed++
    results.push(`PASS  ${message}`)
    return
  }
  results.push(`FAIL  ${message}`)
  console.error(`  FAIL  ${message}`)
  process.exitCode = 1
}

/** 与 vite 插件同构的编译：parse → compileScript(inlineTemplate) → compileTemplate。 */
function compileErrors(source: string, filename: string): string | null {
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length > 0) return errors[0]!.message
  try {
    compileScript(descriptor, {
      id: 'm70-sfc-probe',
      inlineTemplate: true,
      templateOptions: { compilerOptions: {} },
    })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function main(): void {
  // 0. 自检：守卫不是空跑——同一份 SFC 里两种内联事件写法必须一崩一过。
  const shell = (tpl: string): string =>
    `<script setup lang="ts">
import { ref } from 'vue'
const tab = ref<'a' | 'b'>('a')
const impactId = ref<number | null>(null)
const e = { id: 1 }
function openImpact(x: { id: number }): void {
  void x
}
</script>
<template>${tpl}</template>`

  const twoStatements = compileErrors(
    shell(
      `<button @click="
        impactId = e.id
        tab = 'b'
      ">影响</button>`,
    ),
    'negative-control.vue',
  )
  check(
    twoStatements !== null && twoStatements.includes('Unexpected token'),
    '守卫自检：换行分隔的多语句内联事件确实被真实编译器拒绝（vite 报错复现）',
  )
  const semicolonForm = compileErrors(
    shell(`<button @click="impactId = e.id; tab = 'b'">影响</button>`),
    'semicolon-control.vue',
  )
  check(
    semicolonForm === null,
    '守卫自检：同内容改为分号分隔即编译通过（拒绝项是语法面而非守卫误报）',
  )
  const methodForm = compileErrors(
    shell(`<button @click="openImpact(e)">影响</button>`),
    'method-control.vue',
  )
  check(methodForm === null, '守卫自检：方法调用式内联事件（本次修复采用的形态）通过')

  // 1. 真实交付面：M70 全部 SFC 逐个编译通过且文件在场。
  for (const rel of M70_SFC_FILES) {
    const abs = resolve(srcRoot, rel)
    if (!existsSync(abs)) {
      check(false, `${rel} 在场（M70 交付界面文件缺失）`)
      continue
    }
    const err = compileErrors(readFileSync(abs, 'utf8'), abs)
    const detail = err === null ? '' : `：${err.split('\n')[0]}`
    check(err === null, `${rel} 经 vue/compiler-sfc（vite 同款）编译无错${detail}`)
  }

  console.log(`\n==== M70 SFC 编译探针：${passed} 项全部通过 ====`)
  if (process.exitCode === 1) {
    for (const line of results) if (line.startsWith('FAIL')) console.log('  ' + line)
    process.exit(1)
  }
}

main()
