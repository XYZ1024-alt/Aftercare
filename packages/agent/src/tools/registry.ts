import type { CommandOutcome } from '@aftercare/contracts';
import type { JsonObject, JsonValue } from '@aftercare/domain';
import type { EvidenceService } from '@aftercare/evidence';
import type { CaseExecutor } from '@aftercare/execution';
import type { RegistrationSession, RepairCompiler } from '@aftercare/repair';
import type {
  AgentFence,
  AgentStore,
  CaseStore,
  ControlStore,
  RepairStore,
} from '@aftercare/storage';
import type { CaseVerifier } from '@aftercare/verify';
import { z } from 'zod';
import {
  COMMAND_CATEGORIES,
  type FeedbackCategory,
  type FeedbackStage,
  nextStepFor,
} from '../feedback.ts';
import type { ModelToolDefinition } from '../model/adapter.ts';

// The typed tool registry. A tool is the ONLY way a model acts, and a tool
// can do only what its handler does with the trusted context the Runtime
// binds to it. Arguments are untrusted text until the tool's Zod schema has
// accepted them; results are validated against the tool's output schema
// before they are stored or shown.

/**
 * What the Runtime knows and the model cannot change: which run, which case,
 * under which worker generation. No tool parameter can name another case,
 * principal, environment or credential — there is no such parameter.
 */
export interface ToolContext {
  readonly agentRunId: string;
  readonly caseId: string;
  readonly fence: AgentFence;
  readonly toolCallId: string;
  /** The case revision and dependency revision the call was admitted at. */
  readonly revision: string;
  readonly dependencyRevision: string;
  /** The application idempotency key allocated for this call before it began; only the execution tool has one. */
  readonly repairId: string | null;
  readonly services: ToolServices;
  /** Issues one case command of the closed agent list for this tool call, at the current revision. */
  readonly command: (body: JsonObject & { readonly type: string }) => Promise<CommandOutcome>;
}

export interface ToolServices {
  readonly agentStore: AgentStore;
  readonly caseStore: CaseStore;
  readonly store: ControlStore;
  readonly repairStore: RepairStore;
  readonly evidence: EvidenceService;
  readonly compiler: RepairCompiler;
  readonly registrations: RegistrationSession;
  /** The executor and the verifier of the case, under the worker's id: they share its lease generation. */
  readonly executor: CaseExecutor;
  readonly verifier: CaseVerifier;
}

/** A JSON document a handler assembled from stored records; it is validated against the tool's output schema before use. */
export type ToolJson =
  | null
  | boolean
  | number
  | string
  | readonly ToolJson[]
  | { readonly [key: string]: ToolJson };
export type ToolDocument = { readonly [key: string]: ToolJson };

/** Where an observation comes from; attached to every result the model sees. */
export interface ToolSource {
  readonly kind:
    | 'snapshot_evidence'
    | 'control_registry'
    | 'deterministic_compiler'
    | 'case_command'
    | 'application_ledger'
    | 'independent_verifier'
    | 'agent_runtime';
  /** Identifiers and versions of what was read or produced. */
  readonly refs: ToolDocument;
}

export interface ToolRejection {
  readonly code: string;
  readonly stage: FeedbackStage;
  readonly category: FeedbackCategory;
  readonly message: string;
  /** Structured detail of the refusing stage (counterexamples, a conflict), unchanged. */
  readonly detail?: ToolDocument;
}

/** What the Runtime does after the call, beyond recording it. */
export type ToolSignal =
  /** The run now waits for a human; nothing more of this response is executed. */
  | { readonly kind: 'question_opened' }
  /** A deterministic engine or invariant failed: isolate and stop. */
  | { readonly kind: 'invariant_failure'; readonly detail: ToolDocument }
  | { readonly kind: 'pause_requested'; readonly reason: string }
  /** A report was sealed: the Runtime asks the database to conclude the run from it. */
  | { readonly kind: 'report_sealed' };

