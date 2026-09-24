import { describe, expect, it } from 'vitest';
import * as shared from './index';

/** Every `*_VALUES` export, discovered by name, so a new vocabulary is
 *  covered automatically instead of having to be listed here. */
const vocabularies: [string, readonly string[]][] = Object.entries(
  shared as Record<string, unknown>,
)
  .filter(([name, value]) => name.endsWith('_VALUES') && Array.isArray(value))
  .map(([name, value]) => [name, value as readonly string[]]);

describe('domain vocabularies', () => {
  it('exports one value list per vocabulary', () => {
    expect(vocabularies.length).toBeGreaterThan(0);
  });

  it.each(vocabularies)('%s is a non-empty list of UPPER_SNAKE codes', (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it.each(vocabularies)('%s has no repeated member', (name, values) => {
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    expect(duplicates, `${name} repeats ${duplicates.join(', ')}`).toEqual([]);
  });
});
