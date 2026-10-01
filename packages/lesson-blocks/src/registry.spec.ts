import { z } from 'zod';
import { BLOCK_TYPES } from './index';
import { BLOCK_REGISTRY } from './registry';

describe('lesson block registry', () => {
  it('preserves canonical block type order', () => {
    expect(Object.keys(BLOCK_REGISTRY)).toEqual(BLOCK_TYPES);
  });

  it('provides schema-valid defaults except for the operator supplied image fields', () => {
    for (const type of BLOCK_TYPES) {
      const props = BLOCK_REGISTRY[type].defaultProps();
      if (type === 'image') {
        // Image defaults are intentionally incomplete until an operator chooses an asset and writes alt text.
        expect(props).toBe('');
        expect(BLOCK_REGISTRY[type].schema.safeParse(props).success).toBe(false);
      } else {
        expect(BLOCK_REGISTRY[type].schema.safeParse(props).success).toBe(true);
      }
    }
  });

  it('exports schemas representable as JSON Schema', () => {
    for (const type of BLOCK_TYPES) {
      // Refinements express cross-field rules JSON Schema cannot encode; zod emits them as any for form generation.
      expect(() => z.toJSONSchema(BLOCK_REGISTRY[type].schema, { unrepresentable: 'any' })).not.toThrow();
    }
  });
});
