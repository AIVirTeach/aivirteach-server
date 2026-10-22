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
  const parsed = LessonEnvelopeSchema.safeParse(lesson.content);
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
  const [assets, setAssets] = useState(initialAssets);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [serverProblems, setServerProblems] = useState<
    LessonSaveResult['problems'] | null
  >(null);
  const [formDirty, setFormDirty] = useState<Record<string, boolean>>({});
  const [pendingUploads, setPendingUploads] = useState(0);
  const [blockType, setBlockType] = useState<BlockType>('paragraph');
  const queue = useRef<ReturnType<
    typeof createAutosave<LessonBlock[], LessonSaveResult>
  > | null>(null);
  const previous = useRef(state.blocks);
  useEffect(() => {
    const saver = createAutosave<LessonBlock[], LessonSaveResult>(
      (blocks) =>
        courseMutation(slug, `draft/lessons/${lesson.contentId}`, 'PATCH', {
          content: { schemaVersion: 1, blocks },
        }),
      (status, result) => {
        setSaveStatus(status);
        if (result?.status === 'ok') {
          setServerProblems(result.data.problems);
          setSaveMessage('');
        } else if (result) setSaveMessage(resultMessage(result));
      },
    );
    queue.current = saver;
    return () => saver.dispose();
  }, [slug, lesson.contentId]);
  useEffect(() => {
    if (state.blocks !== previous.current) {
      previous.current = state.blocks;
      setServerProblems(null);
      queue.current?.edit(state.blocks);
    }
  }, [state.blocks]);
  const dirty =
    ['dirty', 'saving', 'failed'].includes(saveStatus) ||
    pendingUploads > 0 ||
    Object.values(formDirty).some(Boolean);
  useDepartureGuard(dirty);
  const localProblems = useMemo(
    () =>
      validateLessonContent(
        { schemaVersion: 1, blocks: state.blocks },
        { courseAssetIds: new Set(assets.map((a) => a.id)) },
      ),
    [state.blocks, assets],
  );
  const report = serverProblems ?? localProblems;
  const problems = [...report.errors, ...report.warnings];
  const selected = state.blocks.find((b) => b.id === state.selectedId);
  const payload = useMemo(
    () => ({
      type: 'lesson-preview',
      lesson: { title: lesson.title, moduleTitle, blocks: state.blocks },
      assets: Object.fromEntries(
        assets.map((a) => [a.id, { url: a.url, alt: a.altText ?? undefined }]),
      ),
      problems: [
        ...(serverProblems ?? localProblems).errors,
        ...(serverProblems ?? localProblems).warnings,
      ],
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
          {saveStatus === 'failed' && (
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
            {lesson.body && !parsed.success && (
              <p className="notice">
                这个课时原先使用
                Markdown。添加内容块并保存后，将使用内容块预览和发布。
              </p>
            )}
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
                disabled={state.blocks.length >= 300}
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
            {problems
              .filter((p) => !p.blockId)
              .map((p, i) => (
                <p className={p.level} key={i}>
                  {p.message}
                </p>
              ))}
            <div className="block-list">
              {state.blocks.map((b, i) => {
                const entry = Object.hasOwn(BLOCK_REGISTRY, b.type)
                  ? BLOCK_REGISTRY[b.type as BlockType]
                  : undefined;
                const own = problems.filter((p) => p.blockId === b.id);
                return (
                  <article
                    id={b.id}
                    key={b.id}
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
                    {own.map((p, index) => (
                      <p className={p.level} key={index}>
                        {p.message}
                      </p>
                    ))}
                    {selected?.id === b.id && (
                      <BlockForm
                        key={selected.id}
                        slug={slug}
                        block={selected}
                        assets={assets}
                        onAssets={(a) =>
                          setAssets((current) => [
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
