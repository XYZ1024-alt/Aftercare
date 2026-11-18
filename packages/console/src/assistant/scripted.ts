import type { ModelAdapter, ModelMessage, ModelOutcome, ModelToolCall } from '@aftercare/agent';
import type { JsonObject } from '@aftercare/domain';
import { z } from 'zod';

// A test double for the console assistant, used when no model is configured
// (AFTERCARE_MODEL_MODE=scripted_test). It follows a script instead of
// reasoning: the last user message becomes one tool call, and a tool result
// becomes one sentence. It exists so the whole assistant path — request
// schema, tool loop, streaming — can be exercised deterministically; a
// conversation it drives proves nothing about a model.

const documentSchema = z.record(z.string(), z.json());

const MODEL = 'assistant-driver';

/** The one answer shape this double returns: it never fails, so a broken path shows in the transcript. */
function answered(text: string | null, toolCalls: readonly ModelToolCall[]): ModelOutcome {
  return {
    ok: true,
    response: {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: null,
      model: MODEL,
    },
  };
}

/** The tool a result belongs to: the transcript carries the name on the call, not on the result. */
function nameOfCall(messages: readonly ModelMessage[], toolCallId: string): string | null {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.id === toolCallId) return call.name;
    }
  }
  return null;
}

/**
 * The tool result as a document. A result that is not a JSON object is read
 * as an empty one and said so in the answer: the double must not hide a
 * broken transcript behind a normal-sounding sentence.
 */
function resultOf(content: string): { readonly document: JsonObject; readonly note: string } {
  try {
    return { document: documentSchema.parse(JSON.parse(content)), note: '' };
  } catch (error) {
    return {
      document: {},
      note: `（工具结果不是合法 JSON：${error instanceof Error ? error.name : 'Error'}）`,
    };
  }
}

function refusalOf(
  document: JsonObject,
): { readonly code: string; readonly message: string } | null {
  const parsed = z.object({ code: z.string(), message: z.string() }).safeParse(document.refusal);
  return parsed.success ? parsed.data : null;
}

function countOf(document: JsonObject): number {
  const total = document.total;
  if (typeof total === 'number') return total;
  const cases = document.cases;
  return Array.isArray(cases) ? cases.length : 0;
}

/** The sentence after a tool ran: the double never calls another tool. */
function answerForTool(
  messages: readonly ModelMessage[],
  content: string,
  toolCallId: string,
): string {
  const { document, note } = resultOf(content);
  const name = nameOfCall(messages, toolCallId);
  if (name === 'list_cases') {
    return `共 ${countOf(document)} 个案例。${note}`;
  }
  if (name === 'open_case') {
    const refusal = refusalOf(document);
    return refusal === null
      ? `已创建案例并启动调查。${note}`
      : `未执行（${refusal.code}）：${refusal.message}${note}`;
  }
  return `已收到 ${name ?? '未知工具'} 的结果。${note}`;
}

export function createScriptedAssistantModel(): ModelAdapter {
  return {
    describe: () => ({
      provider: 'scripted-test-double',
      model: MODEL,
      endpointHost: 'localhost',
      timeoutMs: 0,
    }),
    complete: async (request) => {
      const last = request.messages.at(-1);
      if (last === undefined) {
        return answered('（脚本化测试替身没有收到任何消息。）', []);
      }
      if (last.role === 'user') {
        // One call id per conversation length: a retry of the same turn keeps the id it had.
        const id = `scripted-${request.messages.length}`;
        const lists = last.content.startsWith('列出');
        return answered(null, [
          {
            id,
            name: lists ? 'list_cases' : 'open_case',
            argumentsText: lists ? '{}' : JSON.stringify({ description: last.content }),
          },
        ]);
      }
      if (last.role === 'tool') {
        return answered(answerForTool(request.messages, last.content, last.toolCallId), []);
      }
      return answered('（脚本化测试替身没有可执行的下一步。）', []);
    },
  };
}