export type ToolOutcome =
  | {
      readonly status: 'succeeded';
      readonly source: ToolSource;
      /** Must satisfy the output schema of the tool; checked before it is stored or shown. */
      readonly data: ToolDocument;
      /** Records the result rests on, and (for reads) the read set the tool itself recorded. */
      readonly dependencies: ToolDocument;
      readonly signal?: ToolSignal;
    }
  | {
      readonly status: 'rejected';
      readonly rejection: ToolRejection;
      readonly dependencies?: ToolDocument;
      readonly signal?: ToolSignal;
      /** True when the same request may give another answer later although no input changed (a temporary failure). */
      readonly transient?: boolean;
    }
  /** A write whose result is not known. Only reconciliation against the original ledger settles it. */
  | { readonly status: 'outcome_unknown'; readonly message: string };

/**
 * What a result depends on besides the arguments. Two requests with the same
 * tool, the same arguments and the same input version are the same request:
 * the earlier result is shown again and the repeat is counted.
 */
export type InputVersion = 'snapshot' | 'case_revision' | 'dependency_revision';

export interface AgentTool<Args extends z.ZodObject> {
  readonly name: string;
  /** Purpose, permission, input and output limits — everything the model is told about the tool. */
  readonly description: string;
  /**
   * read: observes; it never decides anything (an evidence read appends an
   * evidence record and makes it part of the basis). write: changes control
   * state or a sandbox; refused when the case moved on since the model saw it.
   */
  readonly access: 'read' | 'write';
  readonly inputVersion: InputVersion;
  /** True for the one tool that applies a patch: the Runtime allocates and stores its repair id before it begins. */
  readonly appliesRepair?: boolean;
  /** True when an old result may be replaced by a sourced digest in a long context: it can be read again in full. */
  readonly compactable?: boolean;
  readonly parameters: Args;
  /** The contract of a successful result. */
  readonly output: z.ZodType<JsonObject>;
  readonly run: (context: ToolContext, args: z.output<Args>) => Promise<ToolOutcome>;
  /**
   * For a write whose outcome is not known: what the original ledger says
   * happened. null when the ledger shows that nothing was applied — the
   * request is then settled as not applied; it is never executed again here.
   * A tool without this is idempotent under its tool call id and is simply run again.
   */
  readonly reconcile?: (context: ToolContext, args: z.output<Args>) => Promise<ToolOutcome | null>;
}

/** A tool with its argument and output types erased: how the registry holds and runs it. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly access: 'read' | 'write';
  readonly inputVersion: InputVersion;
  readonly appliesRepair: boolean;
  readonly compactable: boolean;
  readonly definition: ModelToolDefinition;
  /** Parses untrusted argument text into validated, normalised arguments. */
  readonly parse: (
    argumentsText: string,
  ) =>
    | { readonly ok: true; readonly args: JsonObject }
    | { readonly ok: false; readonly message: string };
  readonly run: (context: ToolContext, args: JsonObject) => Promise<SettledOutcome>;
  readonly reconcile:
    | ((context: ToolContext, args: JsonObject) => Promise<SettledOutcome | null>)
    | null;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const documentSchema = z.record(z.string(), z.json());

/** A handler's document as plain JSON: absent optional members are simply not there. */
export function plainDocument(value: ToolDocument): JsonObject {
  return documentSchema.parse(JSON.parse(JSON.stringify(value)));
}

/** An outcome whose documents were validated and are plain JSON: what the Runtime stores and shows. */
export type SettledOutcome =
  | {
      readonly status: 'succeeded';
      readonly source: { readonly kind: ToolSource['kind']; readonly refs: JsonObject };
      readonly data: JsonObject;
      readonly dependencies: JsonObject;
      readonly signal: ToolSignal | null;
    }
  | {
      readonly status: 'rejected';
      readonly rejection: ToolRejection;
      readonly dependencies: JsonObject | null;
      readonly signal: ToolSignal | null;
      readonly transient: boolean;
    }
  | { readonly status: 'outcome_unknown'; readonly message: string };

function settled(
  name: string,
  output: z.ZodType<JsonObject>,
  outcome: ToolOutcome,
): SettledOutcome {
  switch (outcome.status) {
    case 'outcome_unknown':
      return outcome;
    case 'rejected':
      return {
        status: 'rejected',
        rejection: outcome.rejection,
        dependencies:
          outcome.dependencies === undefined ? null : plainDocument(outcome.dependencies),
        signal: outcome.signal ?? null,
        transient: outcome.transient ?? false,
      };
    case 'succeeded': {
      const parsed = output.safeParse(plainDocument(outcome.data));
      if (!parsed.success) {
        // A tool that returns something its own contract does not describe is a defect of this code.
        throw new Error(
          `tool "${name}" produced a result outside its output schema:\n${z.prettifyError(parsed.error)}`,
        );
      }
      return {
        status: 'succeeded',
        source: { kind: outcome.source.kind, refs: plainDocument(outcome.source.refs) },
        data: parsed.data,
        dependencies: plainDocument(outcome.dependencies),
        signal: outcome.signal ?? null,
      };
    }
  }
}

