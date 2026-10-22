'use client';
import type { DraftAssessment } from '@aivirteach/admin-contract';
import {
  MutationForm,
  TextField,
  lines,
  text,
} from '@/components/courses/mutation-form';
function Fields({ assessment }: { assessment?: DraftAssessment }) {
  return (
    <>
      <TextField
        name="type"
        label="测评类型"
        value={assessment?.type ?? 'knowledge'}
        required
      />
      <TextField
        name="question"
        label="题干"
        value={assessment?.question}
        required
        multiline
      />
      <TextField
        name="options"
        label="选项，每行一项"
        value={assessment?.options?.join('\n')}
        multiline
      />
      <TextField
        name="clientCriteria"
        label="客户端判定条件，每行一项"
        value={assessment?.clientCriteria?.join('\n')}
        multiline
      />
      <TextField
        name="expectedResult"
        label="预期结果"
        value={assessment?.expectedResult ?? ''}
        multiline
      />
      <TextField
        name="successCriteria"
        label="成功标准，每行一项"
        value={assessment?.successCriteria?.join('\n')}
        multiline
      />
      <TextField
        name="commonFailures"
        label="常见失败，每行一项"
        value={assessment?.commonFailures?.join('\n')}
        multiline
      />
    </>
  );
}
function build(f: FormData) {
  return {
    type: text(f, 'type'),
    question: text(f, 'question'),
    options: lines(f, 'options'),
    clientCriteria: lines(f, 'clientCriteria'),
    expectedResult: text(f, 'expectedResult') || null,
    successCriteria: lines(f, 'successCriteria'),
    commonFailures: lines(f, 'commonFailures'),
  };
}
export function AssessmentPanel({
  slug,
  contentId,
  assessments,
  onDirty,
}: {
  slug: string;
  contentId: string;
  assessments: DraftAssessment[];
  onDirty: (id: string, dirty: boolean) => void;
}) {
  return (
    <section className="panel">
      <h2>课时测评</h2>
      {assessments.map((a, i) => (
        <details key={a.id}>
          <summary>
            测评 {i + 1} · {a.question || a.type}
          </summary>
          <MutationForm
            slug={slug}
            path={`draft/assessments/${a.id}`}
            build={build}
            onDirty={(dirty) => onDirty(a.id, dirty)}
          >
            <Fields assessment={a} />
          </MutationForm>
        </details>
      ))}
      <details>
        <summary>＋ 添加测评</summary>
        <MutationForm
          slug={slug}
          path={`draft/lessons/${contentId}/assessments`}
          method="POST"
          label="创建测评"
          build={build}
          onDirty={(dirty) => onDirty('new-assessment', dirty)}
        >
          <Fields />
        </MutationForm>
      </details>
    </section>
  );
}
