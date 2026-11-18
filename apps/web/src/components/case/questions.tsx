'use client';

import type { QuestionView } from '@aftercare/console/client';
import { useState } from 'react';
import { cents, QUESTION_KIND_LABEL, reasonLabel, shortId, when } from '../../lib/labels.ts';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  INPUT_CLASS,
  Json,
  Notice,
  RefusalNote,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const SOURCE_KINDS = [
  ['operations_review', '运营复核'],
  ['business_decision_record', '业务决策记录'],
  ['pricing_system_record', '定价系统记录'],
] as const;

function Subject({ question }: { readonly question: QuestionView }) {
  const { body } = question;
  switch (body.kind) {
    case 'incident_scope':
      return null;
    case 'baseline':
      return (
        <table className="text-sm">
          <thead className="text-xs text-stone-500">
            <tr>
              <th className="pr-6 text-left font-medium">商品</th>
              <th className="pr-6 text-left font-medium">版本</th>
              <th className="text-left font-medium">当时价格</th>
            </tr>
          </thead>
          <tbody>
            {body.entries.map((entry) => (
              <tr key={entry.objectId}>
                <td className="pr-6">{entry.objectId}</td>
                <td className="pr-6">{entry.version}</td>
                <td>{cents(entry.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'replay_policy':
      return null;
    case 'clarification':
      return (
        <p className="text-sm text-stone-700">
          涉及：{body.scope.map((domain) => `${domain.objectType}/${domain.objectId}`).join('，')}
        </p>
      );
    case 'execution_approval':
      return (
        <p className="text-sm text-stone-700">请在“计划与批准”中审核并批准或拒绝该执行契约。</p>
      );
  }
}

function AnswerForm({ question }: { readonly question: QuestionView }) {
  const answer = useCaseAction('answer');
  const { body } = question;
  const [operations, setOperations] = useState<readonly string[]>([]);
  const [policy, setPolicy] = useState('');
  const [statement, setStatement] = useState('');
  const [sourceKind, setSourceKind] = useState<string>(SOURCE_KINDS[0][0]);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const send = (decision: object) =>
    void answer.run({
      questionId: question.questionId,
      questionDigest: question.digest,
      answer: decision,
    });
  const source = { kind: sourceKind, reference: reference.trim() };
  const grounded = statement.trim() !== '' && reference.trim() !== '';
  const disabled = !question.mayAnswer;

  return (
    <div className="space-y-3">
      {!question.mayAnswer && (
        <Notice tone="neutral">
          回答这个问题需要 {question.requiredCapability} 能力，当前账号没有。
        </Notice>
      )}
      {body.kind === 'incident_scope' && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">
            勾选确属错误的操作（未勾选的不会被当作事故）
          </legend>
          {body.candidates.map((candidate) => (
            <label key={candidate.operationId} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="operation"
                value={candidate.operationId}
                className="mt-1"
                checked={operations.includes(candidate.operationId)}
                onChange={(event) =>
                  setOperations(
                    event.target.checked
                      ? [...operations, candidate.operationId]
                      : operations.filter((id) => id !== candidate.operationId),
                  )
                }
              />
              <span>
                {candidate.objects.join('，')}　
                <code className="text-xs">{candidate.operationType}</code>
                <span className="ml-2 text-xs text-stone-500">
                  提交序号 {candidate.commitSeq}
                  {candidate.batchId === null ? '' : `，批次 ${shortId(candidate.batchId)}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {body.kind === 'replay_policy' && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">选择适用的已登记策略版本</legend>
          {body.options.map((option) => (
            <label key={option.policyVersionId} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="policy"
                value={option.policyVersionId}
                className="mt-1"
                checked={policy === option.policyVersionId}
                onChange={() => setPolicy(option.policyVersionId)}
              />
              <span>
                策略修订 {option.revision}
                <Technical label="规则摘要">
                  <Json value={option.summary} />
                </Technical>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <Field
        label={
          body.kind === 'clarification'
            ? '业务说明（按原文记录，系统不会把它换算成金额）'
            : '确认说明'
        }
      >
        <textarea
          name="statement"
          rows={2}
          className={INPUT_CLASS}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="依据来源">
          <select
            name="source-kind"
            className={INPUT_CLASS}
            value={sourceKind}
            onChange={(event) => setSourceKind(event.target.value)}
          >
            {SOURCE_KINDS.map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="依据编号或出处">
          <input
            name="source-reference"
            className={INPUT_CLASS}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {body.kind === 'incident_scope' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || !grounded || operations.length === 0}
            onClick={() =>
              send({ decision: 'confirm_operations', operationIds: operations, statement, source })
            }
          >
            确认所选 {operations.length} 个操作为事故
          </Button>
        )}
        {body.kind === 'baseline' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || !grounded}
            onClick={() => send({ decision: 'confirm_baseline', statement, source })}
          >
            确认以上基线价格正确
          </Button>
        )}
        {body.kind === 'replay_policy' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || !grounded || policy === ''}
            onClick={() =>
              send({ decision: 'select_policy', policyVersionId: policy, statement, source })
            }
          >
            确认适用所选策略
          </Button>
        )}
        {body.kind === 'clarification' && (
          <Button
            tone="primary"
            pending={answer.pending}
            disabled={disabled || !grounded}
            onClick={() => send({ decision: 'clarify', statement, source })}
          >
            记录业务说明
          </Button>
        )}
      </div>
      {body.kind !== 'clarification' && (
        <div className="space-y-2 rounded border border-dashed border-stone-300 p-3">
          <Field label="留言或拒绝理由（不构成确认，不产生任何授权）">
            <input
              name="note"
              className={INPUT_CLASS}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              pending={answer.pending}
              disabled={disabled || note.trim() === ''}
              onClick={() => send({ decision: 'remark', text: note })}
            >
              仅留言
            </Button>
            <Button
              tone="danger"
              pending={answer.pending}
              disabled={disabled || note.trim() === ''}
              onClick={() => send({ decision: 'decline', reason: note })}
            >
              不予确认
            </Button>
          </div>
        </div>
      )}
      <RefusalNote refusal={answer.refusal} />
    </div>
  );
}

function Question({ question }: { readonly question: QuestionView }) {
  const { body, answer } = question;
  return (
    <li
      data-testid="question"
      data-question={question.questionId}
      data-kind={question.kind}
      data-state={question.state}
      className="space-y-2 border-b border-stone-100 py-3 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            question.state === 'open'
              ? 'waiting'
              : question.state === 'answered'
                ? 'good'
                : 'warning'
          }
        >
          {question.state === 'open'
            ? '待回答'
            : question.state === 'answered'
              ? '已回答'
              : '已失效'}
        </Badge>
        <span className="text-sm font-medium">{QUESTION_KIND_LABEL[question.kind]}</span>
        <span className="text-xs text-stone-500">{when(question.createdAt)}</span>
      </div>
      <p className="text-sm">
        <span className="text-stone-500">需要确认的命题：</span>
        <UntrustedText text={body.proposition} />
      </p>
      <p className="text-sm">
        <span className="text-stone-500">对方案的影响：</span>
        <UntrustedText text={body.relevance} />
      </p>
      <Subject question={question} />
      {body.evidenceRefs.length > 0 && (
        <p className="text-xs text-stone-500">
          依据证据：{body.evidenceRefs.map(shortId).join('，')}（可在“证据与调查”中查看）
        </p>
      )}
      {question.state === 'superseded' && (
        <Notice tone="warning" testId="question-superseded">
          这个问题所依据的内容已经变化（{reasonLabel(answer?.supersededBecause)}），不能再回答。
        </Notice>
      )}
      {question.state === 'answered' && answer !== null && (
        <p className="text-sm text-stone-700">
          {answer.by} 于 {when(answer.at)} 作答：{answer.decision}
          {['remark', 'decline'].includes(answer.decision ?? '') && '（未确认，不产生授权）'}
          {answer.text !== null && (
            <>
              ：<UntrustedText text={answer.text} />
            </>
          )}
        </p>
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
    </li>
  );
}

export function Questions() {
  const { view } = useCase();
  const ordered = [...view.questions].sort((left, right) =>
    left.state === 'open' ? -1 : right.state === 'open' ? 1 : 0,
  );
  return (
    <Card title="业务问题" testId="questions">
      {ordered.length === 0 ? (
        <Empty>目前没有需要回答的问题。</Empty>
      ) : (
        <ul>
          {ordered.map((question) => (
            <Question key={question.questionId} question={question} />
          ))}
        </ul>
      )}
    </Card>
  );
}
