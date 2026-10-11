import { describe, it, expect } from "vitest";

// No mocks needed — json-utils is pure computation, no I/O.
const { tools } = await import("./index.js");

const dummyContext = {} as Parameters<(typeof tools)[0]["execute"]>[1];

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// json_format
// ---------------------------------------------------------------------------

describe("json_format", () => {
  const tool = findTool("json_format");

  it("pretty-prints valid JSON by default", async () => {
    const input = JSON.stringify({ name: "strada", version: 1 });
    const result = await tool.execute({ json: input }, dummyContext);
    expect(result.content).toBe(JSON.stringify({ name: "strada", version: 1 }, null, 2));
  });

  it("minifies JSON when minify is true", async () => {
    const input = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const result = await tool.execute({ json: input, minify: true }, dummyContext);
    expect(result.content).toBe('{"a":1,"b":2}');
  });

  it("returns error for missing json parameter", async () => {
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for invalid JSON", async () => {
    const result = await tool.execute({ json: "{broken" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid JSON");
  });

  it("handles arrays", async () => {
    const result = await tool.execute({ json: "[1,2,3]" }, dummyContext);
    expect(result.content).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  it("handles null value", async () => {
    const result = await tool.execute({ json: "null" }, dummyContext);
    expect(result.content).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// json_query
// ---------------------------------------------------------------------------

describe("json_query", () => {
  const tool = findTool("json_query");

  it("extracts a top-level property", async () => {
    const json = JSON.stringify({ name: "strada" });
    const result = await tool.execute({ json, path: "name" }, dummyContext);
    expect(result.content).toBe("strada");
  });

  it("extracts a nested property", async () => {
    const json = JSON.stringify({ data: { user: { name: "Okan" } } });
    const result = await tool.execute({ json, path: "data.user.name" }, dummyContext);
    expect(result.content).toBe("Okan");
  });

  it("extracts array element with bracket notation", async () => {
    const json = JSON.stringify({ users: ["Alice", "Bob", "Charlie"] });
    const result = await tool.execute({ json, path: "users[1]" }, dummyContext);
    expect(result.content).toBe("Bob");
  });

  it("extracts nested array element property", async () => {
    const json = JSON.stringify({ data: { users: [{ name: "Alice" }, { name: "Bob" }] } });
    const result = await tool.execute({ json, path: "data.users[0].name" }, dummyContext);
    expect(result.content).toBe("Alice");
  });

  it("returns stringified object when result is an object", async () => {
    const json = JSON.stringify({ data: { nested: { value: 42 } } });
    const result = await tool.execute({ json, path: "data.nested" }, dummyContext);
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual({ value: 42 });
  });

  it("returns stringified array when result is an array", async () => {
    const json = JSON.stringify({ items: [1, 2, 3] });
    const result = await tool.execute({ json, path: "items" }, dummyContext);
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual([1, 2, 3]);
  });

  it("returns error for missing json parameter", async () => {
    const result = await tool.execute({ path: "name" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for missing path parameter", async () => {
    const result = await tool.execute({ json: '{"a":1}' }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for invalid JSON", async () => {
    const result = await tool.execute({ json: "not-json", path: "a" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid JSON");
  });

  it("returns error for out-of-bounds array index", async () => {
    const json = JSON.stringify({ items: [1, 2] });
    const result = await tool.execute({ json, path: "items[5]" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("out of bounds");
  });

  it("returns error for accessing property on non-object", async () => {
    const json = JSON.stringify({ value: 42 });
    const result = await tool.execute({ json, path: "value.nested" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-object");
  });

  it("handles numeric values", async () => {
    const json = JSON.stringify({ count: 42 });
    const result = await tool.execute({ json, path: "count" }, dummyContext);
    expect(result.content).toBe("42");
  });

  it("handles boolean values", async () => {
    const json = JSON.stringify({ active: true });
    const result = await tool.execute({ json, path: "active" }, dummyContext);
    expect(result.content).toBe("true");
  });

  it("handles null values in path", async () => {
    const json = JSON.stringify({ data: null });
    const result = await tool.execute({ json, path: "data.child" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("null/undefined");
  });
});

// ---------------------------------------------------------------------------
// json_diff
// ---------------------------------------------------------------------------

describe("json_diff", () => {
  const tool = findTool("json_diff");

  it("reports no differences for identical objects", async () => {
    const json = JSON.stringify({ a: 1, b: 2 });
    const result = await tool.execute({ a: json, b: json }, dummyContext);
    expect(result.content).toContain("No differences found");
  });

  it("detects added properties", async () => {
    const a = JSON.stringify({ name: "strada" });
    const b = JSON.stringify({ name: "strada", version: 2 });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("+ version");
    expect(result.content).toContain("1 difference");
  });

  it("detects removed properties", async () => {
    const a = JSON.stringify({ name: "strada", version: 1 });
    const b = JSON.stringify({ name: "strada" });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("- version");
    expect(result.content).toContain("1 difference");
  });

  it("detects changed values", async () => {
    const a = JSON.stringify({ name: "strada", version: 1 });
    const b = JSON.stringify({ name: "strada", version: 2 });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("~ version");
    expect(result.content).toContain("1 -> 2");
    expect(result.content).toContain("1 difference");
  });

  it("detects nested differences", async () => {
    const a = JSON.stringify({ data: { user: { name: "Alice", age: 30 } } });
    const b = JSON.stringify({ data: { user: { name: "Bob", age: 30 } } });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("~ data.user.name");
    expect(result.content).toContain('"Alice"');
    expect(result.content).toContain('"Bob"');
  });

  it("detects array differences", async () => {
    const a = JSON.stringify({ items: [1, 2, 3] });
    const b = JSON.stringify({ items: [1, 2, 4] });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("~ items[2]");
    expect(result.content).toContain("3 -> 4");
  });

  it("detects added array elements", async () => {
    const a = JSON.stringify({ items: [1, 2] });
    const b = JSON.stringify({ items: [1, 2, 3] });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("+ items[2]");
  });

  it("detects removed array elements", async () => {
    const a = JSON.stringify({ items: [1, 2, 3] });
    const b = JSON.stringify({ items: [1, 2] });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("- items[2]");
  });

  it("detects multiple differences", async () => {
    const a = JSON.stringify({ x: 1, y: 2, z: 3 });
    const b = JSON.stringify({ x: 10, y: 2, w: 4 });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("3 difference(s)");
    expect(result.content).toContain("~ x");
    expect(result.content).toContain("- z");
    expect(result.content).toContain("+ w");
  });

  it("returns error for missing a parameter", async () => {
    const result = await tool.execute({ b: '{"x":1}' }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for missing b parameter", async () => {
    const result = await tool.execute({ a: '{"x":1}' }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("returns error for invalid JSON in a", async () => {
    const result = await tool.execute({ a: "broken", b: '{"x":1}' }, dummyContext);
    expect(result.content).toContain("Error in a");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid JSON");
  });

  it("returns error for invalid JSON in b", async () => {
    const result = await tool.execute({ a: '{"x":1}', b: "broken" }, dummyContext);
    expect(result.content).toContain("Error in b");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid JSON");
  });

  it("handles type changes between object and array", async () => {
    const a = JSON.stringify({ data: { x: 1 } });
    const b = JSON.stringify({ data: [1, 2, 3] });
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("~ data");
    expect(result.content).toContain("1 difference");
  });

  it("compares primitive root values", async () => {
    const result = await tool.execute({ a: "42", b: "99" }, dummyContext);
    expect(result.content).toContain("~ (root)");
    expect(result.content).toContain("42 -> 99");
  });
});

// ---------------------------------------------------------------------------
// json_diff's limits: a part it did not compare is not a part that matched
// ---------------------------------------------------------------------------

describe("json_diff limits", () => {
  const tool = findTool("json_diff");

  /** `levels` nested objects with `leaf` at the bottom. */
  function nest(leaf: unknown, levels: number): string {
    let value: unknown = leaf;
    for (let i = 0; i < levels; i++) value = { n: value };
    return JSON.stringify(value);
  }

  it("does not report equality for documents that differ below the depth limit", async () => {
    const result = await tool.execute({ a: nest(1, 55), b: nest(2, 55) }, dummyContext);
    expect(result.content).not.toBe("No differences found.");
    expect(result.content).not.toMatch(/^No differences found/);
    expect(result.content).toContain("not compared");
    expect(result.content).toContain("deeper than 50");
  });

  it("still finds a difference within the depth limit, with no note", async () => {
    const result = await tool.execute({ a: nest(1, 50), b: nest(2, 50) }, dummyContext);
    expect(result.content).toContain("Found 1 difference(s)");
    expect(result.content).not.toContain("not compared");
  });

  it("says the list is incomplete when it stops at 1000 differences", async () => {
    const a = JSON.stringify(Array.from({ length: 1500 }, (_, i) => i));
    const b = JSON.stringify(Array.from({ length: 1500 }, (_, i) => i + 1));
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("Found at least 1000 difference(s)");
    expect(result.content).toContain("stopped at 1000");
    expect(result.content.split("\n").filter((l: string) => l.startsWith("~ "))).toHaveLength(1000);
  });

  it("applies the 1000 cap to added array elements and keys too", async () => {
    const big = JSON.stringify(Array.from({ length: 1500 }, (_, i) => i));
    const added = await tool.execute({ a: "[]", b: big }, dummyContext);
    expect(added.content.split("\n").filter((l: string) => l.startsWith("+ "))).toHaveLength(1000);
    expect(added.content).toContain("stopped at 1000");

    const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${i}`, i])));
    const removed = await tool.execute({ a: wide, b: "{}" }, dummyContext);
    expect(removed.content.split("\n").filter((l: string) => l.startsWith("- "))).toHaveLength(1000);
    expect(removed.content).toContain("stopped at 1000");
  });

  it("keeps the plain count when exactly every difference was listed", async () => {
    const a = JSON.stringify(Array.from({ length: 1000 }, (_, i) => i));
    const b = JSON.stringify(Array.from({ length: 1000 }, (_, i) => i + 1));
    const result = await tool.execute({ a, b }, dummyContext);
    expect(result.content).toContain("Found 1000 difference(s)");
    expect(result.content).not.toContain("stopped at");
  });
});
