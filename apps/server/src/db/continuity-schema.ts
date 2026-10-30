import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Historical IDs deliberately have no cascading FK: deleted sources remain explainable. */
export const contentContinuityRecords = sqliteTable('content_continuity_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  scopeKind: text('scope_kind', { enum: ['series'] }).notNull(),
  scopeId: integer('scope_id').notNull(),
  unitKind: text('unit_kind', { enum: ['episode'] }).notNull(),
  unitId: integer('unit_id').notNull(),
  unitOrdinal: integer('unit_ordinal').notNull(),
  rowType: text('row_type', { enum: ['entry', 'context', 'consumption'] }).notNull(),
  status: text('status', { enum: ['extracting', 'draft', 'failed', 'unknown', 'confirmed', 'superseded', 'frozen', 'bound', 'prepared', 'dispatching', 'completed'] }).notNull(),
  revision: integer('revision').notNull().default(1),
  documentAssetId: integer('document_asset_id'),
  documentVersionId: integer('document_version_id'),
  documentHash: text('document_hash'),
  sourceRunId: integer('source_run_id'),
  sourceStepId: integer('source_step_id'),
  sourceAssetId: integer('source_asset_id'),
  sourceVersionId: integer('source_version_id'),
  sourceHash: text('source_hash'),
  runId: integer('run_id'),
  stepId: integer('step_id'),
  parentId: integer('parent_id'),
  operationKey: text('operation_key').notNull(),
  requestHash: text('request_hash').notNull(),
  approvalKey: text('approval_key'),
  approvalHash: text('approval_hash'),
  replacedById: integer('replaced_by_id'),
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  confirmedAt: integer('confirmed_at'),
}, t => [
  uniqueIndex('idx_continuity_operation').on(t.projectId, t.rowType, t.operationKey),
  uniqueIndex('idx_continuity_confirmed_unit').on(t.projectId, t.scopeKind, t.scopeId, t.unitKind, t.unitId)
    .where(sql`${t.rowType} = 'entry' AND ${t.status} = 'confirmed'`),
  index('idx_continuity_source').on(t.sourceRunId, t.sourceStepId, t.sourceAssetId, t.sourceVersionId),
  index('idx_continuity_parent').on(t.parentId),
  index('idx_continuity_run').on(t.runId, t.stepId),
  check('ck_continuity_row_status', sql`(
    (${t.rowType} = 'entry' AND ${t.status} IN ('extracting','draft','failed','unknown','confirmed','superseded')) OR
    (${t.rowType} = 'context' AND ${t.status} IN ('frozen','bound')) OR
    (${t.rowType} = 'consumption' AND ${t.status} IN ('prepared','dispatching','completed','failed','unknown'))
  )`),
  check('ck_continuity_document', sql`(
    (${t.documentAssetId} IS NOT NULL AND ${t.documentVersionId} IS NOT NULL AND ${t.documentHash} IS NOT NULL) OR
    (${t.documentAssetId} IS NULL AND ${t.documentVersionId} IS NULL AND ${t.documentHash} IS NULL
      AND ${t.rowType} = 'entry' AND ${t.status} IN ('extracting','failed','unknown'))
  )`),
  check('ck_continuity_unit', sql`${t.scopeKind} = 'series' AND ${t.unitKind} = 'episode'
    AND ${t.projectId} > 0 AND ${t.scopeId} > 0 AND ${t.unitId} > 0 AND ${t.unitOrdinal} > 0 AND ${t.revision} >= 0`),
])

export type ContentContinuityRecord = typeof contentContinuityRecords.$inferSelect
