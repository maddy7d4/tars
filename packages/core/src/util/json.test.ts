import type { JsonValue } from '@tars/shared';
import { describe, expect, it } from 'vitest';
import { toJsonValue } from './json.js';

/** The contract that matters: whatever comes back must survive the wire. */
function expectSerialisable(value: JsonValue): void {
  expect(() => JSON.stringify(value)).not.toThrow();
}

describe('toJsonValue', () => {
  describe('primitives', () => {
    it('passes strings through', () => {
      expect(toJsonValue('hello')).toBe('hello');
      expect(toJsonValue('')).toBe('');
    });

    it('passes finite numbers through', () => {
      expect(toJsonValue(42)).toBe(42);
      expect(toJsonValue(-0.5)).toBe(-0.5);
      expect(toJsonValue(0)).toBe(0);
    });

    it('passes booleans through', () => {
      expect(toJsonValue(true)).toBe(true);
      expect(toJsonValue(false)).toBe(false);
    });

    it('passes null through', () => {
      expect(toJsonValue(null)).toBeNull();
    });
  });

  describe('values JSON cannot encode', () => {
    it('nulls non-finite numbers', () => {
      expect(toJsonValue(Number.NaN)).toBeNull();
      expect(toJsonValue(Number.POSITIVE_INFINITY)).toBeNull();
      expect(toJsonValue(Number.NEGATIVE_INFINITY)).toBeNull();
    });

    it('nulls undefined, functions and symbols at the root', () => {
      expect(toJsonValue(undefined)).toBeNull();
      expect(toJsonValue(() => 'x')).toBeNull();
      expect(toJsonValue(Symbol('tag'))).toBeNull();
    });

    it('nulls them inside arrays, matching JSON.stringify', () => {
      const result = toJsonValue([1, undefined, () => 'x', Symbol('tag'), Number.NaN, 'end']);

      expect(result).toEqual([1, null, null, null, null, 'end']);
      expect(JSON.stringify(result)).toBe(JSON.stringify([1, undefined, () => 'x', 'x', Number.NaN, 'end']).replace('"x"', 'null'));
    });

    it('drops them as object properties, matching JSON.stringify', () => {
      const result = toJsonValue({
        kept: 1,
        gone: undefined,
        fn: () => 'x',
        sym: Symbol('tag'),
        nonFinite: Number.NaN,
      });

      expect(result).toEqual({ kept: 1, nonFinite: null });
      expect(Object.keys(result as Record<string, JsonValue>)).toEqual(['kept', 'nonFinite']);
    });

    it('encodes a bigint as its decimal string', () => {
      expect(toJsonValue(9_007_199_254_740_993n)).toBe('9007199254740993');
      expect(toJsonValue({ big: -1n })).toEqual({ big: '-1' });
      expectSerialisable(toJsonValue({ big: 1n }));
    });
  });

  describe('composites', () => {
    it('converts nested objects and arrays structurally', () => {
      const input = {
        name: 'edit',
        args: { path: '/w/a.ts', lines: [1, 2, 3], flags: { force: false } },
        tags: [['a'], ['b', 'c']],
      };

      expect(toJsonValue(input)).toEqual(input);
    });

    it('produces a plain object, not the original reference', () => {
      const input = { a: { b: 1 } };
      const result = toJsonValue(input);

      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('preserves an empty object and an empty array', () => {
      expect(toJsonValue({})).toEqual({});
      expect(toJsonValue([])).toEqual([]);
    });

    it('keeps a repeated (non-cyclic) reference on both branches', () => {
      const shared = { id: 'shared' };

      expect(toJsonValue({ left: shared, right: shared })).toEqual({
        left: { id: 'shared' },
        right: { id: 'shared' },
      });
    });

    it('handles deep nesting without blowing up', () => {
      const depth = 200;
      let node: Record<string, unknown> = { leaf: true };
      for (let index = 0; index < depth; index += 1) {
        node = { child: node };
      }

      const result = toJsonValue(node);

      expectSerialisable(result);
      let cursor: unknown = result;
      for (let index = 0; index < depth; index += 1) {
        cursor = (cursor as Record<string, unknown>)["child"];
      }
      expect(cursor).toEqual({ leaf: true });
    });
  });

  describe('cycles', () => {
    it('nulls a self-referencing object instead of recursing forever', () => {
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic["self"] = cyclic;

      const result = toJsonValue(cyclic);

      expect(result).toEqual({ name: 'root', self: null });
      expectSerialisable(result);
    });

    it('nulls an indirect cycle', () => {
      const a: Record<string, unknown> = { tag: 'a' };
      const b: Record<string, unknown> = { tag: 'b', a };
      a["b"] = b;

      const result = toJsonValue(a);

      expect(result).toEqual({ tag: 'a', b: { tag: 'b', a: null } });
      expectSerialisable(result);
    });

    it('nulls a cycle through an array', () => {
      const items: unknown[] = ['head'];
      items.push(items);

      const result = toJsonValue(items);

      expect(result).toEqual(['head', null]);
      expectSerialisable(result);
    });
  });

  describe('exotic objects', () => {
    it('reduces a Map and a Set to their (empty) own enumerable properties', () => {
      // Same as JSON.stringify: neither exposes entries as own properties.
      expect(toJsonValue(new Map([['k', 'v']]))).toEqual({});
      expect(toJsonValue(new Set([1, 2]))).toEqual({});
    });

    it('reduces a RegExp to an empty object, as JSON.stringify does', () => {
      expect(toJsonValue(/ab+c/giu)).toEqual({});
      expect(JSON.stringify(/ab+c/giu)).toBe('{}');
    });

    it('reduces an Error to its own enumerable properties, as JSON.stringify does', () => {
      const error = new Error('boom');

      // `message` and `stack` are non-enumerable, so both drop out.
      expect(toJsonValue(error)).toEqual({});
      expect(JSON.stringify(error)).toBe('{}');
    });

    it('keeps a custom property attached to an Error', () => {
      const error: Error & { code?: string } = new Error('boom');
      error.code = 'ECONN';

      expect(toJsonValue(error)).toEqual({ code: 'ECONN' });
    });

    it('reduces a class instance to its own enumerable fields', () => {
      class ToolCall {
        constructor(
          readonly name: string,
          readonly attempts: number,
        ) {}

        get label(): string {
          return `${this.name}#${this.attempts}`;
        }

        describe(): string {
          return this.label;
        }
      }

      const result = toJsonValue(new ToolCall('edit', 2));

      // Prototype members (accessor and method) are not own properties.
      expect(result).toEqual({ name: 'edit', attempts: 2 });
    });

    it('keeps a nested array-like structure inside a class instance', () => {
      class Plan {
        readonly steps = [{ id: '1', done: false }];
      }

      expect(toJsonValue(new Plan())).toEqual({ steps: [{ id: '1', done: false }] });
    });

    it('preserves a Date as its ISO string via toJSON', () => {
      const date = new Date('2024-01-02T03:04:05.000Z');

      expect(toJsonValue(date)).toBe('2024-01-02T03:04:05.000Z');
    });

    it('honours toJSON on any object, not just Date', () => {
      class Money {
        constructor(private readonly cents: number) {}
        toJSON(): string {
          return `${String(this.cents / 100)} USD`;
        }
      }

      expect(toJsonValue(new Money(2500))).toBe('25 USD');
    });

    it('falls back to structural conversion when toJSON throws', () => {
      class Hostile {
        readonly kept = 'value';
        toJSON(): never {
          throw new Error('toJSON exploded');
        }
      }

      // Serialising an event must not fail because one argument misbehaves.
      expect(toJsonValue(new Hostile())).toEqual({ kept: 'value' });
    });

    it('applies normal conversion rules to whatever toJSON returns', () => {
      class Weird {
        toJSON(): unknown {
          return { nested: new Date('2024-01-02T03:04:05.000Z'), bad: Number.NaN };
        }
      }

      expect(toJsonValue(new Weird())).toEqual({
        nested: '2024-01-02T03:04:05.000Z',
        bad: null,
      });
    });
  });

  describe('serialisability', () => {
    it('returns something JSON.stringify accepts for every hostile input', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;

      const hostile: readonly unknown[] = [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        () => 'x',
        Symbol('tag'),
        1n,
        new Date(0),
        new Map(),
        new Set(),
        /x/u,
        new Error('boom'),
        cyclic,
        [[[[[1n]]]]],
        { nested: { deeper: [undefined, cyclic] } },
      ];

      for (const value of hostile) {
        expectSerialisable(toJsonValue(value));
      }

      expectSerialisable(toJsonValue(hostile));
    });
  });
});
