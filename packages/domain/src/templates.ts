import type { JsonObject } from './canonical.ts';

export const OPERATION_TYPES = [
  'create_product',
  'set_price',
  'add_price_delta',
  'batch_set_price',
  'set_stock',
  'batch_set_stock',
  'adjust_stock',
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
  /** The exact key set of the recorded operation parameters, sorted. */
  readonly params: readonly string[];
  readonly reads: readonly DeclaredRead[];
  readonly writes: readonly DeclaredWrite[];
}

const ABSOLUTE_PRICE_TEMPLATE: OperationTemplate = {
  templateVersion: 1,
  params: ['price_cents', 'product_id'],
  // Absolute pricing does not compute from the old price: both reads only guard the write.
  reads: [
    { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
    { objectType: 'product', field: 'price_cents', dependencyClass: 'concurrency_guard' },
  ],
  writes: [{ objectType: 'product', field: 'price_cents' }],
};

const ABSOLUTE_STOCK_TEMPLATE: OperationTemplate = {
  templateVersion: 1,
  params: ['product_id', 'stock_qty'],
  // An absolute count does not compute from the old count: both reads only guard the write.
  reads: [
    { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
    { objectType: 'product', field: 'stock_qty', dependencyClass: 'concurrency_guard' },
  ],
  writes: [{ objectType: 'product', field: 'stock_qty' }],
};

/** The creation before stock joined the product row; still interpretable for old history. */
const CREATE_PRODUCT_V1: OperationTemplate = {
  templateVersion: 1,
  params: ['initial_price_cents', 'name', 'product_id'],
  reads: [],
  writes: [
    { objectType: 'product', field: 'name' },
    { objectType: 'product', field: 'price_cents' },
  ],
};

/**
 * The current controlled business templates. The database entry functions are
 * the implementation; integration tests assert that every recorded audit row
 * matches the template declared here, and that aftercare.operation_templates
 * holds the same definitions.
 */
export const OPERATION_TEMPLATES: Readonly<Record<OperationType, OperationTemplate>> = {
  create_product: {
    templateVersion: 2,
    params: ['initial_price_cents', 'initial_stock_qty', 'name', 'product_id'],
    reads: [],
    writes: [
      { objectType: 'product', field: 'name' },
      { objectType: 'product', field: 'price_cents' },
      { objectType: 'product', field: 'stock_qty' },
    ],
  },
  set_price: ABSOLUTE_PRICE_TEMPLATE,
  batch_set_price: ABSOLUTE_PRICE_TEMPLATE,
  add_price_delta: {
    templateVersion: 1,
    params: ['delta_cents', 'product_id'],
    reads: [
      { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
      // The new price is old price + delta: a genuine dependency on the old price version.
      { objectType: 'product', field: 'price_cents', dependencyClass: 'business_value' },
    ],
    writes: [{ objectType: 'product', field: 'price_cents' }],
  },
  set_stock: ABSOLUTE_STOCK_TEMPLATE,
  batch_set_stock: ABSOLUTE_STOCK_TEMPLATE,
  adjust_stock: {
    templateVersion: 1,
    params: ['delta_qty', 'product_id'],
    reads: [
      { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
      // The new count is the old count plus the delta: a genuine dependency on the old count version.
      { objectType: 'product', field: 'stock_qty', dependencyClass: 'business_value' },
    ],
    writes: [{ objectType: 'product', field: 'stock_qty' }],
  },
  create_order: {
    templateVersion: 1,
    params: ['order_id', 'product_id', 'quantity'],
    // The struck unit price is copied from the product price version that was read.
    reads: [
      { objectType: 'product', field: 'price_cents', dependencyClass: 'business_value' },
      // Reading the object version records the version the copy was taken at.
      { objectType: 'product', field: 'version', dependencyClass: 'concurrency_guard' },
    ],
    writes: [
      { objectType: 'order', field: 'product_id' },
      { objectType: 'order', field: 'quantity' },
      { objectType: 'order', field: 'unit_price_cents' },
      { objectType: 'order', field: 'product_version' },
    ],
  },
};

/**
 * Every template version this adapter can interpret, including superseded
 * ones. An audited operation citing a version that is not listed here cannot
 * be interpreted, whatever the source database says about it.
 */
export const OPERATION_TEMPLATE_VERSIONS: Readonly<
  Record<OperationType, readonly OperationTemplate[]>
> = {
  create_product: [CREATE_PRODUCT_V1, OPERATION_TEMPLATES.create_product],
  set_price: [OPERATION_TEMPLATES.set_price],
  add_price_delta: [OPERATION_TEMPLATES.add_price_delta],
  batch_set_price: [OPERATION_TEMPLATES.batch_set_price],
  set_stock: [OPERATION_TEMPLATES.set_stock],
  batch_set_stock: [OPERATION_TEMPLATES.batch_set_stock],
  adjust_stock: [OPERATION_TEMPLATES.adjust_stock],
  create_order: [OPERATION_TEMPLATES.create_order],
};

export function isOperationType(value: string): value is OperationType {
  return (OPERATION_TYPES as readonly string[]).includes(value);
}

export function findOperationTemplate(
  operationType: string,
  templateVersion: number,
): OperationTemplate | undefined {
  if (!isOperationType(operationType)) {
    return undefined;
  }
  return OPERATION_TEMPLATE_VERSIONS[operationType].find(
    (template) => template.templateVersion === templateVersion,
  );
}

/** The template as stored in aftercare.operation_templates.definition. */
export function templateDefinition(template: OperationTemplate): JsonObject {
  return {
    params: [...template.params],
    reads: template.reads.map((read) => ({
      object_type: read.objectType,
      field: read.field,
      dependency_class: read.dependencyClass,
    })),
    writes: template.writes.map((write) => ({ object_type: write.objectType, field: write.field })),
  };
}
