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

/** Reads a charter from a .yaml / .yml file, or from JSON. */
export async function readCharterFile(path: string): Promise<AutonomyCharter> {
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
  return parseCharter(document);
}

export function charterDigest(charter: AutonomyCharter): string {
  return digestJson(charter);
}
