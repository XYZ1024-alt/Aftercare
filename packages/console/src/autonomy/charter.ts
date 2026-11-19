import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  type AutonomyCharter,
  type AutonomyCharterRecord,
  autonomyCharterSchema,
  charterSummary,
} from '@aftercare/contracts';
import { digestJson, type JsonObject, type JsonValue } from '@aftercare/domain';
import { parse } from 'yaml';
import { z } from 'zod';

/** A charter document, validated. The error names every field that is wrong. */
export function parseCharter(input: JsonValue): AutonomyCharter {
  const parsed = autonomyCharterSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`the charter is not valid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Reads a charter from a .yaml / .yml file, or from JSON. `sourceEnvironment`,
 * when given, replaces the file's: a charter file can serve any environment.
 */
export async function readCharterFile(
  path: string,
  overrides: { readonly sourceEnvironment?: string } = {},
): Promise<AutonomyCharter> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`the charter file ${path} could not be read`, { cause: error });
  }
  const yaml = ['.yaml', '.yml'].includes(extname(path).toLowerCase());
  let document: JsonValue;
  try {
    document = z.json().parse(yaml ? parse(text) : JSON.parse(text));
  } catch (error) {
    throw new Error(`the charter file ${path} is not ${yaml ? 'YAML' : 'JSON'} data`, {
      cause: error,
    });
  }
  if (overrides.sourceEnvironment === undefined) {
    return parseCharter(document);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`the charter file ${path} does not hold one charter document`);
  }
  return parseCharter({ ...document, sourceEnvironment: overrides.sourceEnvironment });
}

/** The field rules as plain JSON: optional keys are written only when set, as the database stores them. */
function fieldsJson(fields: AutonomyCharter['fields']): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(fields).map(([fieldId, rules]) => [
      fieldId,
      {
        incident: {
          operationTypes: [...rules.incident.operationTypes],
          ...(rules.incident.direction === undefined
            ? {}
            : { direction: rules.incident.direction }),
          ...(rules.incident.minRelativeChangeBps === undefined
            ? {}
            : { minRelativeChangeBps: rules.incident.minRelativeChangeBps }),
          ...(rules.incident.minAbsoluteChange === undefined
            ? {}
            : { minAbsoluteChange: rules.incident.minAbsoluteChange }),
        },
        approval: {
          maxAbsoluteChange: rules.approval.maxAbsoluteChange,
          ...(rules.approval.maxRelativeChangeBps === undefined
            ? {}
            : { maxRelativeChangeBps: rules.approval.maxRelativeChangeBps }),
        },
        promotion: {
          maxAbsoluteChange: rules.promotion.maxAbsoluteChange,
          ...(rules.promotion.maxRelativeChangeBps === undefined
            ? {}
            : { maxRelativeChangeBps: rules.promotion.maxRelativeChangeBps }),
        },
      } satisfies JsonObject,
    ]),
  );
}

/** The charter as JSON, with every optional field rule key made explicit. */
export function charterJson(charter: AutonomyCharter): JsonObject {
  return { ...charter, fields: fieldsJson(charter.fields) };
}

/** The summary the console shows, as JSON (the field rules stay, but typed for JSON). */
export function charterSummaryJson(record: AutonomyCharterRecord): JsonObject {
  return { ...charterSummary(record), fields: fieldsJson(record.body.fields) };
}

export function charterDigest(charter: AutonomyCharter): string {
  return digestJson(charterJson(charter));
}
