/** Minimal JSON-schema shape for ActionDescriptor contracts. Providers
 *  declare; the registry validates inputs against these BEFORE execute
 *  (structural check only — enough to catch malformed model input without
 *  pulling a full JSON-schema runtime). */

export interface JsonSchemaLike {
  readonly type: 'object' | 'string' | 'number' | 'boolean' | 'array'
  readonly properties?: Readonly<Record<string, JsonSchemaLike>>
  readonly required?: readonly string[]
  readonly enum?: readonly string[]
  readonly items?: JsonSchemaLike
  readonly minItems?: number
  readonly maxItems?: number
  readonly description?: string
}

export type SchemaViolation = { readonly path: string; readonly problem: string }

/** Validate `value` against a JsonSchemaLike; returns [] when valid. */
export function validateAgainstSchema(
  schema: JsonSchemaLike,
  value: unknown,
  path = '$',
): SchemaViolation[] {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [{ path, problem: `expected object, got ${typeof value}` }]
    }
    const record = value as Record<string, unknown>
    const violations: SchemaViolation[] = []
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        violations.push({ path: `${path}.${key}`, problem: 'missing required property' })
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        violations.push(...validateAgainstSchema(subSchema, record[key], `${path}.${key}`))
      }
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return [{ path, problem: `expected array, got ${typeof value}` }]
    }
    const violations: SchemaViolation[] = []
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push({ path, problem: `fewer than ${schema.minItems} items` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push({ path, problem: `more than ${schema.maxItems} items` })
    }
    if (schema.items) {
      value.forEach((item, index) => {
        violations.push(...validateAgainstSchema(schema.items!, item, `${path}[${index}]`))
      })
    }
    return violations
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      return [{ path, problem: `expected string, got ${typeof value}` }]
    }
    if (schema.enum && !schema.enum.includes(value)) {
      return [{ path, problem: `value not in enum: ${schema.enum.join(', ')}` }]
    }
    return []
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [{ path, problem: `expected finite number, got ${typeof value}` }]
    }
    return []
  }
  // boolean
  if (typeof value !== 'boolean') {
    return [{ path, problem: `expected boolean, got ${typeof value}` }]
  }
  return []
}
