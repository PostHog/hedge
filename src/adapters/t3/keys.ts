import { get, isDocument, remove, same, samePath, set, type Document, type Field } from "../provider-config/fields.ts";

export type Reconciled = { document: Document; record: Field[]; applied: Field[]; kept: string[]; changed: string[]; removed: string[]; disabled: Field[] };

export const isProviderInstance = (path: string[]) => path.length === 2 && path[0] === "providerInstances";

const name = (field: Field) => field.path.join(".");

export function reconcileKeys(current: Document, previous: Field[], wanted: Field[], options: { adopt: boolean; outage: boolean; matches?: (actual: unknown, wanted: unknown) => boolean }): Reconciled {
  const matchesOf = (field: Field) => (isProviderInstance(field.path) ? same : (options.matches ?? same));
  const document = structuredClone(current);
  const result: Reconciled = { document, record: [], applied: [], kept: [], changed: [], removed: [], disabled: [] };
  for (const field of wanted) {
    const matches = matchesOf(field);
    const value = get(document, field.path);
    const old = previous.find((item) => samePath(item.path, field.path));
    if (value !== undefined && !matches(value, field.value) && !(old && matches(value, old.value)) && !options.adopt) {
      result.kept.push(name(field));
      if (old) result.record.push(old);
      continue;
    }
    if (!matches(value, field.value)) {
      set(document, field.path, field.value);
      result.changed.push(name(field));
    }
    result.record.push(field);
    result.applied.push(field);
  }
  for (const field of previous) {
    if (samePath(field.path, ["providerInstances"]) || wanted.some((item) => samePath(item.path, field.path))) continue;
    const matches = matchesOf(field);
    const value = get(document, field.path);
    if (options.outage || (value !== undefined && !matches(value, field.value))) {
      result.record.push(field);
      continue;
    }
    if (value === undefined) continue;
    if (isProviderInstance(field.path) && isDocument(value)) {
      const off = { ...value, enabled: false };
      if (value.enabled !== false) {
        set(document, field.path, off);
        result.disabled.push(field);
      }
      result.record.push({ ...field, value: off });
      continue;
    }
    remove(document, field.path);
    result.removed.push(name(field));
  }
  return result;
}

export function holds(actual: unknown, wanted: unknown): boolean {
  if (!isDocument(wanted) || !isDocument(actual)) return same(actual, wanted);
  return Object.entries(wanted).every(([key, value]) => holds(actual[key], value));
}
