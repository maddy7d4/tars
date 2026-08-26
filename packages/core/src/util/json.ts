import type { JsonValue } from '@tars/shared';

/**
 * Coerces an arbitrary value into `JsonValue`.
 *
 * Tool input arrives from the Agent SDK typed as `Record<string, unknown>`, but
 * `PermissionRequestEvent.input` is `JsonValue` because that event crosses
 * `postMessage` structured cloning and is persisted into the JSONL session log
 * (Docs/TARS_SPEC.md §4.3). Casting would be a lie: a `Date`, a class instance or
 * a cyclic object all satisfy `unknown` and none of them round-trip. This narrows
 * by inspection instead.
 *
 * Lossy by design, and the losses are the ones JSON already imposes: non-finite
 * numbers, `undefined`, functions, symbols and cycles have no JSON encoding, so
 * they become `null` (in arrays and at the root) or are dropped (as object
 * properties), matching `JSON.stringify` semantics.
 */
export function toJsonValue(value: unknown): JsonValue {
  return convert(value, new Set<object>());
}

function convert(value: unknown, seen: Set<object>): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      // A bigint has no JSON encoding and throws in JSON.stringify; the decimal
      // string is the only representation that survives the wire.
      return value.toString();
    case 'object':
      return convertObject(value, seen);
    default:
      return null;
  }
}

function isDroppedByJson(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * `JSON.stringify` calls `toJSON()` when an object defines one, which is how a
 * `Date` becomes its ISO string rather than `{}` (a `Date` has no own enumerable
 * properties). Honouring it here keeps this module's contract — that its losses
 * are only the ones JSON already imposes — literally true, and keeps a timestamp
 * in a tool argument visible in the approval prompt instead of collapsing to an
 * empty object the user cannot review (Docs/TARS_SPEC.md §4.2).
 */
function toJsonRepresentation(value: object): unknown {
  const candidate: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof candidate !== 'function') {
    return value;
  }
  // A throwing or malformed `toJSON` must not take down event serialisation; the
  // object falls back to structural conversion.
  try {
    return (candidate as (this: object) => unknown).call(value);
  } catch {
    return value;
  }
}

function convertObject(value: object, seen: Set<object>): JsonValue {
  if (seen.has(value)) {
    return null;
  }

  const represented = toJsonRepresentation(value);
  if (represented !== value) {
    // The replacement is converted normally, so a `toJSON` returning an object,
    // an array or a non-finite number is handled by the same rules as any value.
    return convert(represented, seen);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      for (const item of value as readonly unknown[]) {
        items.push(convert(item, seen));
      }
      return items;
    }

    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      // Omitted rather than nulled: JSON.stringify drops these properties entirely,
      // and the UI renders this object as the tool's arguments, so an invented
      // `null` argument would misrepresent the call under review.
      if (isDroppedByJson(item)) {
        continue;
      }
      record[key] = convert(item, seen);
    }
    return record;
  } finally {
    seen.delete(value);
  }
}
