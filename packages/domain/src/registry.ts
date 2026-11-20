import { parseInt64 } from './money.ts';

/**
 * The value types a repairable field can carry. 'int64' is the only kind the
 * domain implements today; enum fields add their own codec and grow this tuple.
 */
export const VALUE_KINDS = ['int64'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** How a value reads in the console: money in cents, or a plain count. */
export type SemanticUnit = 'cents' | 'count';

/** Inclusive bounds of a field, as canonical decimal int64 text; null max means int64 max. */
export interface ValueBounds {
  readonly min: string;
  readonly max: string | null;
}

/** A domain object whose snapshot rows and branches are copied wholesale. */
export interface ObjectTypeSpec {
  readonly objectType: string;
  readonly tableName: string;
  readonly pkColumn: string;
  readonly versionColumn: string;
  readonly displayColumn: string | null;
  /** Every physical column copied for this object, the primary key and version included. */
  readonly columns: readonly string[];
  readonly repairable: boolean;
}

/** A downstream object that persists the version of the value it read. */
export interface CopyReaderSpec {
  readonly objectType: string;
  readonly versionColumn: string;
}

/** One repairable field: the single place that says how its values are read and written. */
export interface FieldSpec {
  /** '<objectType>.<column>', the key carried by every contract. */
  readonly fieldId: string;
  readonly objectType: string;
  readonly column: string;
  readonly valueKind: ValueKind;
  readonly bounds: ValueBounds;
  readonly unit: SemanticUnit;
  readonly title: string;
  readonly writeback: 'absolute_if_field_unchanged';
  readonly copyReaders: readonly CopyReaderSpec[];
  /** The batch operation type that writes this field absolutely. */
  readonly batchOperationType: string;
}

/** The two registries the adapter injects into every downstream package. */
export interface DomainRegistry {
  readonly objects: readonly ObjectTypeSpec[];
  readonly fields: readonly FieldSpec[];
}

/**
 * How one operation template writes one field. The domain only declares and
 * looks these up; replay lives in the packages that own the operation.
 */
export type FieldWriteSemantics =
  | { readonly kind: 'create'; readonly fieldId: string; readonly param: string }
  | { readonly kind: 'absolute'; readonly fieldId: string; readonly param: string }
  | { readonly kind: 'delta'; readonly fieldId: string; readonly param: string }
  | { readonly kind: 'copy'; readonly fieldId: string; readonly into: string };

export function fieldIdOf(objectType: string, column: string): string {
  return `${objectType}.${column}`;
}

/**
 * The controlled registries. The database mirrors them and integration tests
 * assert the two agree, the same way templates.ts is checked against
 * aftercare.operation_templates.
 */
export const DEFAULT_REGISTRY: DomainRegistry = {
  objects: [
    {
      objectType: 'product',
      tableName: 'products',
      pkColumn: 'product_id',
      versionColumn: 'version',
      displayColumn: 'name',
      columns: ['product_id', 'name', 'price_cents', 'stock_qty', 'version'],
      repairable: true,
    },
    {
      objectType: 'order',
      tableName: 'orders',
      pkColumn: 'order_id',
      versionColumn: 'version',
      displayColumn: null,
      columns: [
        'order_id',
        'product_id',
        'quantity',
        'unit_price_cents',
        'product_version',
        'version',
      ],
      repairable: false,
    },
  ],
  fields: [
    {
      fieldId: fieldIdOf('product', 'price_cents'),
      objectType: 'product',
      column: 'price_cents',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'cents',
      title: '价格',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [{ objectType: 'order', versionColumn: 'product_version' }],
      batchOperationType: 'batch_set_price',
    },
    {
      fieldId: fieldIdOf('product', 'stock_qty'),
      objectType: 'product',
      column: 'stock_qty',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'count',
      title: '库存',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [],
      batchOperationType: 'batch_set_stock',
    },
  ],
};

export function findObject(
  registry: DomainRegistry,
  objectType: string,
): ObjectTypeSpec | undefined {
  return registry.objects.find((object) => object.objectType === objectType);
}

export function findField(registry: DomainRegistry, fieldId: string): FieldSpec | undefined {
  return registry.fields.find((field) => field.fieldId === fieldId);
}

export function fieldsOf(registry: DomainRegistry, objectType: string): readonly FieldSpec[] {
  return registry.fields.filter((field) => field.objectType === objectType);
}

function isValueKind(value: string): value is ValueKind {
  return (VALUE_KINDS as readonly string[]).includes(value);
}

function validateBounds(field: FieldSpec, problems: string[]): void {
  const min = parseInt64(field.bounds.min, 'signed');
  if (!min.ok) {
    problems.push(
      `field '${field.fieldId}' bounds.min '${field.bounds.min}' is not a canonical int64`,
    );
  }
  let maxValue: bigint | undefined;
  if (field.bounds.max !== null) {
    const max = parseInt64(field.bounds.max, 'signed');
    if (max.ok) {
      maxValue = max.value;
    } else {
      problems.push(
        `field '${field.fieldId}' bounds.max '${field.bounds.max}' is not a canonical int64`,
      );
    }
  }
  if (min.ok && maxValue !== undefined && min.value > maxValue) {
    problems.push(
      `field '${field.fieldId}' bounds are inverted: min ${min.value} > max ${maxValue}`,
    );
  }
}

/**
 * Every invariant the injected registries must satisfy, as a list of readable
 * problems. An empty list means the registry is valid.
 */
export function validateRegistry(registry: DomainRegistry): readonly string[] {
  const problems: string[] = [];
  const objectsByType = new Map<string, ObjectTypeSpec>();

  for (const object of registry.objects) {
    if (objectsByType.has(object.objectType)) {
      problems.push(`duplicate objectType '${object.objectType}'`);
      continue;
    }
    objectsByType.set(object.objectType, object);

    const columns = new Set<string>();
    for (const column of object.columns) {
      if (columns.has(column)) {
        problems.push(`objectType '${object.objectType}' declares duplicate column '${column}'`);
      }
      columns.add(column);
    }
    if (!columns.has(object.pkColumn)) {
      problems.push(
        `objectType '${object.objectType}' columns do not include pkColumn '${object.pkColumn}'`,
      );
    }
    if (!columns.has(object.versionColumn)) {
      problems.push(
        `objectType '${object.objectType}' columns do not include versionColumn '${object.versionColumn}'`,
      );
    }
  }

  const fieldIds = new Set<string>();
  for (const field of registry.fields) {
    if (fieldIds.has(field.fieldId)) {
      problems.push(`duplicate fieldId '${field.fieldId}'`);
    }
    fieldIds.add(field.fieldId);

    if (field.fieldId !== fieldIdOf(field.objectType, field.column)) {
      problems.push(
        `fieldId '${field.fieldId}' is not '${fieldIdOf(field.objectType, field.column)}'`,
      );
    }

    const object = objectsByType.get(field.objectType);
    if (object === undefined) {
      problems.push(`field '${field.fieldId}' refers to unknown objectType '${field.objectType}'`);
    } else {
      if (!object.repairable) {
        problems.push(
          `field '${field.fieldId}' targets objectType '${field.objectType}' which is not repairable`,
        );
      }
      if (!object.columns.includes(field.column)) {
        problems.push(
          `field '${field.fieldId}' column '${field.column}' is not a column of objectType '${field.objectType}'`,
        );
      }
    }

    if (!isValueKind(field.valueKind)) {
      problems.push(`field '${field.fieldId}' has unknown valueKind '${field.valueKind}'`);
    }

    validateBounds(field, problems);

    for (const reader of field.copyReaders) {
      if (!objectsByType.has(reader.objectType)) {
        problems.push(
          `field '${field.fieldId}' copyReader '${reader.objectType}' refers to an unknown objectType`,
        );
      }
    }
  }

  return problems;
}
