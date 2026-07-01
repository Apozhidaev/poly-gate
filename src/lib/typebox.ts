import { type SchemaOptions, Type } from "@sinclair/typebox";

/**
 * A string enum rendered as a proper JSON Schema `{ type: "string", enum: [...] }`.
 *
 * Prefer this over `Type.Union([Type.Literal(...)])`, which compiles to
 * `anyOf: [{ const: ... }]` and is not shown as a dropdown by Swagger UI
 * (only the first option appears and can be selected).
 */
export function StringEnum<T extends string>(values: readonly T[], opts?: SchemaOptions) {
  return Type.Unsafe<T>({ ...opts, type: "string", enum: [...values] });
}
