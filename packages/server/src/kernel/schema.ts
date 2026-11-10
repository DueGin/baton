// Deliberately small JSON Schema subset. Unsupported keywords fail explicitly instead of
// silently accepting a schema we cannot enforce. No external validator is required.
export function validateSchema(schema: Record<string, unknown>, value: unknown, path = "$" ): string[] {
  const errors: string[] = [];
  const supported = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "description", "title", "$schema"]);
  for (const key of Object.keys(schema)) if (!supported.has(key)) errors.push(`${path}: unsupported schema keyword ${key}`);
  const object = typeof value === "object" && value !== null && !Array.isArray(value);
  const matches = (type: unknown): boolean => type === "object" ? object : type === "array" ? Array.isArray(value) : type === "null" ? value === null : type === "integer" ? typeof value === "number" && Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type.some(matches) : matches(schema.type))) errors.push(`${path}: expected ${String(schema.type)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) errors.push(`${path}: not in enum`);
  if (object) {
    const record = value as Record<string, unknown>;
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === "string" && !(key in record)) errors.push(`${path}.${key}: required`);
    for (const [key, entry] of Object.entries(record)) {
      const child = props[key];
      if (isObject(child)) errors.push(...validateSchema(child, entry, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property`);
      else if (isObject(schema.additionalProperties)) errors.push(...validateSchema(schema.additionalProperties, entry, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) value.forEach((entry, i) => errors.push(...validateSchema(schema.items as Record<string, unknown>, entry, `${path}[${i}]`)));
  return errors;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
