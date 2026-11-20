import type { OperationType } from '@aftercare/domain';

/**
 * The business meaning the compiler gives to every write of one field by one
 * registered template version. A template version that is not listed here has
 * no meaning to the compiler, whatever its name suggests: it is never guessed
 * from a before and after image.
 *
 * - create    the object (and the field) comes into existence; the value is
 *             given by the parameter, not derived.
 * - absolute  the new value is the parameter. The old row is read only as a
 *             concurrency guard, so the result does not depend on it.
 * - delta     the new value is the value read plus the parameter: a business
 *             dependency on the version that was read.
 * - copy      the value read is copied into an immutable downstream object; the
 *             compiler reports the value the order would carry after the
 *             replay, it never repairs the copy.
 */
export type SemanticKind = 'create' | 'absolute' | 'delta' | 'copy';

/** The meaning of one field write of one template version. */
export interface FieldSemantics {
  /** The repairable field this entry explains. */
  readonly fieldId: string;
  readonly kind: SemanticKind;
  /** The operation parameter carrying the value (create, absolute, delta). */
  readonly param?: string;
  /** The downstream field the value is copied into, e.g. order.unit_price_cents (copy). */
  readonly into?: string;
}

/** Every field write of one template version. */
export type TemplateSemantics = readonly FieldSemantics[];

/** Version of this table and of the replay rules attached to each kind. */
export const REPAIR_SEMANTICS_VERSION = 2;

interface TemplateSemanticsEntry {
  readonly templateVersion: number;
  readonly semantics: TemplateSemantics;
}

const ABSOLUTE_PRICE: TemplateSemantics = [
  { fieldId: 'product.price_cents', kind: 'absolute', param: 'price_cents' },
];

const ABSOLUTE_STOCK: TemplateSemantics = [
  { fieldId: 'product.stock_qty', kind: 'absolute', param: 'stock_qty' },
];

const SEMANTICS: Readonly<Record<OperationType, readonly TemplateSemanticsEntry[]>> = {
  create_product: [
    {
      templateVersion: 1,
      semantics: [{ fieldId: 'product.price_cents', kind: 'create', param: 'initial_price_cents' }],
    },
    {
      templateVersion: 2,
      semantics: [
        { fieldId: 'product.price_cents', kind: 'create', param: 'initial_price_cents' },
        { fieldId: 'product.stock_qty', kind: 'create', param: 'initial_stock_qty' },
      ],
    },
  ],
  set_price: [{ templateVersion: 1, semantics: ABSOLUTE_PRICE }],
  batch_set_price: [{ templateVersion: 1, semantics: ABSOLUTE_PRICE }],
  add_price_delta: [
    {
      templateVersion: 1,
      semantics: [{ fieldId: 'product.price_cents', kind: 'delta', param: 'delta_cents' }],
    },
  ],
  set_stock: [{ templateVersion: 1, semantics: ABSOLUTE_STOCK }],
  batch_set_stock: [{ templateVersion: 1, semantics: ABSOLUTE_STOCK }],
  adjust_stock: [
    {
      templateVersion: 1,
      semantics: [{ fieldId: 'product.stock_qty', kind: 'delta', param: 'delta_qty' }],
    },
  ],
  create_order: [
    {
      templateVersion: 1,
      semantics: [{ fieldId: 'product.price_cents', kind: 'copy', into: 'order.unit_price_cents' }],
    },
  ],
};

function isKnownType(operationType: string): operationType is OperationType {
  return Object.hasOwn(SEMANTICS, operationType);
}

/** The field writes of one template version; undefined when the compiler has no meaning for it. */
export function findSemantics(
  operationType: string,
  templateVersion: number,
): TemplateSemantics | undefined {
  if (!isKnownType(operationType)) {
    return undefined;
  }
  return SEMANTICS[operationType].find((entry) => entry.templateVersion === templateVersion)
    ?.semantics;
}

/** The meaning of one template version's write of one field, if it writes that field at all. */
export function semanticsForWrite(
  operationType: string,
  templateVersion: number,
  fieldId: string,
): FieldSemantics | undefined {
  return findSemantics(operationType, templateVersion)?.find(
    (semantics) => semantics.fieldId === fieldId,
  );
}

/** A creation is a fact and can never be confirmed as an incident; every other write can. */
export function isOmittableSemantics(kind: SemanticKind): boolean {
  return kind !== 'create';
}
