/**
 * Computes a multiset difference, preserving the resulting diagnostic objects.
 * Diagnostics emitted by js-ts-tools are JSON-like report values, but the key
 * function is defensive so custom SemanticPort implementations can participate.
 */
export function newDiagnostics(
  baseline: readonly unknown[],
  resulting: readonly unknown[],
): readonly unknown[] {
  const remaining = new Map<string, number>();
  for (const diagnostic of baseline) {
    const key = diagnosticKey(diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const added: unknown[] = [];
  for (const diagnostic of resulting) {
    const key = diagnosticKey(diagnostic);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      if (count === 1) remaining.delete(key);
      else remaining.set(key, count - 1);
    } else {
      added.push(diagnostic);
    }
  }
  return added;
}

export function diagnosticKey(value: unknown): string {
  return stableSerialize(value, new Set());
}

function stableSerialize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined": return "undefined";
    case "string": return JSON.stringify(value);
    case "number": return Number.isNaN(value) ? "number:NaN" : `number:${String(value)}`;
    case "boolean": return `boolean:${String(value)}`;
    case "bigint": return `bigint:${value.toString()}`;
    case "symbol": return `symbol:${String(value.description ?? "")}`;
    case "function": return `function:${value.name}`;
    case "object": break;
  }

  const object = value as object;
  if (stack.has(object)) return "[Circular]";
  stack.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item, stack)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], stack)}`).join(",")}}`;
  } finally {
    stack.delete(object);
  }
}
