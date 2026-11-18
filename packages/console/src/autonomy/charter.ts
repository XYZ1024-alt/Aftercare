import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { type AutonomyCharter, autonomyCharterSchema } from '@aftercare/contracts';
import { digestJson, type JsonValue } from '@aftercare/domain';
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

export function charterDigest(charter: AutonomyCharter): string {
  return digestJson(charter);
}
