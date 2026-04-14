import { describe, it, expectTypeOf } from 'vitest';
import type { FrameworkPackageId, LegacyFrameworkPackageId } from '../../src/intelligence/framework/framework-types.js';

describe('FrameworkPackageId', () => {
  it('accepts arbitrary string', () => {
    const id: FrameworkPackageId = 'my-new-pkg';
    expectTypeOf(id).toEqualTypeOf<FrameworkPackageId>();
  });
  it('legacy union assignable to general type', () => {
    const legacy: LegacyFrameworkPackageId = 'core';
    const g: FrameworkPackageId = legacy;
    expectTypeOf(g).toEqualTypeOf<FrameworkPackageId>();
  });
});
