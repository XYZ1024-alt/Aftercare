import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY,
  type DomainRegistry,
  type FieldSpec,
  fieldIdOf,
  fieldsOf,
  findField,
  findObject,
  type ObjectTypeSpec,
  type ValueKind,
  validateRegistry,
} from '../src/index.ts';

function productObject(overrides: Partial<ObjectTypeSpec> = {}): ObjectTypeSpec {
  return {
    objectType: 'product',
    tableName: 'products',
    pkColumn: 'product_id',
    versionColumn: 'version',
    displayColumn: 'name',
    columns: ['product_id', 'name', 'price_cents', 'version'],
    repairable: true,
    ...overrides,
  };
}

function orderObject(overrides: Partial<ObjectTypeSpec> = {}): ObjectTypeSpec {
  return {
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
    ...overrides,
  };
}

function priceField(overrides: Partial<FieldSpec> = {}): FieldSpec {
  return {
    fieldId: 'product.price_cents',
    objectType: 'product',
    column: 'price_cents',
    valueKind: 'int64',
    bounds: { min: '0', max: null },
    unit: 'cents',
    title: '价格',
    writeback: 'absolute_if_field_unchanged',
    copyReaders: [{ objectType: 'order', versionColumn: 'product_version' }],
    batchOperationType: 'batch_set_price',
    ...overrides,
  };
}

function priceFieldWithKind(valueKind: string): FieldSpec {
  return { ...priceField(), valueKind: valueKind as ValueKind };
}

function registryWith(
  fields: readonly FieldSpec[],
  objects: readonly ObjectTypeSpec[] = [productObject(), orderObject()],
): DomainRegistry {
  return { objects, fields };
}

describe('DEFAULT_REGISTRY', () => {
  it('describes both object types and the repairable product fields', () => {
    expect(validateRegistry(DEFAULT_REGISTRY)).toEqual([]);

    expect(findObject(DEFAULT_REGISTRY, 'product')).toMatchObject({
      tableName: 'products',
      pkColumn: 'product_id',
      versionColumn: 'version',
      displayColumn: 'name',
      columns: ['product_id', 'name', 'price_cents', 'stock_qty', 'version'],
      repairable: true,
    });
    expect(findObject(DEFAULT_REGISTRY, 'order')).toMatchObject({
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
    });
    expect(findObject(DEFAULT_REGISTRY, 'shipment')).toBeUndefined();

    expect(findField(DEFAULT_REGISTRY, 'product.price_cents')).toMatchObject({
      objectType: 'product',
      column: 'price_cents',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'cents',
      title: '价格',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [{ objectType: 'order', versionColumn: 'product_version' }],
      batchOperationType: 'batch_set_price',
    });
    expect(findField(DEFAULT_REGISTRY, 'product.stock_qty')).toMatchObject({
      objectType: 'product',
      column: 'stock_qty',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'count',
      title: '库存',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [],
      batchOperationType: 'batch_set_stock',
    });
    expect(findField(DEFAULT_REGISTRY, 'order.unit_price_cents')).toBeUndefined();
    expect(fieldsOf(DEFAULT_REGISTRY, 'product')).toHaveLength(2);
    expect(fieldsOf(DEFAULT_REGISTRY, 'order')).toEqual([]);
    expect(fieldIdOf('product', 'price_cents')).toBe('product.price_cents');
  });

  it('accepts a synthetic second field on the same object and finds it by fieldId', () => {
    const syntheticQuantity: FieldSpec = {
      fieldId: 'product.synthetic_qty',
      objectType: 'product',
      column: 'synthetic_qty',
      valueKind: 'int64',
      bounds: { min: '0', max: null },
      unit: 'count',
      title: '库存',
      writeback: 'absolute_if_field_unchanged',
      copyReaders: [],
      batchOperationType: 'batch_set_synthetic_qty',
    };
    const registry = registryWith(
      [priceField(), syntheticQuantity],
      [
        productObject({
          columns: ['product_id', 'name', 'price_cents', 'synthetic_qty', 'version'],
        }),
        orderObject(),
      ],
    );

    expect(validateRegistry(registry)).toEqual([]);
    expect(findField(registry, 'product.synthetic_qty')).toEqual(syntheticQuantity);
    expect(fieldsOf(registry, 'product').map((field) => field.fieldId)).toEqual([
      'product.price_cents',
      'product.synthetic_qty',
    ]);
  });
});

