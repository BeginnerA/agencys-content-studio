/**
 * probe-m70-ui 的静态 fixture（不使用真实服务或用户会话），外移以守住单文件 ≤800 行约束。
 */
import type {
  Acceptance,
  Approval,
  Preview,
  TargetRequest,
} from '../src/lib/types/continuity'

const emptyGaps: never[] = []
export function previewFixture(previewHash: string): { preview: Preview } {
  return {
    preview: {
      doc: {
        schemaVersion: 1,
        rendererVersion: 1,
        target: {
          unit: {
            projectId: 1,
            scopeKind: 'series',
            scopeId: 1,
            unitKind: 'episode',
            unitId: 3,
            unitOrdinal: 3,
          },
          request: {
            kind: 'manual',
            episodeId: 3,
            templateKey: 'm70-fixture-episode',
            input: {},
          },
          templateKey: 'm70-fixture-episode',
          templateSnapshotHash: 'a'.repeat(64),
          stepKey: 'write_script',
          inputHash: 'a'.repeat(64),
          configHash: 'a'.repeat(64),
        },
        entries: [],
        dependencies: [],
        gaps: emptyGaps,
        acceptedGaps: [],
        includePlans: false,
        rendered: '承接包正文',
        renderedHash: 'a'.repeat(64),
        previewHash,
        duplicateCostAcceptance: null,
      },
      chars: 6,
      maxChars: 24_000,
      canFreeze: true,
      blockers: [],
      unknownUseId: null,
    },
  }
}
export const approvalFixture: { approval: Approval } = {
  approval: {
    contextId: 1,
    document: { assetId: 1, versionId: 1, hash: 'a'.repeat(64) },
    approvalHash: 'a'.repeat(64),
  },
}
export const firstTarget: TargetRequest = {
  kind: 'manual',
  episodeId: 3,
  templateKey: 'm70-fixture-episode',
  input: {},
}
export const secondTarget: TargetRequest = {
  kind: 'manual',
  episodeId: 4,
  templateKey: 'm70-fixture-episode',
  input: {},
}
export const noGaps: Acceptance[] = []
