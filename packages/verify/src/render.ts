import type { VerificationReport } from '@aftercare/contracts';

const LAYER_TITLES = {
  input_sufficiency: '1. Input sufficiency',
  compiled_semantics: '2. Compiled semantics',
  execution_conformance: '3. Execution conformance',
  business_appropriateness: '4. Business appropriateness',
} as const;

/**
 * The human-readable form of one published report. Deterministic: the same
 * report renders to the same bytes, so a file can be re-derived and checked
 * against its registered digest. It states the four layers apart and never
 * says "the business was restored".
 */
export function renderReport(report: VerificationReport): string {
  const { body } = report;
  const lines: string[] = [
    `# Aftercare verification report ${report.reportId}`,
    '',
    `- Report digest: \`${report.digest}\``,
    `- Verdict: **${body.verdict}** (published at case revision ${report.publishedRevision})`,
    `- Case / run: ${body.caseId} / ${body.runId}`,
    `- Plan: ${body.planId} (digest \`${body.planDigest}\`)`,
    `- Execution contract: ${body.contractId} (executionDigest \`${body.executionDigest}\`)`,
    `- Branch: ${body.branchId}, content \`${body.branchContentDigest}\``,
    `- Application: ${body.applicationId}, repairId ${body.repairId}, approval ${body.approvalId}`,
    `- Snapshot: ${body.snapshotId}, watermark ${body.snapshot.baseWatermark}, content \`${body.snapshot.contentDigest}\``,
    `- Knowledge cut-off: case revision ${body.knowledgeCutoff.revision}, dependency revision ${body.knowledgeCutoff.dependencyRevision}`,
    `- Verifier: ${body.verifier.id} v${body.verifier.version}; generated ${body.generatedAt}`,
    '',
    '> Validity is a property of the registry, not of this file. A later change can make this report stale; a downloaded copy does not learn of it.',
    '',
    '## Layers',
    '',
    ...Object.entries(LAYER_TITLES).map(
      ([layer, title]) => `- ${title}: ${body.layers[layer as keyof typeof LAYER_TITLES]}`,
    ),
    '',
    '## Objects',
    '',
    ...body.objects.modified.map(
      (m) =>
        `- modified ${m.objectType}/${m.objectId}.${m.fieldId}: ${m.valueBefore}@${m.versionBefore} -> ${m.valueAfter}@${m.versionAfter}`,
    ),
    ...body.objects.preserved.map(
      (p) =>
        `- preserved ${p.objectType}/${p.objectId}.${p.fieldId}: ${p.value}@${p.objectVersion}`,
    ),
    ...body.objects.unresolved.map(
      (u) => `- UNRESOLVED ${u}: left as the snapshot holds it; not decided by this repair`,
    ),
    ...body.objects.affectedOnly.map((a) => `- affected only (not changed) ${a}`),
    '',
    '## Obligations',
    '',
    '| obligation | layer | status | rule | detail |',
    '| --- | --- | --- | --- | --- |',
    ...body.findings.map(
      (f) =>
        `| ${f.obligationRef} | ${f.layer} | ${f.status} | ${f.ruleVersion} | ${f.detail.replaceAll('|', '/')} |`,
    ),
    '',
  ];
  if (body.counterexamples.length > 0) {
    lines.push('## Counterexamples', '');
    for (const c of body.counterexamples) {
      lines.push(
        `- ${c.code} [${c.obligationRef}] objects: ${c.affectedDomain.objects.map((o) => `${o.objectType}/${o.objectId}`).join(', ') || '(whole)'}; expected: ${c.expected.condition}`,
      );
    }
    lines.push('');
  }
  lines.push('## Scope and limitations', '', `Applies to: ${body.scope.appliesTo}`, '');
  lines.push(...body.scope.limitations.map((l) => `- ${l}`), '');
  return lines.join('\n');
}
