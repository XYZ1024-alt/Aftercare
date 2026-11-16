import type { OperationType } from '@aftercare/domain';

/**
 * The business meaning the compiler gives to each registered template
 * version. A template version that is not listed here has no meaning to the
 * compiler, whatever its name suggests: it is never guessed from a before and
 * after image.
 *
 * - create_product  creates the object; its price is given, not derived.
 * - absolute_price  the new price is the parameter. The old row is read only
 *                   as a concurrency guard, so the result does not depend on it.
 * - price_delta     the new price is the price read plus the parameter: a
 *                   business dependency on the version that was read.
 * - create_order    copies the price read into an immutable order.
 */
export type SemanticKind = 'create_product' | 'absolute_price' | 'price_delta' | 'create_order';

/** Version of this table and of the replay rules attached to each kind. */
export const REPAIR_SEMANTICS_VERSION = 1;

const SEMANTICS: Readonly<
  Record<
    OperationType,
    readonly { readonly templateVersion: number; readonly kind: SemanticKind }[]
  >
> = {
  create_product: [{ templateVersion: 1, kind: 'create_product' }],
  set_price: [{ templateVersion: 1, kind: 'absolute_price' }],
  batch_set_price: [{ templateVersion: 1, kind: 'absolute_price' }],
  add_price_delta: [{ templateVersion: 1, kind: 'price_delta' }],
  create_order: [{ templateVersion: 1, kind: 'create_order' }],
};

function isKnownType(operationType: string): operationType is OperationType {
  return Object.hasOwn(SEMANTICS, operationType);
}

export function findSemantics(
  operationType: string,
  templateVersion: number,
): SemanticKind | undefined {
  if (!isKnownType(operationType)) {
    return undefined;
  }
  return SEMANTICS[operationType].find((entry) => entry.templateVersion === templateVersion)?.kind;
}
