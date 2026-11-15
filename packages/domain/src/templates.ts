export const OPERATION_TYPES = [
  'create_product',
  'set_price',
  'add_price_delta',
  'batch_set_price',
  'create_order',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OBJECT_TYPES = ['product', 'order'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * Why an operation read something.
 * - business_value: the written value was computed from the read value, so a
 *   wrong value propagates through this read.
 * - concurrency_guard: read only to serialise the write or capture the before
 *   image; the written value does not depend on it and nothing propagates.
 */
export const DEPENDENCY_CLASSES = ['business_value', 'concurrency_guard'] as const;
export type DependencyClass = (typeof DEPENDENCY_CLASSES)[number];

export interface DeclaredRead {
  readonly objectType: ObjectType;
  readonly field: string;
  readonly dependencyClass: DependencyClass;
}

export interface DeclaredWrite {
  readonly objectType: ObjectType;
  readonly field: string;
}

export interface OperationTemplate {
  readonly templateVersion: number;
  readonly reads: readonly DeclaredRead[];
  readonly writes: readonly DeclaredWrite[];
}

const ABSOLUTE_PRICE_TEMPLATE: OperationTemplate = {
  templateVersion: 1,
  // Absolute pricing does not compute from the old price: both reads only guard the write.
  reads: [
    { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
    { objectType: 'product', field: 'price_cents', dependencyClass: 'concurrency_guard' },
  ],
  writes: [{ objectType: 'product', field: 'price_cents' }],
};

/**
 * The controlled business templates. The database entry functions are the
 * implementation; integration tests assert that every recorded audit row
 * matches the template declared here.
 */
export const OPERATION_TEMPLATES: Readonly<Record<OperationType, OperationTemplate>> = {
  create_product: {
    templateVersion: 1,
    reads: [],
    writes: [
      { objectType: 'product', field: 'name' },
      { objectType: 'product', field: 'price_cents' },
    ],
  },
  set_price: ABSOLUTE_PRICE_TEMPLATE,
  batch_set_price: ABSOLUTE_PRICE_TEMPLATE,
  add_price_delta: {
    templateVersion: 1,
    reads: [
      { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
      // The new price is old price + delta: a genuine dependency on the old price version.
      { objectType: 'product', field: 'price_cents', dependencyClass: 'business_value' },
    ],
    writes: [{ objectType: 'product', field: 'price_cents' }],
  },
  create_order: {
    templateVersion: 1,
    // The struck unit price is copied from the product price version that was read.
    reads: [{ objectType: 'product', field: 'price_cents', dependencyClass: 'business_value' }],
    writes: [
      { objectType: 'order', field: 'product_id' },
      { objectType: 'order', field: 'quantity' },
      { objectType: 'order', field: 'unit_price_cents' },
      { objectType: 'order', field: 'price_version' },
    ],
  },
};
