// Small interpreter for the frozen §13 schema, not a general JSON Schema engine.
// Unsupported keywords and references are errors, even in an unvisited branch.
import { readFile } from "node:fs/promises";
const schema = JSON.parse(
  await readFile(
    new URL("./tools-observe.schema.json", import.meta.url),
    "utf8",
  ),
);
const supported = new Set([
  "$schema",
  "title",
  "$defs",
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "oneOf",
  "enum",
  "items",
  "maxLength",
  "minLength",
  "default",
]);
const isObject = (x) =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const kind = (x) =>
  x === null ? "null" : Array.isArray(x) ? "array" : typeof x;
function ref(path) {
  if (!path.startsWith("#/"))
    throw Error("Unsupported schema reference: " + path);
  const value = path
    .slice(2)
    .split("/")
    .reduce(
      (s, key) => s?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
      schema,
    );
  if (!isObject(value)) throw Error("Unresolved schema reference: " + path);
  return value;
}
function inspect(s, seen = new Set()) {
  if (!isObject(s)) throw Error("Unsupported schema node");
  if (seen.has(s)) return;
  seen.add(s);
  for (const key of Object.keys(s))
    if (!supported.has(key)) throw Error("Unsupported schema keyword: " + key);
  if (s.$ref) inspect(ref(s.$ref), seen);
  if (
    s.type &&
    !["object", "array", "null", "string", "boolean"].includes(s.type)
  )
    throw Error("Unsupported schema type");
  if (
    s.additionalProperties !== undefined &&
    typeof s.additionalProperties !== "boolean"
  )
    throw Error("Unsupported additionalProperties");
  for (const child of [
    ...Object.values(s.properties ?? {}),
    ...Object.values(s.$defs ?? {}),
    ...(s.oneOf ?? []),
    ...(s.items ? [s.items] : []),
  ])
    inspect(child, seen);
}
inspect(schema);
function validate(s, value) {
  if (s.$ref && !validate(ref(s.$ref), value)) return false;
  if (s.type && kind(value) !== s.type) return false;
  if (
    s.enum &&
    !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))
  )
    return false;
  if (
    s.oneOf &&
    s.oneOf.filter((branch) => validate(branch, value)).length !== 1
  )
    return false;
  if (typeof value === "string") {
    const length = [...value].length; // JSON Schema counts Unicode code points.
    if (s.minLength !== undefined && length < s.minLength) return false;
    if (s.maxLength !== undefined && length > s.maxLength) return false;
  }
  if (
    Array.isArray(value) &&
    s.items &&
    !value.every((x) => validate(s.items, x))
  )
    return false;
  if (isObject(value)) {
    if (s.required && !s.required.every((key) => Object.hasOwn(value, key)))
      return false;
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(s.properties ?? {}, key)) {
        if (!validate(s.properties[key], child)) return false;
      } else if (s.additionalProperties === false) return false;
    }
  }
  return true;
}
export const schemaValid = (params) => validate(schema, params);
// Explicit wrapper policy. These constraints are not part of the §13 schema.
export function parseRequest(
  params,
  { granted = true, limits = { rules: 64, pathsPerRule: 64 } } = {},
) {
  if (!granted) return { error: { code: -32002 } };
  if (params === undefined) params = {}; // omitted transport params, not JSON null
  if (!schemaValid(params)) return { error: { code: -32602 } };
  if (params.rules?.length > limits.rules)
    return { error: { code: -32602, data: { limit: "rules" } } };
  if (
    params.rules?.some(
      (rule) =>
        Array.isArray(rule.input) && rule.input.length > limits.pathsPerRule,
    )
  )
    return { error: { code: -32602, data: { limit: "pathsPerRule" } } };
  return { result: {}, filter: params.rules ?? null };
}
