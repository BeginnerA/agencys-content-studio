import { createHash } from 'node:crypto'
import { ContinuityError, EntryDocSchema, EntryRefSchema, type EntryDoc, type EntryRef, type Item, type ItemRef } from './contract'

/** Canonical JSON, not a body hash: raw documents are hashed separately as UTF-8 bytes. */
export function canonicalHash(value: unknown): string {
  const ancestors = new Set<object>()
  const invalid = (): never => { throw new ContinuityError('continuity_conflict', 400) }
  const encode = (v: unknown): string => {
    if (v === null) return 'null'
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : invalid()
    if (typeof v !== 'object' || ancestors.has(v)) return invalid()
    const array = Array.isArray(v)
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return invalid()
    ancestors.add(v)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v)
      const keys = Reflect.ownKeys(v)
      if (keys.some(k => typeof k !== 'string')) return invalid()
      for (const k of Object.keys(descriptors)) {
        if (array && k === 'length') continue
        const d = descriptors[k]!
        if (!d.enumerable || !('value' in d)) return invalid()
      }
      if (array) {
        if (keys.length !== v.length + 1) return invalid() // Reject sparse arrays and extra properties.
        const encoded: string[] = []
        for (let i = 0; i < v.length; i++) {
          const d = descriptors[String(i)]
          if (!d) return invalid()
          encoded.push(encode(d.value))
        }
        return `[${encoded.join(',')}]`
      }
      return `{${Object.keys(descriptors).sort().map(k => `${JSON.stringify(k)}:${encode(descriptors[k]!.value)}`).join(',')}}`
    } finally { ancestors.delete(v) }
  }
  return createHash('sha256').update(encode(value), 'utf8').digest('hex')
}

/** Pure structural fold. DB ownership/current validity and source bytes are service preconditions. */
export function foldEntries(entries: { ref: EntryRef; doc: EntryDoc }[]): { current: ItemRef[]; closed: ItemRef[]; retracted: ItemRef[] } {
  for (const entry of entries) {
    if (!EntryRefSchema.safeParse(entry.ref).success || !EntryDocSchema.safeParse(entry.doc).success) {
      throw new ContinuityError('continuity_dependency_invalid', 409)
    }
  }
  const ordered = entries.toSorted((a, b) => a.ref.unitOrdinal - b.ref.unitOrdinal)
  const heads = new Map<string, { ref: ItemRef; op: Item['operation'] }>()
  const ordinals = new Set<number>()
  const units = new Set<number>()
  const entryIds = new Set<number>()
  const scope = ordered[0]?.doc.unit
  for (const entry of ordered) {
    const { unit } = entry.doc
    if (unit.unitOrdinal !== entry.ref.unitOrdinal || unit.projectId !== scope?.projectId || unit.scopeId !== scope.scopeId) {
      throw new ContinuityError('continuity_dependency_invalid', 409)
    }
    if (ordinals.has(unit.unitOrdinal) || units.has(unit.unitId) || entryIds.has(entry.ref.entryId)) {
      throw new ContinuityError('continuity_conflict', 409)
    }
    ordinals.add(unit.unitOrdinal); units.add(unit.unitId); entryIds.add(entry.ref.entryId)
    const touched = new Set<string>()
    for (const item of entry.doc.items.filter(i => i.included)) {
      const slot = JSON.stringify([item.channel, item.channel === 'knowledge' ? item.knower : null, item.topicKey])
      if (touched.has(slot)) throw new ContinuityError('continuity_conflict', 409)
      touched.add(slot)
      const previous = heads.get(slot)
      if (!previous && (item.previous !== null || item.operation !== 'set')) {
        throw new ContinuityError('continuity_dependency_invalid', 409)
      }
      if (previous && canonicalHash(previous.ref) !== canonicalHash(item.previous)) {
        throw new ContinuityError('continuity_conflict', 409)
      }
      heads.set(slot, { ref: { ...entry.ref, itemId: item.id }, op: item.operation })
    }
  }
  const refs = (op: Item['operation']) => Array.from(heads.values()).filter(v => v.op === op).map(v => v.ref)
  return { current: refs('set'), closed: refs('close'), retracted: refs('retract') }
}
