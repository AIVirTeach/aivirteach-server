'use client';
import { ArrowUpIcon, ArrowDownIcon } from 'lucide-react';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  BLOCK_REGISTRY,
  BLOCK_TYPES,
  LessonEnvelopeSchema,
  validateLessonContent,
  type BlockType,
  type LessonBlock,
} from '@aivirteach/lesson-blocks';
import type {
  CourseAsset,
  DraftLesson,
  DraftVersion,
  LessonSaveResult,
} from '@aivirteach/admin-contract';
import { courseMutation } from '@/app/(app)/courses/actions';
import { resultMessage } from '@/lib/action-result';
import { reduce, type EditorState, type EditorAction } from './editor-state';
import { createAutosave, type SaveStatus } from './autosave';
import type { LocatedProblem, ContentProblem } from './field-location';
import { blockSummary } from './block-summary';
import { BlockForm } from './block-form';
import { PreviewFrame } from './preview-frame';
import { AssessmentPanel } from './assessment-panel';
import { useDepartureGuard } from './use-departure-guard';
import { MutationForm } from '@/components/courses/mutation-form';
import { LessonFields, lessonBody } from '@/components/courses/module-tree';
export function LessonEditor({
  slug,
  draft,
  lesson,
  moduleTitle,
  initialAssets,
}: {
  slug: string;
  draft: DraftVersion;
  lesson: DraftLesson;
  moduleTitle: string;
  initialAssets: CourseAsset[];
}) {
  const [initialContent] = useState(() => lesson.content);
  const [parsed] = useState(() =>
    LessonEnvelopeSchema.safeParse(initialContent),
  );
  const [state, dispatch] = useReducer(
    (s: EditorState, a: EditorAction) => reduce(s, a),
    {
      blocks: parsed.success ? parsed.data.blocks : [],
      selectedId: null,
      past: [],
      future: [],
      uploads: {},
    } satisfies EditorState,
  );
  const [pendingAssets, setPendingAssets] = useState<CourseAsset[]>([]);
  useEffect(() => {
    const confirmedIds = new Set(initialAssets.map((asset) => asset.id));
    setPendingAssets((current) => {
      const pending = current.filter((asset) => !confirmedIds.has(asset.id));
      return pending.length === current.length ? current : pending;
    });
  }, [initialAssets, pendingAssets]);
  const assets = useMemo(
    () => [
      ...new Map(
        [...pendingAssets, ...initialAssets].map((asset) => [asset.id, asset]),
      ).values(),
    ],
    [initialAssets, pendingAssets],
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [serverProblems, setServerProblems] = useState<{
    revision: number;
    report: LessonSaveResult['problems'];
  } | null>(null);
  const revision = useRef(0);
  const initial = useRef(true);
  const assetIdsKey = JSON.stringify(
    [...new Set(assets.map((asset) => asset.id))].sort(),
  );
  const previousSnapshot = useRef({ blocks: state.blocks, assetIdsKey });
  const [focusTarget, setFocusTarget] = useState<{
    revision: number;
    problem: ContentProblem;
  } | null>(null);
  const problemSummary = useRef<HTMLElement>(null);
  const blockList = useRef<HTMLDivElement>(null);
  const [formDirty, setFormDirty] = useState<Record<string, boolean>>({});
  const [pendingUploads, setPendingUploads] = useState(0);
  const [blockType, setBlockType] = useState<BlockType>('paragraph');
  const queue = useRef<ReturnType<
    typeof createAutosave<LessonBlock[], LessonSaveResult>
  > | null>(null);
  const localProblems = useMemo(
    () =>
      validateLessonContent(
        parsed.success
          ? { schemaVersion: 1, blocks: state.blocks }
          : initialContent,
        { courseAssetIds: new Set(assets.map((asset) => asset.id)) },
      ),
    [state.blocks, assets, parsed, initialContent],
  );
  useEffect(() => {
    const saver = createAutosave<LessonBlock[], LessonSaveResult>(
      (blocks) =>
        courseMutation(slug, `draft/lessons/${lesson.contentId}`, 'PATCH', {
          content: { schemaVersion: 1, blocks },
        }),
      (notice) => {
        if (notice.revision !== revision.current) return;
        setSaveStatus(notice.status);
        if (notice.status === 'saved') {
          setServerProblems({
            revision: notice.revision,
            report: notice.result.data.problems,
          });
          setSaveMessage('');
        } else if (notice.status === 'failed') {
          const result = notice.result;
          if (result.status === 'error' && result.validation) {
            setServerProblems({
              revision: notice.revision,
              report: result.validation,
            });
          }
          setSaveMessage(resultMessage(result));
        } else setSaveMessage('');
      },
    );
    queue.current = saver;
    return () => saver.dispose();
  }, [slug, lesson.contentId]);
  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      if (parsed.success && !localProblems.errors.length) return;
    } else if (
      previousSnapshot.current.blocks === state.blocks &&
      previousSnapshot.current.assetIdsKey === assetIdsKey
    )
      return;
    previousSnapshot.current = { blocks: state.blocks, assetIdsKey };
    const currentRevision = ++revision.current;
    setServerProblems(null);
    setFocusTarget(null);
    const candidate =
      !parsed.success || localProblems.errors.length
        ? {
            kind: 'blocked' as const,
            revision: currentRevision,
            report: localProblems,
          }
        : {
            kind: 'ready' as const,
            revision: currentRevision,
            value: state.blocks,
            report: localProblems,
          };
    queue.current?.stage(candidate);
  }, [state.blocks, localProblems, parsed, assetIdsKey]);
  const dirty =
    ['blocked', 'dirty', 'saving', 'failed'].includes(saveStatus) ||
    pendingUploads > 0 ||
    Object.values(formDirty).some(Boolean);
  useDepartureGuard(dirty);
  const report =
    serverProblems?.revision === revision.current
      ? serverProblems.report
      : localProblems;
  const duplicateIds = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const block of state.blocks) {
      if (seen.has(block.id)) duplicates.add(block.id);
      seen.add(block.id);
    }
    return duplicates;
  }, [state.blocks]);
  const problems: LocatedProblem[] = [...report.errors, ...report.warnings].map(
    (problem, index) => ({
      ...problem,
      elementId: `content-problem-${revision.current}-${index}`,
    }),
  );
  useEffect(() => {
    if (!focusTarget || focusTarget.revision !== revision.current) return;
    const { problem } = focusTarget;
    if (
      problem.blockIndex === undefined ||
      duplicateIds.has(state.blocks[problem.blockIndex]?.id)
    ) {
      problemSummary.current?.focus();
      return;
    }
    const card = blockList.current?.querySelector<HTMLElement>(
      `[data-block-index="${problem.blockIndex}"]`,
    );
    const field =
      problem.fieldPath &&
      Array.from(
        card?.querySelectorAll<HTMLElement>('[data-field-path]') ?? [],
      ).find(
        (element) =>
          element.dataset.fieldPath === JSON.stringify(problem.fieldPath),
      );
    const target = field ?? card;
    target?.scrollIntoView?.({ block: 'nearest' });
    target?.focus();
  }, [focusTarget, state.selectedId, state.blocks, duplicateIds]);
  const selected = state.blocks.find((b) => b.id === state.selectedId);
  const payload = useMemo(
    () => ({
      type: 'lesson-preview',
      lesson: { title: lesson.title, moduleTitle, blocks: state.blocks },
      assets: Object.fromEntries(
        assets.map((a) => [a.id, { url: a.url, alt: a.altText ?? undefined }]),
      ),
      problems: [...report.errors, ...report.warnings],
    }),
    [
      lesson.title,
      moduleTitle,
      state.blocks,
      assets,
      serverProblems,
      localProblems,
    ],
  );
  const statuses: Record<SaveStatus, string> = {
    idle: '尚无改动',
    blocked: `有 ${report.errors.length} 处问题，尚未保存`,
    dirty: '等待保存…',
    saving: '保存中…',
    saved: '已保存',
    failed: '保存失败',
  };
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) dispatch({ type: 'select', id });
  }, []);
  return (
    <main id="main-content" tabIndex={-1} className="editor-page">
      <div className="editor-toolbar">
        <div>
          <a className="breadcrumb" href={`/courses/${slug}`}>
            ← 返回课程
          </a>
          <h1>{lesson.title}</h1>
          <small className="muted">
            {moduleTitle} · 草稿 v{draft.version}
          </small>
        </div>
        <div className="save-controls">
          <span
            role="status"
            className={saveStatus === 'failed' ? 'error' : ''}
          >
            {statuses[saveStatus]}
          </span>
          {saveStatus === 'failed' && !serverProblems?.report.errors.length && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void queue.current?.retry()}
            >
              重试保存
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!state.past.length}
            onClick={() => dispatch({ type: 'undo' })}
          >
            撤销
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!state.future.length}
            onClick={() => dispatch({ type: 'redo' })}
          >
            重做
          </Button>
        </div>
      </div>
      {saveMessage && (
        <p role="alert" className="notice error">
          {saveMessage}
          {saveMessage.includes('登录已过期') && (
            <a href="/login" target="_blank" rel="noreferrer">
              {' '}
              在新标签页重新登录
            </a>
          )}
        </p>
      )}
      {!parsed.success && (
        <p role="alert" className="notice error">
          课时初始正文格式无效，已阻止自动保存。请重新加载或联系维护人员。
        </p>
      )}
      {!!problems.length && (
        <section
          ref={problemSummary}
          tabIndex={-1}
          aria-label="课时内容问题"
          className="panel"
        >
          <h2>课时内容问题</h2>
          <ul>
            {problems.map((problem) => (
              <li key={problem.elementId}>
                <button
                  type="button"
                  id={problem.elementId}
                  className={problem.level}
                  onClick={() => {
                    if (
                      problem.blockIndex !== undefined &&
                      !duplicateIds.has(state.blocks[problem.blockIndex]?.id)
                    ) {
                      const block = state.blocks[problem.blockIndex];
                      if (block) dispatch({ type: 'select', id: block.id });
                    }
                    setFocusTarget({ revision: revision.current, problem });
                  }}
                >
                  {problem.blockIndex === undefined
                    ? ''
                    : `第 ${problem.blockIndex + 1} 块：`}
                  {problem.message}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="editor-layout">
        <aside className="lesson-nav">
          <h2>课程目录</h2>
          {draft.modules.map((m) => (
            <div key={m.id}>
              <h3>{m.title}</h3>
              {m.lessons.map((l) => (
                <a
                  key={l.id}
                  aria-current={
                    l.contentId === lesson.contentId ? 'page' : undefined
                  }
                  href={`/courses/${slug}/lessons/${l.contentId}`}
                >
                  {l.title}
                </a>
              ))}
            </div>
          ))}
        </aside>
        <div className="editor-content">
          <section className="panel">
            <div className="section-heading">
              <h2>课时内容</h2>
              <small>{state.blocks.length} / 300 块</small>
            </div>
            <div className="add-block">
              <label className="field">
                内容类型
                <NativeSelect
                  value={blockType}
                  onChange={(e) => setBlockType(e.target.value as BlockType)}
                >
                  {BLOCK_TYPES.map((type) => (
                    <NativeSelectOption key={type} value={type}>
                      {BLOCK_REGISTRY[type].label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button
                variant="default"
                disabled={!parsed.success || state.blocks.length >= 300}
                onClick={() => dispatch({ type: 'add', blockType })}
              >
                添加内容
              </Button>
            </div>
            {state.blocks.length >= 300 && <p>已达到 300 个块上限</p>}
            {!state.blocks.length && (
              <div className="empty-state">
                <p>添加第一个内容块，开始编写课时。</p>
              </div>
            )}
            <div className="block-list" ref={blockList}>
              {state.blocks.map((b, i) => {
                const entry = Object.hasOwn(BLOCK_REGISTRY, b.type)
                  ? BLOCK_REGISTRY[b.type as BlockType]
                  : undefined;
                const own = problems.filter(
                  (problem) => problem.blockIndex === i,
                );
                return (
                  <article
                    id={b.id}
                    key={`${b.id}-${i}`}
                    data-block-index={i}
                    tabIndex={-1}
                    className={`block-card ${state.selectedId === b.id ? 'selected' : ''}`}
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      aria-pressed={state.selectedId === b.id}
                      className="block-select h-auto w-full flex-wrap justify-start gap-2 rounded-none border-0 bg-transparent p-0 text-left whitespace-normal shadow-none hover:bg-transparent"
                      onClick={() => dispatch({ type: 'select', id: b.id })}
                    >
                      <span className="block-index">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <strong>{entry?.label ?? b.type}</strong>
                      <span className="block-summary">{blockSummary(b)}</span>
                    </Button>
                    <div className="block-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dispatch({ type: 'select', id: b.id })}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={state.blocks.length >= 300}
                        onClick={() =>
                          dispatch({ type: 'duplicate', id: b.id })
                        }
                      >
                        复制
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={i === 0}
                        aria-label={`第${i + 1}块上移`}
                        onClick={() =>
                          dispatch({ type: 'move', id: b.id, direction: -1 })
                        }
                      >
                        <ArrowUpIcon aria-hidden="true" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={i === state.blocks.length - 1}
                        aria-label={`第${i + 1}块下移`}
                        onClick={() =>
                          dispatch({ type: 'move', id: b.id, direction: 1 })
                        }
                      >
                        <ArrowDownIcon aria-hidden="true" />
                      </Button>
                      <ConfirmAction
                        title="删除内容块？"
                        description="删除后可以使用撤销恢复。"
                        onConfirm={() => dispatch({ type: 'remove', id: b.id })}
                      >
                        <Button variant="ghost" className="text-destructive">
                          删除
                        </Button>
                      </ConfirmAction>
                    </div>
                    {selected?.id === b.id && (
                      <BlockForm
                        key={selected.id}
                        problems={own}
                        slug={slug}
                        block={selected}
                        assets={assets}
                        onAssets={(a) =>
                          setPendingAssets((current) => [
                            ...current.filter((x) => x.id !== a.id),
                            a,
                          ])
                        }
                        onBusy={(busy) =>
                          setPendingUploads((count) => count + (busy ? 1 : -1))
                        }
                        onUploadStart={(requestId) =>
                          dispatch({
                            type: 'start-upload',
                            id: selected.id,
                            requestId,
                          })
                        }
                        onUploadFinish={(requestId, assetId) =>
                          dispatch({
                            type: 'finish-upload',
                            id: selected.id,
                            requestId,
                            assetId,
                          })
                        }
                        onPatch={(props) =>
                          dispatch({ type: 'patch', id: selected.id, props })
                        }
                        onChange={(props) =>
                          dispatch({ type: 'update', id: selected.id, props })
                        }
                      />
                    )}
                  </article>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <details>
              <summary>课时信息与活动</summary>
              <MutationForm
                slug={slug}
                path={`draft/lessons/${lesson.contentId}`}
                build={lessonBody}
                onDirty={(value) =>
                  setFormDirty((d) => ({ ...d, lesson: value }))
                }
              >
                <LessonFields lesson={lesson} />
              </MutationForm>
            </details>
          </section>
          <AssessmentPanel
            slug={slug}
            contentId={lesson.contentId}
            assessments={lesson.assessments}
            onDirty={(id, value) =>
              setFormDirty((d) => ({ ...d, [id]: value }))
            }
          />
        </div>
        <PreviewFrame payload={payload} />
      </div>
    </main>
  );
}
