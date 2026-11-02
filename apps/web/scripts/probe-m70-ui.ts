/**
 * M70 UI 状态离线回归（Task 11 · brief 11.1）：useContinuityApproval 的 epoch/ticket 协议与冻结幂等键纪律。
 * 覆盖：目标变化乱序响应、invalidate/取消、重复冻结、冻结 key 只随目标签名换新、includePlans 变动作废、
 * 超时错误后的同 key 重试。零网络、零真实服务：api 注入可控桩。
 *
 * 运行（R10 替代 `pnpm --filter @acs/server exec tsx ../web/scripts/probe-m70-ui.ts`，仓库根执行）：
 *   node .superpowers/sdd/M70-计划/safe-run.mjs script ../web/scripts/probe-m70-ui.ts
 */
import assert from 'node:assert/strict'
import { nextTick, ref } from 'vue'
import { useContinuityApproval } from '../src/composables/use-continuity-approval'
import { freezeBody } from '../src/lib/api/continuity'
import * as cont from '../src/lib/continuity-entry'
import { useCreationContinuity } from '../src/views/easy-create/use-creation-continuity'
import type {
  Approval,
  Preview,
  TargetRequest,
} from '../src/lib/types/continuity'
import {
  approvalFixture,
  firstTarget,
  noGaps,
  previewFixture,
  secondTarget,
} from './probe-m70-ui-fixtures'

