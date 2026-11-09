import type { ConversationRecord } from "./conversation-registry.types.js";

export function normalizeStoredConversationRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^conv_[a-f0-9]{32}$/u.test(normalized)) {
    throw new Error(`Invalid conversationRef: ${value}`);
  }
  return normalized;
}

export type MappedConversationRow = {
  associationIsCurrent: boolean;
  record: ConversationRecord;
};

/** Newest activity orders the catalogue; current associations own its routing facts. */
export function selectUniqueConversationRows<Row>(
  rows: Iterable<Row>,
  options: {
    conversationRef(row: Row): string;
    map(row: Row): MappedConversationRow | null;
    limit?: number;
    collectContextRelations?: boolean;
  },
): ConversationRecord[] {
  const unique = new Map<string, MappedConversationRow>();
  const contextRelations = new Map<string, NonNullable<ConversationRecord["contextRelation"]>>();
  for (const row of rows) {
    const existing = unique.get(options.conversationRef(row));
    if (existing?.associationIsCurrent && !options.collectContextRelations) {
      continue;
    }
    const mapped = options.map(row);
    if (!mapped) {
      continue;
    }
    const relation = mapped.record.contextRelation;
    if (relation && contextRelations.get(mapped.record.conversationRef) !== "current") {
      contextRelations.set(mapped.record.conversationRef, relation);
    }
    if (existing?.associationIsCurrent) {
      continue;
    }
    if (!existing) {
      unique.set(mapped.record.conversationRef, mapped);
      continue;
    }
    if (
      mapped.associationIsCurrent &&
      mapped.record.sessionId &&
      mapped.record.sessionKey &&
      mapped.record.role
    ) {
      const {
        routeContext: _context,
        routeContextObserved: _observed,
        ...previous
      } = existing.record;
      unique.set(mapped.record.conversationRef, {
        associationIsCurrent: true,
        record: {
          ...previous,
          sessionId: mapped.record.sessionId,
          sessionKey: mapped.record.sessionKey,
          role: mapped.record.role,
          ...(mapped.record.routeContextObserved ? { routeContextObserved: true as const } : {}),
          ...(mapped.record.routeContext ? { routeContext: mapped.record.routeContext } : {}),
        },
      });
    }
  }
  const values: ConversationRecord[] = [];
  for (const { record } of unique.values()) {
    const contextRelation = contextRelations.get(record.conversationRef);
    values.push(contextRelation ? { ...record, contextRelation } : record);
  }
  return options.limit === undefined ? values : values.slice(0, options.limit);
}
