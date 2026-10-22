'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DraftVersion, DraftLesson } from '@aivirteach/admin-contract';
import { courseMutation } from '@/app/(app)/courses/actions';
import { resultMessage, settleAction } from '@/lib/action-result';
import { MutationForm, TextField, lines, text } from './mutation-form';
export function LessonFields({ lesson }: { lesson?: DraftLesson }) {
  return (
    <>
      <TextField name="title" label="课时名称" value={lesson?.title} required />
      {!lesson && (
        <label className="field">
          课时标识
          <input
            name="contentId"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            required
            placeholder="first-lesson"
          />
        </label>
      )}
      <TextField
        name="estimatedMinutes"
        label="预计分钟"
        type="number"
        value={lesson?.estimatedMinutes ?? 10}
        required
      />
      <TextField
        name="objectives"
        label="学习目标，每行一项"
        value={lesson?.objectives.join('\n')}
        multiline
      />
      <TextField
        name="activityType"
        label="活动类型"
        value={lesson?.activityType ?? 'practice'}
        required
      />
      <TextField
        name="activityPrompt"
        label="活动说明"
        value={lesson?.activityPrompt}
        multiline
      />
      <TextField
        name="completionType"
        label="完成方式"
        value={lesson?.activityCompletionType ?? 'manual'}
        required
      />
    </>
  );
}
export function lessonBody(f: FormData) {
  return {
    title: text(f, 'title'),
    estimatedMinutes: Number(f.get('estimatedMinutes')),
    objectives: lines(f, 'objectives'),
    activity: {
      type: text(f, 'activityType'),
      prompt: text(f, 'activityPrompt'),
      completionType: text(f, 'completionType'),
    },
  };
}
export function ModuleTree({
  slug,
  draft,
  onDirty,
  locked,
}: {
  slug: string;
  draft: DraftVersion;
  onDirty: (key: string) => (dirty: boolean) => void;
  locked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function mutation(
    path: string,
    method: 'PUT' | 'DELETE',
    body?: unknown,
  ) {
    if (
      method === 'DELETE' &&
      !window.confirm('确认删除？该模块或课时的草稿内容将无法恢复。')
    )
      return;
    setBusy(true);
    onDirty('tree-operation')(true);
    const result = await settleAction(courseMutation(slug, path, method, body));
    setBusy(false);
    onDirty('tree-operation')(false);
    if (result.status === 'ok') router.refresh();
    else setMessage(resultMessage(result));
  }
  function reorder(
    moduleIndex: number,
    direction: -1 | 1,
    lessonIndex?: number,
  ) {
    const modules = draft.modules.map((m) => ({
      id: m.id,
      lessons: m.lessons.map((l) => l.contentId),
    }));
    if (lessonIndex === undefined)
      [modules[moduleIndex], modules[moduleIndex + direction]] = [
        modules[moduleIndex + direction],
        modules[moduleIndex],
      ];
    else {
      const ids = modules[moduleIndex].lessons;
      [ids[lessonIndex], ids[lessonIndex + direction]] = [
        ids[lessonIndex + direction],
        ids[lessonIndex],
      ];
    }
    void mutation('draft/order', 'PUT', { modules });
  }
  return (
    <fieldset className="panel module-tree" disabled={busy}>
      <h2>模块与课时</h2>
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
      {draft.modules.map((m, mi) => (
        <section className="module" key={m.id} id={`module-${m.id}`}>
          <div className="section-heading">
            <h3>
              <span className="module-number">
                {String(mi + 1).padStart(2, '0')}
              </span>{' '}
              {m.title}
            </h3>
            <div className="inline">
              <button
                disabled={locked || busy || mi === 0}
                onClick={() => reorder(mi, -1)}
                aria-label={`${m.title}模块上移`}
              >
                ↑
              </button>
              <button
                disabled={locked || busy || mi === draft.modules.length - 1}
                onClick={() => reorder(mi, 1)}
                aria-label={`${m.title}模块下移`}
              >
                ↓
              </button>
              <button
                disabled={locked || busy}
                onClick={() => void mutation(`draft/modules/${m.id}`, 'DELETE')}
              >
                删除模块
              </button>
            </div>
          </div>
          <details>
            <summary>编辑模块信息</summary>
            <MutationForm
              key={`${m.title}-${m.description}-${m.estimatedMinutes}`}
              slug={slug}
              path={`draft/modules/${m.id}`}
              onDirty={onDirty(m.id)}
              build={(f) => ({
                title: text(f, 'title'),
                description: text(f, 'description'),
                estimatedMinutes: Number(f.get('estimatedMinutes')),
              })}
            >
              <TextField
                name="title"
                label="模块名称"
                value={m.title}
                required
              />
              <TextField
                name="description"
                label="模块说明"
                value={m.description}
                multiline
              />
              <TextField
                name="estimatedMinutes"
                label="模块预计分钟"
                type="number"
                value={m.estimatedMinutes}
                required
              />
            </MutationForm>
          </details>
          <ol className="lesson-list">
            {m.lessons.map((l, li) => (
              <li key={l.id}>
                <a href={`/courses/${slug}/lessons/${l.contentId}`}>
                  <span>
                    {mi + 1}.{li + 1}
                  </span>
                  <strong>{l.title}</strong>
                  <small>{l.estimatedMinutes} 分钟</small>
                </a>
                <div className="inline">
                  <button
                    disabled={locked || busy || li === 0}
                    aria-label={`${l.title}课时上移`}
                    onClick={() => reorder(mi, -1, li)}
                  >
                    ↑
                  </button>
                  <button
                    disabled={locked || busy || li === m.lessons.length - 1}
                    aria-label={`${l.title}课时下移`}
                    onClick={() => reorder(mi, 1, li)}
                  >
                    ↓
                  </button>
                  <button
                    disabled={locked || busy}
                    onClick={() =>
                      void mutation(`draft/lessons/${l.contentId}`, 'DELETE')
                    }
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <details>
            <summary>＋ 添加课时</summary>
            <MutationForm
              slug={slug}
              path={`draft/modules/${m.id}/lessons`}
              method="POST"
              label="创建课时"
              onDirty={onDirty(`new-${m.id}`)}
              build={(f) => ({
                ...lessonBody(f),
                contentId: text(f, 'contentId'),
                content: { schemaVersion: 1, blocks: [] },
              })}
            >
              <LessonFields />
            </MutationForm>
          </details>
        </section>
      ))}
      <details open={!draft.modules.length}>
        <summary>＋ 添加模块</summary>
        <MutationForm
          slug={slug}
          path="draft/modules"
          method="POST"
          label="创建模块"
          onDirty={onDirty('new-module')}
          build={(f) => ({
            title: text(f, 'title'),
            description: text(f, 'description'),
            estimatedMinutes: Number(f.get('estimatedMinutes')),
          })}
        >
          <TextField name="title" label="模块名称" required />
          <TextField name="description" label="模块说明" multiline />
          <TextField
            name="estimatedMinutes"
            label="模块预计分钟"
            type="number"
            value={30}
            required
          />
        </MutationForm>
      </details>
    </fieldset>
  );
}