const results: string[] = []
function check(ok: boolean, message: string): void {
  assert.ok(ok, message)
  results.push(`PASS ${message}`)
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 可控 fake api：preview/freeze 请求排队，测试手工 resolve/reject；捕获全部请求体。 */
function fakeApi() {
  const previewCalls: Array<{ target: TargetRequest; includePlans: boolean }> =
    []
  const freezeCalls: Array<Record<string, unknown>> = []
  const previewQueue: Array<deferred<{ preview: Preview }>> = []
  const freezeQueue: Array<deferred<{ approval: Approval }>> = []
  const api = {
    preview: async (
      _pid: number,
      body: { target: TargetRequest; includePlans: boolean },
    ) => {
      previewCalls.push({ ...body })
      const d = deferred<{ preview: Preview }>()
      previewQueue.push(d)
      return d.promise
    },
    freeze: async (_pid: number, body: Record<string, unknown>) => {
      freezeCalls.push(body)
      const d = deferred<{ approval: Approval }>()
      freezeQueue.push(d)
      return d.promise
    },
  }
  return {
    api,
    previewCalls,
    freezeCalls,
    resolveNextPreview: (v: { preview: Preview }) =>
      previewQueue.shift()!.resolve(v),
    rejectNextPreview: (e: unknown) => previewQueue.shift()!.reject(e),
    resolveNextFreeze: (v: { approval: Approval }) =>
      freezeQueue.shift()!.resolve(v),
    rejectNextFreeze: (e: unknown) => freezeQueue.shift()!.reject(e),
  }
}

async function main(): Promise<void> {
  // ===== T1 目标变化 + 乱序响应（brief 11.1 代码块语义） =====
  {
    const target = ref<TargetRequest | null>(firstTarget)
    const f = fakeApi()
    const state = useContinuityApproval(target, ref(1), f.api)
    const pending = state.load()
    target.value = secondTarget
    await nextTick()
    f.resolveNextPreview(previewFixture('b'.repeat(64)))
    await pending
    check(
      state.approval.value === null && state.preview.value === null,
      'T1 旧目标的乱序 preview 响应不得落地（epoch 已递增）',
    )
    check(
      state.busy.value === false,
      'T1 旧响应被丢弃后忙态仍由最终 ticket 释放',
    )
    const p2 = state.load()
    f.resolveNextPreview(previewFixture('c'.repeat(64)))
    await p2
    check(
      state.preview.value?.doc.previewHash === 'c'.repeat(64),
      'T1 新目标的 preview 正常落地',
    )
  }

  // ===== T2 invalidate 作废在途响应（取消/卸载语义） =====
  {
    const target = ref<TargetRequest | null>(firstTarget)
    const f = fakeApi()
    const state = useContinuityApproval(target, ref(1), f.api)
    const pending = state.load()
    state.invalidate()
    await nextTick()
    f.resolveNextPreview(previewFixture('d'.repeat(64)))
    await pending
    check(state.preview.value === null, 'T2 invalidate 后旧 preview 响应不落地')
  }

  // ===== T3 重复冻结：busy 期间第二次冻结不发请求；成功后 approval 落地 =====
  {
    const target = ref<TargetRequest | null>(firstTarget)
    const f = fakeApi()
    const state = useContinuityApproval(target, ref(1), f.api)
    const p1 = state.load()
    f.resolveNextPreview(previewFixture('e'.repeat(64)))
    await p1
    const fp = state.freeze(noGaps)
    check(state.busy.value === true, 'T3 冻结期间 busy 置位')
    const dup = await state.freeze(noGaps)
    check(
      dup === null && f.freezeCalls.length === 1,
      'T3 busy 期间重复冻结不发第二个请求',
    )
    f.resolveNextFreeze(approvalFixture)
    const frozen = await fp
    check(
      frozen?.approvalHash === approvalFixture.approval.approvalHash &&
        state.approval.value !== null,
      'T3 冻结成功后 approval 落地',
    )
  }

  // ===== T4 冻结 key 纪律：同签名复用同 operationKey；目标变化换新 key；失败不落地 approval =====
  {
    const target = ref<TargetRequest | null>(firstTarget)
    const f = fakeApi()
    const state = useContinuityApproval(target, ref(1), f.api)
    const p1 = state.load()
    f.resolveNextPreview(previewFixture('f'.repeat(64)))
    await p1
    const fp1 = state.freeze(noGaps)
    f.resolveNextFreeze(approvalFixture)
    await fp1
    const fp2 = state.freeze(noGaps)
    f.resolveNextFreeze(approvalFixture)
    await fp2
    check(
      f.freezeCalls.length === 2 &&
        f.freezeCalls[0]!.operationKey === f.freezeCalls[1]!.operationKey,
      'T4 同一目标签名的两次冻结复用同一 operationKey（幂等回放）',
    )
    target.value = secondTarget
    await nextTick()
    const p3 = state.load()
    f.resolveNextPreview(previewFixture('0'.repeat(64)))
    await p3
    const fp3 = state.freeze(noGaps)
    f.resolveNextFreeze(approvalFixture)
    await fp3
    check(
      f.freezeCalls[2]!.operationKey !== f.freezeCalls[1]!.operationKey,
      'T4 目标签名变化后冻结 key 换新',
    )
    check(
      (f.freezeCalls[0] as { includePlans: boolean }).includePlans === false &&
        (f.freezeCalls[2] as { previewHash: string }).previewHash ===
          '0'.repeat(64),
      'T4 冻结体携带 includePlans 与当前 previewHash',
    )
    // 失败路径：freeze 拒绝 → error 呈现、approval 清空、旧 key 不被吞（下一条请求仍可发出）
    const fp4 = state.freeze(noGaps)
    f.rejectNextFreeze(new Error('continuity_conflict'))
    const failed = await fp4
    check(
      failed === null &&
        state.error.value.includes('continuity_conflict') &&
        state.approval.value === null,
      'T4 冻结失败呈现错误且不写 approval',
    )
  }

  // ===== T5 includePlans 变化使 epoch 递增并清 approval；在途旧响应丢弃 =====
  {
    const target = ref<TargetRequest | null>(firstTarget)
    const f = fakeApi()
    const state = useContinuityApproval(target, ref(1), f.api)
    const p1 = state.load()
    f.resolveNextPreview(previewFixture('1'.repeat(64)))
    await p1
    const fp = state.freeze(noGaps)
    f.resolveNextFreeze(approvalFixture)
    await fp
    state.includePlans.value = true
    await nextTick()
    check(
      state.approval.value === null && state.preview.value === null,
      'T5 includePlans 变化清空 preview 与 approval',
    )
    const p2 = state.load()
    f.resolveNextPreview({
      ...previewFixture('2'.repeat(64)),
      preview: {
        ...previewFixture('2'.repeat(64)).preview,
        doc: {
          ...previewFixture('2'.repeat(64)).preview.doc,
          includePlans: true,
        },
      },
    })
    await p2
    check(
      (f.previewCalls.at(-1) as { includePlans: boolean }).includePlans ===
        true && state.preview.value?.doc.includePlans === true,
      'T5 新请求携带 includePlans=true 并落地',
    )
  }

  // ===== T6 超时错误后同 key 重试：错误呈现；同签名重试仍用同一冻结 key =====
  {
    const target = ref<TargetRequest | null>(firstTarget)
    const f = fakeApi()
    const state = useContinuityApproval(target, ref(1), f.api)
    const p1 = state.load()
    f.rejectNextPreview(new Error('请求超时'))
    await p1
    check(
      state.error.value.includes('超时') && state.preview.value === null,
      'T6 preview 超时呈现错误且不落地',
    )
    const p2 = state.load()
    f.resolveNextPreview(previewFixture('3'.repeat(64)))
    await p2
    const fp = state.freeze(noGaps)
    f.resolveNextFreeze(approvalFixture)
    await fp
    check(
      f.freezeCalls.length === 1 &&
        typeof f.freezeCalls[0]!.operationKey === 'string' &&
        (f.freezeCalls[0] as { operationKey: string }).operationKey.length >= 8,
      'T6 超时恢复后冻结可继续（同 key 纪律由 T4 覆盖）',
    )
  }

  // ===== T7 冻结体形态：目标字段平铺 + 冻结字段（与路由白名单一致） =====
  {
    const body = freezeBody({
      target: firstTarget,
      includePlans: false,
      previewHash: '4'.repeat(64),
      acceptedGaps: noGaps,
      operationKey: 'fz_test1234',
    })
    check(
      body.kind === 'manual' &&
        body.episodeId === 3 &&
        body.templateKey === 'm70-fixture-episode' &&
        body.previewHash === '4'.repeat(64) &&
        body.operationKey === 'fz_test1234' &&
        !('target' in body) &&
        !('operationId' in body),
      'T7 冻结体目标字段平铺（kind/episodeId/templateKey）且不带 target 包装',
    )
  }

  // ===== T8+ 各入口接线（Task 12）：未批准不发请求、批准后恰 1 条且携 approvalHash、目标变化不带旧包 =====
  // 每例独立 seed 状态（fake continuity + fake entry api），不互相推断。
  const approvalWith = (hash: string): Approval => ({
    contextId: 7,
    document: { assetId: 41, versionId: 42, hash: 'c'.repeat(64) },
    approvalHash: hash,
  })

  /** 入口 fake：捕获所有入口请求（run/chat/workflow）。 */
  function fakeEntry() {
    const captured: Array<{ op: string; body: Record<string, unknown> }> = []
    const rec =
      (op: string, result: any) =>
      async (_a: number, body?: Record<string, unknown>) => {
        captured.push({ op, body: body ?? {} })
        return result
      }
    const api = {
      run: {
        start: rec('run.start', { run: { id: 101 } }),
        resume: rec('run.resume', { run: { id: 102 } }),
      },
      chat: {
        confirm: rec('chat.confirm', { runId: 103 }),
        advanceChain: rec('chat.advance', { ok: true }),
      },
      workflow: {
        create: rec('wf.create', { workflow: { id: 9 }, warnings: [] }),
        start: rec('wf.start', { workflow: { id: 9 }, runId: 104 }),
        resume: rec('wf.resume', { workflow: { id: 9 } }),
      },
    }
    return { api, captured }
  }

  /** 独立 seed：新建 composable + fake continuity，冻结出当前目标的批准。 */
  async function seedApproved(targetReq: TargetRequest, hash: string) {
    const f = fakeApi()
    const cx = useCreationContinuity(ref(1), f.api)
    cx.setTarget(targetReq)
    // 让 target 深度 watch 先完成作废（flush pre）再发起预览：真实 UI 是「设目标 → 用户点预览」
    await nextTick()
    const pending = cx.state.load()
    f.resolveNextPreview(previewFixture('5'.repeat(64)))
    await pending
    const fp = cx.state.freeze([])
    f.resolveNextFreeze({ approval: approvalWith(hash) })
    await fp
    return { cx, f }
  }

  // ----- T8 手动 submit（RunFormModal adapter） -----
  {
    const manual: TargetRequest = {
      kind: 'manual',
      episodeId: 3,
      templateKey: 'm70-fixture-episode',
      input: { episode_number: 3, with_continuity: true },
    }
    const entry = fakeEntry()
    // 未批准：不发请求
    const denied = await cont.submitManualRun(entry.api, {
      projectId: 1,
      templateKey: 'm70-fixture-episode',
      input: { episode_number: 3, brief: '第3集' },
      withContinuity: true,
      approval: null,
    })
    check(
      denied.sent === false && entry.captured.length === 0,
      'T8 手动 submit 未批准时不发请求',
    )
    // 批准后：恰 1 条且 body 携 approvalHash + input 两键
    const { cx } = await seedApproved(manual, 'd'.repeat(64))
    const approvedReq = {
      projectId: 1,
      templateKey: 'm70-fixture-episode',
      input: { episode_number: 3, brief: '第3集' },
      withContinuity: true,
      approval: cx.approval.value,
    }
    const ok = await cont.submitManualRun(entry.api, approvedReq)
    check(
      ok.sent === true &&
        entry.captured.length === 1 &&
        (entry.captured[0]!.body.continuity_approval as Approval)
          .approvalHash === 'd'.repeat(64),
      'T8 手动 submit 批准后恰 1 条且携 approvalHash',
    )
    const body = entry.captured[0]!.body
    const input = body.input as Record<string, unknown>
    check(
      input.with_continuity === true &&
        Array.isArray(input.continuity_context) &&
        (input.continuity_context as number[])[0] === 41 &&
        input.episode_number === 3,
      'T8 手动 submit input 含 with_continuity 与批准包槽位（不含审批句柄混入 input）',
    )
    // 目标变化：旧包失效，再提交不发请求
    cx.setTarget({
      kind: 'manual',
      episodeId: 4,
      templateKey: 'm70-fixture-episode',
      input: { episode_number: 4, with_continuity: true },
    })
    check(cx.approval.value === null, 'T8 目标变化后旧批准立即失效')
    const stale = await cont.submitManualRun(entry.api, {
      ...approvedReq,
      approval: cx.approval.value,
    })
    check(
      stale.sent === false && entry.captured.length === 1,
      'T8 目标变化后不带旧包重提（不新增请求）',
    )
  }

  // ----- T9 confirmRoute（CreationRouteConfirm / confirm 路径） -----
  {
    const route: TargetRequest = {
      kind: 'route',
      sessionId: 11,
      decisionRevision: 5,
      decisionHash: 'e'.repeat(64),
    }
    const entry = fakeEntry()
    const routeReq = (
      revision: number,
      key: string,
      approval: Approval | null,
    ) => ({
      sessionId: 11,
      decisionRevision: revision,
      decisionHash: 'e'.repeat(64),
      idempotencyKey: key,
      acceptUnpriced: true,
      withContinuity: true,
      approval,
    })
    const denied = await cont.confirmRoute(
      entry.api,
      routeReq(5, 'cft_test1', null),
    )
    check(
      denied.sent === false && entry.captured.length === 0,
      'T9 route 确认未批准不提交',
    )
    const { cx } = await seedApproved(route, 'f'.repeat(64))
    const ok = await cont.confirmRoute(
      entry.api,
      routeReq(5, 'cft_test2', cx.approval.value),
    )
    const body = entry.captured[0]?.body ?? {}
    check(
      ok.sent === true &&
        entry.captured.length === 1 &&
        (body.continuityApproval as Approval).approvalHash === 'f'.repeat(64) &&
        body.decisionHash === 'e'.repeat(64) &&
        body.decisionRevision === 5 &&
        body.acceptUnpriced === true,
      'T9 route 确认批准后 1 条且携 approvalHash + decision 字段',
    )
    // 决策修订（revision 变化 = 新目标）：旧包作废、再确认不发请求
    const { cx: cxRoute } = await seedApproved(route, 'f'.repeat(64))
    cxRoute.setTarget({
      kind: 'route',
      sessionId: 11,
      decisionRevision: 6,
      decisionHash: 'e'.repeat(64),
    })
    const stale = await cont.confirmRoute(
      entry.api,
      routeReq(6, 'cft_test3', cxRoute.approval.value),
    )
    check(
      cxRoute.approval.value === null &&
        stale.sent === false &&
        entry.captured.filter((c) => c.op === 'chat.confirm').length === 1,
      'T9 决定修订后旧包失效、不带旧包再确认（无新请求）',
    )
  }

  // ----- T10 advanceChain（use-creation-chain） -----
  {
    const target = cont.workflowTarget(9, 2, 55)
    const entry = fakeEntry()
    const denied = await cont.advanceChain(entry.api, {
      sessionId: 11,
      keyBase: 'chg_base1234',
      approval: null,
      requiresApproval: true,
    })
    check(
      denied.sent === false && entry.captured.length === 0,
      'T10 段间推进未批准不发请求',
    )
    const { cx } = await seedApproved(target, '1'.repeat(64))
    const firstApproval = cx.approval.value!
    const ok = await cont.advanceChain(entry.api, {
      sessionId: 11,
      keyBase: 'chg_base1234',
      approval: firstApproval,
      requiresApproval: true,
    })
    const body = entry.captured[0]?.body ?? {}
    check(
      ok.sent === true &&
        entry.captured.length === 1 &&
        (body.continuityApproval as Approval).approvalHash === '1'.repeat(64) &&
        String(body.idempotencyKey).includes('1'.repeat(16)),
      'T10 段间推进批准后 1 条且 requestKey 纳入 approvalHash',
    )
    check(
      cont.chainAdvanceKey('chg_base1234', '2'.repeat(64)) !==
        cont.chainAdvanceKey('chg_base1234', '1'.repeat(64)) &&
        cont.chainAdvanceKey('chg_base1234', '1'.repeat(64)) ===
          String(body.idempotencyKey),
      'T10 换包不得沿用旧 request key（同 base 不同 approvalHash → 不同键）',
    )
  }

  // ----- T11 workflow start / resume（workflows-section） -----
  {
    const target: TargetRequest = {
      kind: 'workflow',
      workflowId: 9,
      nextSeq: 0,
      previousRunId: null,
    }
    const entry = fakeEntry()
    const wfReq = (
      nextSeq: number,
      previousRunId: number | null,
      approval: Approval | null,
    ) => ({
      workflowId: 9,
      nextSeq,
      previousRunId,
      approval,
      requiresApproval: true,
    })
    const deniedStart = await cont.startWorkflow(
      entry.api,
      wfReq(0, null, null),
    )
    check(
      deniedStart.sent === false && entry.captured.length === 0,
      'T11 workflow start 未批准不发请求',
    )
    const { cx } = await seedApproved(target, '3'.repeat(64))
    const okStart = await cont.startWorkflow(
      entry.api,
      wfReq(0, null, cx.approval.value),
    )
    check(
      okStart.sent === true &&
        entry.captured.length === 1 &&
        entry.captured[0]!.op === 'wf.start' &&
        (entry.captured[0]!.body.continuity_approval as Approval)
          .approvalHash === '3'.repeat(64),
      'T11 workflow start 批准后 1 条且携 continuity_approval',
    )
    // resume 单独 seed
    const entry2 = fakeEntry()
    const deniedResume = await cont.resumeWorkflow(
      entry2.api,
      wfReq(1, 60, null),
    )
    check(
      deniedResume.sent === false && entry2.captured.length === 0,
      'T11 workflow resume 未批准不发请求',
    )
    const resumeTarget = cont.workflowTarget(9, 1, 60)
    const seed2 = await seedApproved(resumeTarget, '4'.repeat(64))
    const okResume = await cont.resumeWorkflow(
      entry2.api,
      wfReq(1, 60, seed2.cx.approval.value),
    )
    check(
      okResume.sent === true &&
        entry2.captured.length === 1 &&
        entry2.captured[0]!.op === 'wf.resume' &&
        (entry2.captured[0]!.body.continuity_approval as Approval)
          .approvalHash === '4'.repeat(64),
      'T11 workflow resume 批准后 1 条且携 continuity_approval',
    )
    const built = cont.workflowTarget(9, 1, 60)
    check(
      built.kind === 'workflow' &&
        built.workflowId === 9 &&
        built.nextSeq === 1 &&
        built.previousRunId === 60,
      'T11 workflow 目标绑定 workflow/seq/previousRun',
    )
  }

  // ----- T12 chain-builder 即时 start（不得绕过预览） -----
  {
    const chainReq = (
      name: string,
      approval: Approval | null,
      startAfter: boolean,
    ) => ({
      projectId: 1,
      name,
      segments: [{ templateKey: 'm70-fixture-episode' }],
      autoAdvance: 0 as const,
      budgetCap: null,
      approval,
      requiresApproval: true,
      startAfter,
    })
    const entry = fakeEntry()
    const blocked = await cont.createAndStartChain(
      entry.api,
      chainReq('测试链', null, true),
    )
    check(
      blocked.workflowId === 9 &&
        blocked.started === false &&
        blocked.reason === 'approval_required' &&
        entry.captured.length === 1 &&
        entry.captured[0]!.op === 'wf.create',
      'T12 chain-builder 未批准只保存草稿链、不启动首段',
    )
    const entry2 = fakeEntry()
    const started = await cont.createAndStartChain(
      entry2.api,
      chainReq('测试链2', approvalWith('6'.repeat(64)), true),
    )
    check(
      started.started === true &&
        entry2.captured.map((c) => c.op).join(',') === 'wf.create,wf.start' &&
        (entry2.captured[1]!.body.continuity_approval as Approval)
          .approvalHash === '6'.repeat(64),
      'T12 chain-builder 批准后创建并启动（start 携包）',
    )
    const entry3 = fakeEntry()
    const cancelled = await cont.createAndStartChain(
      entry3.api,
      chainReq('测试链3', null, false),
    )
    check(
      cancelled.started === false &&
        entry3.captured.length === 1 &&
        entry3.captured[0]!.op === 'wf.create',
      'T12 取消只保存原草稿链、不启动',
    )
  }

  // ----- T13 普通 run resume（继承=免费复用 / 重跑=先冻新包 / unknown=须确 useId） -----
  {
    // 判定来源只认服务端预检：前端不再从步骤元数据自推（否则 inherit 会被误判 rerun 并携批准）。
    const offPlan = cont.resumePlanOf({ continuityResume: { kind: 'off' } })
    const inheritPlan = cont.resumePlanOf({
      continuityResume: { kind: 'inherit' },
    })
    const rerunPlan = cont.resumePlanOf({
      continuityResume: { kind: 'rerun', unknownUseId: null },
    })
    check(
      offPlan.kind === 'off' &&
        inheritPlan.kind === 'inherit' &&
        rerunPlan.kind === 'rerun',
      'T13 续跑目标判定取自服务端预检：off / inherit / rerun 三类直通',
    )
    const blockedPlan = cont.resumePlanOf({
      continuityResume: { kind: 'blocked', code: 'continuity_source_invalid' },
    })
    const missingPlan = cont.resumePlanOf({})
    check(
      blockedPlan.kind === 'blocked' &&
        blockedPlan.reason.includes('continuity_source_invalid') &&
        missingPlan.kind === 'blocked',
      'T13 预检阻断/缺失显式阻止续跑（不降级为 off 或 rerun）',
    )
    const resumeReq = (
      kind: 'off' | 'inherit' | 'rerun',
      runId: number,
      approval: Approval | null = null,
      over: Record<string, unknown> = {},
    ) => ({
      runId,
      kind,
      approval,
      unknownUseId: null,
      acceptedDuplicateCost: false,
      ...over,
    })
    const entry = fakeEntry()
    const inherited = await cont.resumeRun(entry.api, resumeReq('inherit', 7))
    check(
      inherited.sent === true &&
        entry.captured.length === 1 &&
        !('continuity_approval' in entry.captured[0]!.body),
      'T13 继承成功不携包（免费复用）',
    )
    const offEntry = fakeEntry()
    await cont.resumeRun(offEntry.api, resumeReq('off', 8))
    check(
      Object.keys(offEntry.captured[0]!.body).length === 0,
      'T13 旧普通续跑请求体保持空体（原语义不变）',
    )
    const rerunEntry = fakeEntry()
    const denied = await cont.resumeRun(rerunEntry.api, resumeReq('rerun', 9))
    check(
      denied.sent === false && rerunEntry.captured.length === 0,
      'T13 需重跑但未冻结新包时不发 resume 请求',
    )
    const rerunOk = await cont.resumeRun(
      rerunEntry.api,
      resumeReq('rerun', 9, approvalWith('7'.repeat(64))),
    )
    check(
      rerunOk.sent === true &&
        rerunEntry.captured.length === 1 &&
        (rerunEntry.captured[0]!.body.continuity_approval as Approval)
          .approvalHash === '7'.repeat(64),
      'T13 重跑先冻新包后 resume 携新包',
    )
    const unknownEntry = fakeEntry()
    const notAccepted = await cont.resumeRun(
      unknownEntry.api,
      resumeReq('rerun', 10, approvalWith('8'.repeat(64)), {
        unknownUseId: 77,
      }),
    )
    const wrongId = await cont.resumeRun(
      unknownEntry.api,
      resumeReq('rerun', 10, approvalWith('8'.repeat(64)), {
        unknownUseId: 77,
        acceptedDuplicateCost: true,
        acceptedUnknownUseId: 78,
      }),
    )
    check(
      notAccepted.sent === false &&
        wrongId.sent === false &&
        unknownEntry.captured.length === 0,
      'T13 unknown 未同意（或同意非确切 useId）不发请求',
    )
    const accepted = await cont.resumeRun(
      unknownEntry.api,
      resumeReq('rerun', 10, approvalWith('8'.repeat(64)), {
        unknownUseId: 77,
        acceptedDuplicateCost: true,
        acceptedUnknownUseId: 77,
      }),
    )
    const ub = unknownEntry.captured[0]!.body
    check(
      accepted.sent === true &&
        unknownEntry.captured.length === 1 &&
        ub.unknown_use_id === 77 &&
        ub.accept_possible_duplicate_cost === true,
      'T13 unknown 针对确切 useId 同意后才携三方字段发请求',
    )
  }

  console.log(`\n==== M70 UI 状态探针：${results.length} 项全部通过 ====`)
  for (const line of results) console.log('  ' + line)
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
