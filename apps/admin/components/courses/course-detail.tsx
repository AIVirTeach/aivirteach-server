'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CourseListItem,
  CourseDraftRead,
  PublishIssue,
} from '@aivirteach/admin-contract';
import { courseMutation } from '@/app/(app)/courses/actions';
import { resultMessage, settleAction } from '@/lib/action-result';
import { MutationForm, TextField, lines, text } from './mutation-form';
import { ModuleTree } from './module-tree';
import { useDepartureGuard } from '@/components/editor/use-departure-guard';
export function CourseDetail({
  course,
  draft,
}: {
  course: CourseListItem;
  draft: CourseDraftRead | null;
}) {
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const locked = busy || refreshing;
  const [message, setMessage] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [issues, setIssues] = useState<PublishIssue[]>([]);
  const router = useRouter();
  const unsaved = Object.values(dirty).some(Boolean);
  useDepartureGuard(unsaved || locked);
  const mark = (key: string) => (value: boolean) =>
    setDirty((d) => ({ ...d, [key]: value }));
  const meta: Record<string, unknown> = draft?.effectiveMeta ?? {};
  const value = (key: string, fallback = '') =>
    typeof meta[key] === 'string' ? (meta[key] as string) : fallback;
  const array = (key: string) =>
    Array.isArray(meta[key]) ? meta[key].join('\n') : '';
  async function mutate(path: string, method: 'POST' | 'DELETE') {
    if (unsaved || locked) return;
    if (
      path === 'publish' &&
      !window.confirm(
        '确认将当前草稿发布为课程新版本？',
      )
    )
      return;
    if (
      method === 'DELETE' &&
      !window.confirm('丢弃整个草稿？草稿中的未发布改动将无法恢复。')
    )
      return;
    setBusy(true);
    setMessage('');
    setProblems([]);
    setIssues([]);
    const result = await settleAction(
      courseMutation<{ version: number }>(course.slug, path, method),
    );
    setBusy(false);
    if (result.status === 'ok') {
      setMessage(
        path === 'publish'
          ? `版本 v${result.data.version} 已发布。`
          : method === 'DELETE'
            ? '草稿已丢弃'
            : '草稿已创建',
      );
      startRefresh(() => router.refresh());
    } else {
      setMessage(resultMessage(result));
      if (result.status === 'error') {
        setProblems(result.problems);
        setIssues(result.issues);
      }
    }
  }
  return (
    <main className="studio-page">
      <a className="breadcrumb" href="/courses">
        ← 全部课程
      </a>
      <div className="page-heading">
        <div>
          <p className="eyebrow">COURSE / {course.slug}</p>
          <h1>{course.title}</h1>
          <p className="muted">
            {course.latestPublishedVersion
              ? `已发布 v${course.latestPublishedVersion}`
              : '尚未发布'}{' '}
            · 当前 {course.activeEnrollments} 名在学学员
            {draft && ` · 草稿 v${draft.version}`}
          </p>
        </div>
        <div className="inline">
          {draft ? (
            <>
              <button
                disabled={unsaved || locked}
                onClick={() => void mutate('draft', 'DELETE')}
              >
                丢弃草稿
              </button>
              <button
                className="primary"
                disabled={unsaved || locked}
                onClick={() => void mutate('publish', 'POST')}
              >
                发布课程
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={locked}
              onClick={() => void mutate('draft', 'POST')}
            >
              创建草稿
            </button>
          )}
        </div>
      </div>
      {unsaved && (
        <p className="notice">请先保存所有表单，再发布或丢弃草稿。</p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
          {message.includes('登录已过期') && (
            <a href="/login" target="_blank" rel="noreferrer">
              重新登录
            </a>
          )}
        </p>
      )}
      {problems.length > 0 && (
        <section className="panel error" role="alert">
          <h2>发布前需要处理 {problems.length} 个问题</h2>
          <ol>
            {problems.map((p, i) => (
              <li key={i}>
                {p}
                {issues[i]?.contentId && (
                  <a
                    href={`/courses/${course.slug}/lessons/${issues[i].contentId}${issues[i].blockId ? `#${issues[i].blockId}` : ''}`}
                  >
                    {' '}
                    前往课时
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {draft ? (
        <fieldset className="course-layout" disabled={locked}>
          <section className="panel">
            <h2>课程信息</h2>
            <MutationForm
              key={JSON.stringify(meta)}
              slug={course.slug}
              path="draft"
              onDirty={mark('meta')}
              build={(f) => ({
                title: text(f, 'title'),
                shortTitle: text(f, 'shortTitle') || null,
                category: text(f, 'category'),
                description: text(f, 'description'),
                level: text(f, 'level'),
                language: text(f, 'language'),
                tags: lines(f, 'tags'),
                outcomes: lines(f, 'outcomes'),
                requirements: lines(f, 'requirements'),
              })}
            >
              <TextField
                name="title"
                label="课程名称"
                value={value('title', course.title)}
                required
              />
              <TextField
                name="shortTitle"
                label="简称"
                value={value('shortTitle')}
              />
              <TextField
                name="category"
                label="分类"
                value={value('category')}
              />
              <TextField
                name="description"
                label="课程简介"
                value={value('description')}
                multiline
              />
              <label className="field">
                难度
                <select name="level" defaultValue={value('level', 'Beginner')}>
                  <option value="Beginner">入门</option>
                  <option value="Intermediate">进阶</option>
                  <option value="Advanced">高级</option>
                </select>
              </label>
              <TextField
                name="language"
                label="授课语言"
                value={value('language', 'zh')}
                required
              />
              <TextField
                name="tags"
                label="标签，每行一项"
                value={array('tags')}
                multiline
              />
              <TextField
                name="outcomes"
                label="学习成果，每行一项"
                value={array('outcomes')}
                multiline
              />
              <TextField
                name="requirements"
                label="学习要求，每行一项"
                value={array('requirements')}
                multiline
              />
            </MutationForm>
          </section>
          <ModuleTree
            slug={course.slug}
            draft={draft}
            onDirty={mark}
            locked={locked || unsaved}
          />
        </fieldset>
      ) : (
        <section className="empty-state">
          <h2>当前没有草稿</h2>
          <p>创建草稿后即可继续编辑。已发布的版本会保留。</p>
        </section>
      )}
    </main>
  );
}
