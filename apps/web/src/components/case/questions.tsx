'use client';

import type { QuestionView } from '@aftercare/console/client';
import {
  BadgeDollarSign,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquareText,
  Rewind,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import {
  fieldKey,
  fieldTitle,
  fieldValue,
  OPERATOR_CLARIFICATION_SOURCE,
  OPERATOR_SOURCE,
  QUESTION_KIND_LABEL,
  reasonLabel,
  shortId,
  when,
} from '../../lib/labels.ts';
import {
  Button,
  Card,
  Checkbox,
  Disclosure,
  Empty,
  Field,
  INPUT_CLASS,
  Json,
  Notice,
  OPTION_CLASS,
  Pill,
  Radio,
  RefusalNote,
  stagger,
  Table,
  TEXTAREA_CLASS,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const DECISION: Readonly<Record<string, string>> = {
  confirm_operations: '确认事故操作',
  confirm_baseline: '确认基线值',
  select_policy: '选定回放策略',
  clarify: '记录业务说明',
  remark: '留言',
  decline: '不予确认',
};

const STATE = {
  open: ['violet', '待回答'],
  answered: ['mint', '已回答'],
  superseded: ['apricot', '已失效'],
} as const;

const KIND_ICON: Readonly<Record<QuestionView['kind'], LucideIcon>> = {
  incident_scope: ListChecks,
  baseline: BadgeDollarSign,
  replay_policy: Rewind,
  clarification: MessageSquareText,
  execution_approval: ShieldCheck,
};

type IncidentCandidates = Extract<QuestionView['body'], { kind: 'incident_scope' }>['candidates'];
type BaselineEntries = Extract<QuestionView['body'], { kind: 'baseline' }>['entries'];

/** int64 text compared as integers: the commits keep the order they were recorded in. */
const compareInt64 = (left: string, right: string): number => {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** The first few values, then a count: a generated statement stays readable and bounded. */
const listed = (values: readonly string[], limit: number): string =>
  values.length <= limit
    ? values.join('、')
    : `${values.slice(0, limit).join('、')} 等 ${values.length} 项`;

// The server keeps a statement of at least one character with every answer, but
// it is now generated from the record the answer is about rather than typed:
// what an audit reads then comes from the same records the question showed.

/** What confirming these operations records, from their commits and objects. */
function incidentStatement(candidates: IncidentCandidates): string {
  const sequences = [...new Set(candidates.map((candidate) => candidate.commitSeq))].sort(
    compareInt64,
  );
  const objects = [...new Set(candidates.flatMap((candidate) => candidate.objects))];
  return `确认提交序号 ${listed(sequences, 10)} 的 ${candidates.length} 个操作属事故${
    objects.length === 0 ? '' : `（涉及 ${listed(objects, 8)}）`
  }`;
}

/** What confirming the baseline records: its entries, their watermark, and the evidence it rests on. */
function baselineStatement(entries: BaselineEntries, trustedWatermark: string): string {
  const evidence = [...new Set(entries.map((entry) => entry.evidenceId))];
  const cited = evidence.length === 0 ? '' : `，证据 ${listed(evidence.map(shortId), 8)}`;
  return `确认以上 ${entries.length} 项基线值与所引证据一致（可信水位 ${trustedWatermark}${cited}）`;
}

function Subject({ question }: { readonly question: QuestionView }) {
  const { view } = useCase();
  const registry = view.registry;
  const { body } = question;
  switch (body.kind) {
    case 'incident_scope':
    case 'replay_policy':
      return null;
    case 'baseline':
      return (
        <Table>
          <thead>
            <tr>
              <th>对象</th>
              <th>字段</th>
              <th>版本</th>
              <th className="num">当时取值</th>
            </tr>
          </thead>
          <tbody>
            {body.entries.map((entry) => (
              <tr key={fieldKey(entry)}>
                <td>
                  {entry.objectType}/{entry.objectId}
                </td>
                <td>{fieldTitle(registry, entry.fieldId)}</td>
                <td className="tabular-nums">{entry.fieldVersion}</td>
                <td className="num">{fieldValue(registry, entry.fieldId, entry.value)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      );
    case 'clarification':
      return (
        <p className="text-meta text-ink-soft">
          涉及：
          {body.scope
            .map((domain) => `${domain.objectType}/${domain.objectId}.${domain.fieldId}`)
            .join('，')}
        </p>
      );
    case 'execution_approval':
      return <Notice tone="sky">在“计划与批准”中审核并批准或拒绝该执行契约。</Notice>;
  }
}

function AnswerForm({ question }: { readonly question: QuestionView }) {
  const answer = useCaseAction('answer');
  const { body } = question;
  const [operations, setOperations] = useState<readonly string[]>([]);
  // A single registered policy is the only choice there is: preselect it.
  const [policy, setPolicy] = useState(() => {
    if (body.kind !== 'replay_policy' || body.options.length !== 1) return '';
    return body.options[0]?.policyVersionId ?? '';
  });
  const [clarification, setClarification] = useState('');
  const [note, setNote] = useState('');

  const send = (decision: object) =>
    void answer.run({
      questionId: question.questionId,
      questionDigest: question.digest,
      answer: decision,
    });
  const selectedCandidates =
    body.kind === 'incident_scope'
      ? body.candidates.filter((candidate) => operations.includes(candidate.operationId))
      : [];
  const policyOption =
    body.kind === 'replay_policy'
      ? body.options.find((option) => option.policyVersionId === policy)
      : undefined;
  const disabled = !question.mayAnswer;

  return (
    <div className="space-y-4 border-line border-t pt-5">
      {!question.mayAnswer && (
        <Notice tone="neutral">当前账号缺少 {question.requiredCapability} 权限，无法作答。</Notice>
      )}
      {body.kind === 'incident_scope' && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-meta font-medium text-ink-soft">
            请勾选确认为错误的操作（未勾选的将视为正常操作）
          </legend>
          {body.candidates.map((candidate) => (
            <label key={candidate.operationId} className={OPTION_CLASS}>
              <Checkbox
                name="operation"
                value={candidate.operationId}
                checked={operations.includes(candidate.operationId)}
                onChange={(event) =>
                  setOperations(
                    event.target.checked
                      ? [...operations, candidate.operationId]
                      : operations.filter((id) => id !== candidate.operationId),
                  )
                }
              />
              <span className="min-w-0">
                <span className="font-medium">{candidate.objects.join('，')}</span>
                <code className="ml-2 font-mono text-xs text-ink-soft">
                  {candidate.operationType}
                </code>
                <span className="block text-xs text-muted">
                  提交序号 {candidate.commitSeq}
                  {candidate.batchId === null ? '' : `，批次 ${shortId(candidate.batchId)}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {body.kind === 'replay_policy' && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-meta font-medium text-ink-soft">选择适用的策略版本</legend>
          {body.options.map((option) => (
            <label key={option.policyVersionId} className={OPTION_CLASS}>
              <Radio
                name="policy"
                value={option.policyVersionId}
                checked={policy === option.policyVersionId}
                onChange={() => setPolicy(option.policyVersionId)}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">策略修订 {option.revision}</span>
                <Technical label="规则摘要">
                  <Json value={option.summary} />
                </Technical>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {body.kind === 'clarification' && (
        <Field label="业务说明（按原文留存，不折算为具体金额）">
          <textarea
            name="statement"
            rows={3}
            className={TEXTAREA_CLASS}
            value={clarification}
            onChange={(event) => setClarification(event.target.value)}
          />
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {body.kind === 'incident_scope' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || operations.length === 0}
            onClick={() =>
              send({
                decision: 'confirm_operations',
                operationIds: operations,
                statement: incidentStatement(selectedCandidates),
                source: OPERATOR_SOURCE,
              })
            }
          >
            确认所选 {operations.length} 个操作为事故
          </Button>
        )}
        {body.kind === 'baseline' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled}
            onClick={() =>
              send({
                decision: 'confirm_baseline',
                statement: baselineStatement(body.entries, body.trustedWatermark),
                source: OPERATOR_SOURCE,
              })
            }
          >
            确认这些数对
          </Button>
        )}
        {body.kind === 'replay_policy' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || policyOption === undefined}
            onClick={() => {
              if (policyOption === undefined) return;
              send({
                decision: 'select_policy',
                policyVersionId: policyOption.policyVersionId,
                statement: `采用策略修订 ${policyOption.revision}`,
                source: OPERATOR_SOURCE,
              });
            }}
          >
            确认适用所选策略
          </Button>
        )}
        {body.kind === 'clarification' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || clarification.trim() === ''}
            onClick={() =>
              send({
                decision: 'clarify',
                statement: clarification.trim(),
                source: OPERATOR_CLARIFICATION_SOURCE,
              })
            }
          >
            记录业务说明
          </Button>
        )}
      </div>
      {body.kind !== 'clarification' && (
        <Disclosure
          summary="仅留言或不予确认"
          className="rounded-field bg-canvas px-4 py-3"
          summaryClassName="text-meta font-medium text-ink-soft hover:text-ink"
        >
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted">只记录理由，不构成确认，也不产生授权。</p>
            <Field label="留言或拒绝理由（必填）">
              <input
                name="note"
                className={INPUT_CLASS}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                pending={answer.pending}
                disabled={disabled || note.trim() === ''}
                onClick={() => send({ decision: 'remark', text: note.trim() })}
              >
                仅留言
              </Button>
              <Button
                size="sm"
                tone="danger"
                pending={answer.pending}
                disabled={disabled || note.trim() === ''}
                onClick={() => send({ decision: 'decline', reason: note.trim() })}
              >
                不予确认
              </Button>
            </div>
          </div>
        </Disclosure>
      )}
      <RefusalNote refusal={answer.refusal} />
    </div>
  );
}

function Question({
  question,
  index,
}: {
  readonly question: QuestionView;
  readonly index: number;
}) {
  const { body, answer } = question;
  const [tone, state] = STATE[question.state];
  const declined = ['remark', 'decline'].includes(answer?.decision ?? '');
  return (
    <li
      data-testid="question"
      data-question={question.questionId}
      data-kind={question.kind}
      data-state={question.state}
      className="t-enter"
      style={stagger(Math.min(index, 5))}
    >
      <Card
        icon={KIND_ICON[question.kind]}
        tone={tone}
        title={QUESTION_KIND_LABEL[question.kind]}
        aside={
          <div className="flex items-center gap-3">
            <Pill tone={tone}>{state}</Pill>
            <span className="text-xs text-muted tabular-nums">
              提问于 {when(question.createdAt)}
            </span>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-body text-ink">
              <UntrustedText text={body.proposition} />
            </p>
            <p className="text-meta text-ink-soft">
              <span className="text-muted">对方案的影响：</span>
              <UntrustedText text={body.relevance} />
            </p>
          </div>
          <Subject question={question} />
          {body.evidenceRefs.length > 0 && (
            <p className="text-meta text-muted">
              关联证据：{body.evidenceRefs.map(shortId).join('，')}
            </p>
          )}
          {question.state === 'superseded' && (
            <Notice tone="apricot" testId="question-superseded">
              相关依据已变更（{reasonLabel(answer?.supersededBecause)}），该问题已失效，无需作答。
            </Notice>
          )}
          {question.state === 'answered' && answer !== null && (
            <div
              className={
                declined
                  ? 'rounded-field bg-canvas px-4 py-3'
                  : 'rounded-field bg-mint-soft px-4 py-3'
              }
            >
              <p
                className={
                  declined
                    ? 'text-sm font-medium text-ink-soft'
                    : 'text-sm font-medium text-mint-ink'
                }
              >
                {DECISION[answer.decision ?? ''] ?? answer.decision}
                {declined && '（未确认，不产生授权）'}
              </p>
              <p className="mt-1 text-meta text-ink-soft">
                {answer.by} 于 <span className="tabular-nums">{when(answer.at)}</span> 作答
              </p>
              {answer.text !== null && (
                <p className="mt-2 text-sm text-ink">
                  <UntrustedText text={answer.text} />
                </p>
              )}
            </div>
          )}
          {question.state === 'open' && question.kind !== 'execution_approval' && (
            <AnswerForm question={question} />
          )}
          <Technical>
            <p>
              问题 {question.questionId}，摘要 {question.digest}
            </p>
            <p>
              绑定快照 {body.bound.snapshotId}，修订 {body.bound.revision}，依赖修订{' '}
              {body.bound.dependencyRevision}
            </p>
          </Technical>
        </div>
      </Card>
    </li>
  );
}

export function Questions() {
  const { view } = useCase();
  const ordered = [...view.questions].sort((left, right) =>
    left.state === 'open' ? -1 : right.state === 'open' ? 1 : 0,
  );
  if (ordered.length === 0) {
    return (
      <Card title="业务问题" icon={MessageCircleQuestion} tone="violet" testId="questions">
        <Empty>暂无待回答的业务问题</Empty>
      </Card>
    );
  }
  return (
    <ul data-testid="questions" className="space-y-4">
      {ordered.map((question, index) => (
        <Question key={question.questionId} question={question} index={index} />
      ))}
    </ul>
  );
}
