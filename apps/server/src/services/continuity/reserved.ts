export const RESERVED_PURPOSES = ['continuity_entry', 'continuity_context', 'continuity_use'] as const

export function isContinuityPurpose(purpose: string | null): boolean {
  return purpose !== null && RESERVED_PURPOSES.some(p => p === purpose)
}