describe('validateRegistry', () => {
  it('rejects duplicate objectType and duplicate fieldId', () => {
    expect(validateRegistry(registryWith([], [productObject(), productObject()]))).toContain(
      "duplicate objectType 'product'",
    );
    expect(validateRegistry(registryWith([priceField(), priceField()]))).toContain(
      "duplicate fieldId 'product.price_cents'",
    );
  });

  it('rejects a fieldId that is not <objectType>.<column>', () => {
    expect(validateRegistry(registryWith([priceField({ fieldId: 'product.price' })]))).toContain(
      "fieldId 'product.price' is not 'product.price_cents'",
    );
  });

  it('rejects a field whose objectType does not exist', () => {
    expect(
      validateRegistry(
        registryWith([priceField({ fieldId: 'shipment.price_cents', objectType: 'shipment' })]),
      ),
    ).toContain("field 'shipment.price_cents' refers to unknown objectType 'shipment'");
  });

  it('rejects a field on an object that is not repairable', () => {
    expect(
      validateRegistry(
        registryWith([
          priceField({
            fieldId: 'order.unit_price_cents',
            objectType: 'order',
            column: 'unit_price_cents',
            copyReaders: [],
          }),
        ]),
      ),
    ).toContain(
      "field 'order.unit_price_cents' targets objectType 'order' which is not repairable",
    );
  });

  it('rejects a field column that the object does not have', () => {
    expect(
      validateRegistry(
        registryWith([priceField({ fieldId: 'product.stock_qty', column: 'stock_qty' })]),
      ),
    ).toContain(
      "field 'product.stock_qty' column 'stock_qty' is not a column of objectType 'product'",
    );
  });

  it('rejects inverted bounds', () => {
    expect(
      validateRegistry(registryWith([priceField({ bounds: { min: '10', max: '5' } })])),
    ).toContain("field 'product.price_cents' bounds are inverted: min 10 > max 5");
  });

  it('rejects bounds that are not canonical decimal int64', () => {
    expect(
      validateRegistry(registryWith([priceField({ bounds: { min: '01', max: null } })])),
    ).toContain("field 'product.price_cents' bounds.min '01' is not a canonical int64");
    expect(
      validateRegistry(registryWith([priceField({ bounds: { min: '0', max: '1e3' } })])),
    ).toContain("field 'product.price_cents' bounds.max '1e3' is not a canonical int64");
  });

  it('rejects a copy reader that points at an unknown objectType', () => {
    expect(
      validateRegistry(
        registryWith([
          priceField({
            copyReaders: [{ objectType: 'shipment', versionColumn: 'product_version' }],
          }),
        ]),
      ),
    ).toContain(
      "field 'product.price_cents' copyReader 'shipment' refers to an unknown objectType",
    );
  });

  it('rejects an unknown valueKind', () => {
    expect(validateRegistry(registryWith([priceFieldWithKind('enum')]))).toContain(
      "field 'product.price_cents' has unknown valueKind 'enum'",
    );
  });

  it('rejects object columns without the primary key or the version column', () => {
    expect(validateRegistry(registryWith([], [productObject({ pkColumn: 'id' })]))).toContain(
      "objectType 'product' columns do not include pkColumn 'id'",
    );
    expect(
      validateRegistry(registryWith([], [productObject({ versionColumn: 'revision' })])),
    ).toContain("objectType 'product' columns do not include versionColumn 'revision'");
  });

  it('rejects duplicate columns on one object', () => {
    expect(
      validateRegistry(
        registryWith(
          [],
          [productObject({ columns: ['product_id', 'name', 'price_cents', 'version', 'version'] })],
        ),
      ),
    ).toContain("objectType 'product' declares duplicate column 'version'");
  });
});