export function defineTool<Args extends z.ZodObject>(tool: AgentTool<Args>): RegisteredTool {
  if (!TOOL_NAME.test(tool.name)) {
    throw new Error(`tool name "${tool.name}" is not a portable function name`);
  }
  const parameters = documentSchema.parse(z.toJSONSchema(tool.parameters, { io: 'input' }));
  const { reconcile } = tool;
  return {
    name: tool.name,
    description: tool.description,
    access: tool.access,
    inputVersion: tool.inputVersion,
    appliesRepair: tool.appliesRepair ?? false,
    compactable: tool.compactable ?? false,
    definition: { name: tool.name, description: tool.description, parameters },
    parse: (argumentsText) => {
      let json: JsonValue;
      try {
        json = z.json().parse(JSON.parse(argumentsText));
      } catch (error) {
        return {
          ok: false,
          message: `the arguments are not a JSON document (${error instanceof Error ? error.name : 'Error'})`,
        };
      }
      const parsed = tool.parameters.safeParse(json);
      return parsed.success
        ? { ok: true, args: documentSchema.parse(JSON.parse(JSON.stringify(parsed.data))) }
        : { ok: false, message: z.prettifyError(parsed.error) };
    },
    run: async (context, args) =>
      settled(tool.name, tool.output, await tool.run(context, tool.parameters.parse(args))),
    reconcile:
      reconcile === undefined
        ? null
        : async (context, args) => {
            const outcome = await reconcile(context, tool.parameters.parse(args));
            return outcome === null ? null : settled(tool.name, tool.output, outcome);
          },
  };
}

export interface ToolRegistry {
  readonly find: (name: string) => RegisteredTool | null;
  readonly definitions: () => ModelToolDefinition[];
  readonly names: () => string[];
}

/** The lease generation the worker thought it held is no longer the current one. Unwinds the loop; nothing is retried. */
export function fenceLost(message: string): Error {
  const error = new Error(message);
  error.name = 'AgentFenceLost';
  return error;
}

export function isFenceLost(error: Error): boolean {
  return error.name === 'AgentFenceLost';
}

export function createToolRegistry(tools: readonly RegisteredTool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length) {
    throw new Error('two tools share a name');
  }
  return {
    find: (name) => byName.get(name) ?? null,
    definitions: () => tools.map((tool) => tool.definition),
    names: () => tools.map((tool) => tool.name),
  };
}

// ── Helpers shared by tool handlers ─────────────────────────────────────────

export function rejected(
  stage: FeedbackStage,
  code: string,
  category: FeedbackCategory,
  message: string,
  detail?: ToolDocument,
): { readonly status: 'rejected'; readonly rejection: ToolRejection } {
  return {
    status: 'rejected',
    rejection:
      detail === undefined
        ? { code, stage, category, message }
        : { code, stage, category, message, detail },
  };
}

/** A refused case command, with its own code, as tool feedback. */
export function commandRejected(outcome: Extract<CommandOutcome, { ok: false }>): {
  readonly status: 'rejected';
  readonly rejection: ToolRejection;
} {
  const { rejection } = outcome;
  return rejected(
    'command',
    rejection.code,
    COMMAND_CATEGORIES[rejection.code],
    rejection.message,
    rejection.conflict === undefined ? undefined : { conflict: rejection.conflict },
  );
}

/** The model-facing form of a rejection: the stage's code and detail, plus what kind of next step it allows. */
export function rejectionDocument(rejection: ToolRejection): JsonObject {
  return plainDocument({
    rejected: {
      code: rejection.code,
      stage: rejection.stage,
      category: rejection.category,
      message: rejection.message,
      nextStep: nextStepFor(rejection.category),
      ...(rejection.detail === undefined ? {} : { detail: rejection.detail }),
    },
  });
}
