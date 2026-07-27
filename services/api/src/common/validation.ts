import { TransformFnParams } from 'class-transformer';
import { ValidateIf, ValidationOptions } from 'class-validator';

/**
 * Like @IsOptional(), but ONLY for undefined (field absent from the body).
 *
 * class-validator's @IsOptional() also skips validation for an explicit
 * `null`, so a PATCH body like `{ "name": null }` would sail through the
 * DTO layer and blow up later (`null.trim()` → 500, or a raw null reaching
 * Prisma). With this decorator, null runs the field's validators — @IsString
 * etc. then reject it with a controlled 400.
 *
 * Fields that deliberately accept null (e.g. "null clears the value") keep
 * using @IsOptional() plus an explicit @ValidateIf null-guard instead.
 */
export function IsOptionalNonNull(
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined, options);
}

/**
 * @Transform body for numeric fields, replacing a bare @Type(() => Number).
 *
 * @Type coerces with Number(), and Number('') / Number('  ') is 0 — so a
 * blank string silently becomes a VALID zero (a fabricated zero-confidence
 * candidate, a zero priority) instead of a 400. Blank strings map to NaN
 * here, which @IsNumber/@IsInt then reject with a controlled 400; non-blank
 * strings coerce exactly like @Type did; non-strings pass through.
 */
export function toNumberRejectingBlank({ value }: TransformFnParams): unknown {
  if (typeof value === 'string') {
    return value.trim() === '' ? NaN : Number(value);
  }
  return value;
}
