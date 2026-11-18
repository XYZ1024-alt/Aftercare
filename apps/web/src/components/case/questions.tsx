'use client';

import type { QuestionView } from '@aftercare/console/client';
import { useState } from 'react';
import { cents, QUESTION_KIND_LABEL, reasonLabel, shortId, when } from '../../lib/labels.ts';
import {
  Button,
  Card,
  CHECK_CLASS,
  Empty,
  Field,
  INPUT_CLASS,
  Json,
  Notice,
  OPTION_CLASS,
  Pill,
  RefusalNote,
  Table,
  Technical,
} from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';
import { useCase, useCaseAction } from './case-context.tsx';

const SOURCE_KINDS = [
  ['operations_review', '运营复核'],
  ['business_decision_record', '业务决策记录'],
  ['pricing_system_record', '定价系统记录'],
] as const;

const DECISION: Readonly<Record<string, string>> = {
  confirm_operations: '确认事故操作',
  confirm_baseline: '确认基线价格',
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

function Subject({ question }: { readonly question: QuestionView }) {
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
              <th>商品</th>
              <th>版本</th>
              <th className="num">当时价格</th>
            </tr>
          </thead>
          <tbody>
            {body.entries.map((entry) => (
              <tr key={entry.objectId}>
                <td>{entry.objectId}</td>
                <td className="tabular-nums">{entry.version}</td>
                <td className="num">{cents(entry.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      );
    case 'clarification':
      return (
        <p className="text-sm text-ink-soft">
          涉及：{body.scope.map((domain) => `${domain.objectType}/${domain.objectId}`).join('，')}
        </p>
      );
    case 'execution_approval':
      return (
        <p className="text-sm text-ink-soft">请在“计划与批准”中审核并批准或拒绝该执行契约。</p>
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
    <div className="mt-4 space-y-4 border-line border-t pt-4">
      {!question.mayAnswer && (
        <Notice tone="neutral">
          回答这个问题需要 {question.requiredCapability} 能力，当前账号没有。
        </Notice>
      )}
      {body.kind === 'incident_scope' && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-meta font-medium text-ink-soft">
            勾选确属错误的操作（未勾选的不会被当作事故）
          </legend>
          {body.candidates.map((candidate) => (
            <label key={candidate.operationId} className={OPTION_CLASS}>
              <input
                type="checkbox"
                name="operation"
                value={candidate.operationId}
                className={CHECK_CLASS}
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
          <legend className="mb-2 text-meta font-medium text-ink-soft">
            选择适用的已登记策略版本
          </legend>
          {body.options.map((option) => (
            <label key={option.policyVersionId} className={OPTION_CLASS}>
              <input
                type="radio"
                name="policy"
                value={option.policyVersionId}
                className={CHECK_CLASS}
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
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
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
      <div className="flex flex-wrap items-center gap-2">
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
        {!grounded && <span className="text-xs text-muted">填写说明与依据出处后才能确认。</span>}
      </div>
      {body.kind !== 'clarification' && (
        <div className="space-y-3 rounded-field bg-canvas p-4">
          <Field label="留言或拒绝理由（不构成确认，不产生任何授权）">
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
              onClick={() => send({ decision: 'remark', text: note })}
            >
              仅留言
            </Button>
            <Button
              size="sm"
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
  const [tone, state] = STATE[question.state];
  return (
    <li
      data-testid="question"
      data-question={question.questionId}
      data-kind={question.kind}
      data-state={question.state}
      className="rounded-panel bg-card px-[22px] py-5 shadow-soft max-sm:px-4"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Pill tone={tone}>{state}</Pill>
        <span className="font-medium">{QUESTION_KIND_LABEL[question.kind]}</span>
        <span className="ml-auto text-xs text-muted tabular-nums">{when(question.createdAt)}</span>
      </div>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="text-xs text-muted">需要确认的命题</dt>
          <dd className="mt-0.5">
            <UntrustedText text={body.proposition} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">对方案的影响</dt>
          <dd className="mt-0.5 text-ink-soft">
            <UntrustedText text={body.relevance} />
          </dd>
        </div>
      </dl>
      <div className="mt-3 space-y-3 empty:hidden">
        <Subject question={question} />
        {body.evidenceRefs.length > 0 && (
          <p className="text-xs text-muted">
            依据证据：{body.evidenceRefs.map(shortId).join('，')}（可在“证据与调查”中查看）
          </p>
        )}
        {question.state === 'superseded' && (
          <Notice tone="apricot" testId="question-superseded">
            这个问题所依据的内容已经变化（{reasonLabel(answer?.supersededBecause)}），不能再回答。
          </Notice>
        )}
        {question.state === 'answered' && answer !== null && (
          <p className="rounded-input bg-mint-soft px-3.5 py-2.5 text-sm text-mint-ink">
            {answer.by} 于 {when(answer.at)} 作答：
            {DECISION[answer.decision ?? ''] ?? answer.decision}
            {['remark', 'decline'].includes(answer.decision ?? '') && '（未确认，不产生授权）'}
            {answer.text !== null && (
              <>
                ：<UntrustedText text={answer.text} />
              </>
            )}
          </p>
        )}
      </div>
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
  if (ordered.length === 0) {
    return (
      <Card title="业务问题" testId="questions">
        <Empty>目前没有需要回答的问题。</Empty>
      </Card>
    );
  }
  return (
    <ul data-testid="questions" className="space-y-4">
      {ordered.map((question) => (
        <Question key={question.questionId} question={question} />
      ))}
    </ul>
  );
}
