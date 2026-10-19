import type { Storage } from "../../../../../types/storage";
import type { CharacterState } from "../model";

import { assertObject, requireDecimal, requireId } from "../validation";
import { assertCharacterState } from "./state";

export const collections = [
  "cards",
  "groups",
  "tags",
  "stores",
  "conversationGroups",
  "owners",
  "memories",
  "links",
  "chunks",
  "candidates",
  "embeddings",
] as const;
export const ownerCollections = [
  "memories",
  "links",
  "chunks",
  "candidates",
  "embeddings",
] as const;
export interface StoredRecord {
  collection: string;
  key: string;
  value: Storage.Value;
  version: string | null;
}

/** Copies supported structured domain values without using JSON text codecs. */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  return value;
}

/** Compares structured records without serializing the full character and memory state. */
export function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const keys = Object.keys(left),
    other = Object.keys(right);
  return (
    Array.isArray(left) === Array.isArray(right) &&
    keys.length === other.length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        equal(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Uses domain identities and bounded ordered slots for derived embeddings whose full input stays in the value. */
function recordKey(
  collection: string,
  value: Storage.Value,
  index: number,
): string {
  if (collection === "embeddings") return String(index).padStart(20, "0");
  assertObject(value, "stored record");
  return requireId(value.id, "stored record id");
}

/** Marks a domain record for the schema codec, which validates every declared field before SQL writes. */
export function storedValue<T extends object>(record: T): Storage.Value {
  return record as Storage.Value;
}

/** Projects individual domain records for the typed SQL tables shared with migration. */
export function records(state: CharacterState): StoredRecord[] {
  const result: StoredRecord[] = [];
  for (const collection of [
    "cards",
    "groups",
    "tags",
    "stores",
    "conversationGroups",
  ] as const) {
    for (const record of state[collection])
      result.push({
        collection,
        key: record.id,
        value: storedValue(record),
        version: null,
      });
  }
  for (const owner of state.owners) {
    const { memories, links, chunks, candidates, embeddings, ...metadata } =
      owner;
    result.push({
      collection: "owners",
      key: owner.ownerKey,
      value: storedValue(metadata),
      version: null,
    });
    for (const collection of ownerCollections)
      for (const [index, record] of owner[collection].entries())
        result.push({
          collection,
          key:
            owner.ownerKey +
            "/" +
            recordKey(collection, storedValue(record), index),
          value: storedValue({ ownerKey: owner.ownerKey, record }),
          version: null,
        });
  }
  return result;
}

/** Reconstructs a validated operation snapshot from separately persisted host records. */
export function stateFromRecords(
  metadata: Storage.Value,
  rows: StoredRecord[],
): CharacterState {
  assertObject(metadata, "character database metadata");
  if (metadata.migrationStatus === "writing")
    throw new Error("Character migration has not completed");
  const state = {
    version: metadata.version,
    nextId: metadata.nextId,
    active: metadata.active === null ? { Model: { id: "chat" } } : metadata.active,
    memoryPreferences: metadata.memoryPreferences,
    cards: [] as Storage.Value[],
    groups: [] as Storage.Value[],
    tags: [] as Storage.Value[],
    stores: [] as Storage.Value[],
    conversationGroups: [] as Storage.Value[],
    owners: [] as Record<string, Storage.Value>[],
  };
  const owners = new Map<string, Record<string, Storage.Value>>();
  for (const row of rows) {
    switch (row.collection) {
      case "owners": {
        assertObject(row.value, "memory owner metadata");
        const owner: Record<string, Storage.Value> = {
          ...row.value,
          memories: [],
          links: [],
          chunks: [],
          candidates: [],
          embeddings: [],
        };
        if (owner.ownerKey !== row.key || owners.has(row.key))
          throw new Error("Invalid memory owner record: " + row.key);
        owners.set(row.key, owner);
        state.owners.push(owner);
        break;
      }
      case "cards":
      case "groups":
      case "tags":
      case "stores":
      case "conversationGroups":
        state[row.collection].push(row.value);
        break;
    }
  }
  for (const row of rows) {
    if (!ownerCollections.some((collection) => collection === row.collection))
      continue;
    assertObject(row.value, "owner-scoped record");
    const ownerKey = requireId(row.value.ownerKey, "record owner key");
    const owner = owners.get(ownerKey);
    if (owner === undefined)
      throw new Error("Missing record owner: " + ownerKey);
    const entries = owner[row.collection];
    if (!Array.isArray(entries))
      throw new Error("Invalid owner collection: " + row.collection);
    if (
      row.key !==
      ownerKey +
        "/" +
        recordKey(row.collection, row.value.record, entries.length)
    ) {
      throw new Error("Invalid owner-scoped record: " + row.key);
    }
    entries.push(row.value.record);
  }
  // A persisted counter can lag behind identities written by an earlier process
  // (a background job may allocate ids without publishing the `meta` record).
  // Raising it here turns that into a harmless skipped range instead of a fatal
  // "nextId does not exceed stored identity" assertion that bricks the plugin.
  let nextIdentity = BigInt(requireDecimal(String(state.nextId), "nextId", true));
  /** Raises the counter above one stored identity without a Number round trip. */
  const advanceIdentity = (identity: unknown): void => {
    const value = BigInt(requireDecimal(String(identity), "stored identity", true));
    if (value >= nextIdentity) nextIdentity = value + 1n;
  };
  for (const group of state.conversationGroups as { id: string }[])
    advanceIdentity(group.id);
  for (const owner of state.owners as Record<string, unknown>[]) {
    for (const field of ["memories", "links", "chunks", "candidates"] as const)
      for (const record of owner[field] as { id: string }[])
        advanceIdentity(record.id);
    const task = owner.rebuildTask as { id: string } | null;
    if (task !== null && task !== undefined) advanceIdentity(task.id);
  }
  state.nextId = nextIdentity.toString();

  assertCharacterState(state);
  return state;
}
