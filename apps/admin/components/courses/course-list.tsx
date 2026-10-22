'use client';
import { PlusIcon, ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CourseListItem } from '@aivirteach/admin-contract';
import { createCourseAction } from '@/app/(app)/courses/actions';
import { resultMessage, settleAction } from '@/lib/action-result';
import { useDepartureGuard } from '@/components/editor/use-departure-guard';
export function CourseList({ courses }: { courses: CourseListItem[] }) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  useDepartureGuard(dirty || busy);
  return (
    <main id="main-content" tabIndex={-1} className="studio-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COURSE STUDIO</p>
          <h1>课程</h1>
          <p className="muted">管理课程内容、编辑草稿并发布新版本。</p>
        </div>
        <Button
          variant="default"
          onClick={() => setOpen(!open)}
          disabled={dirty || busy}
        >
          <PlusIcon aria-hidden="true" />
          新建课程
        </Button>
      </div>
      {open && (
        <section className="panel">
          <h2>新建课程</h2>
          <form
            onChange={() => setDirty(true)}
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const slug = String(f.get('slug'));
              setBusy(true);
              const result = await settleAction(
                createCourseAction({
                  slug,
                  title: String(f.get('title')),
                }),
              );
              setBusy(false);
              if (result.status === 'ok') {
                setDirty(false);
                router.push(`/courses/${encodeURIComponent(slug)}`);
              } else setError(resultMessage(result));
            }}
          >
            <fieldset disabled={busy}>
              <label className="field">
                课程名称
                <Input name="title" maxLength={120} required autoFocus />
              </label>
              <label className="field">
                课程标识
                <Input
                  name="slug"
                  minLength={3}
                  maxLength={60}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  required
                  placeholder="python-basics"
                />
                <small>使用小写字母、数字和短横线，创建后不能修改。</small>
              </label>
              <Button type="submit" variant="default">
                {busy ? '创建中…' : '创建课程'}
              </Button>
            </fieldset>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </form>
        </section>
      )}
      <div className="course-grid">
        {courses.map((c) => (
          <a
            className="course-card"
            href={`/courses/${encodeURIComponent(c.slug)}`}
            key={c.slug}
          >
            <div className="inline">
              <Badge variant="secondary">
                {c.hasDraft ? '有草稿' : c.published ? '已发布' : '未发布'}
              </Badge>
              <small>
                {c.latestPublishedVersion
                  ? `v${c.latestPublishedVersion}`
                  : '尚无版本'}
              </small>
            </div>
            <h2>{c.title}</h2>
            <p className="muted">{c.slug}</p>
            <div className="course-stats">
              <span>{c.lessonCount} 个课时</span>
              <span>{c.activeEnrollments} 名在学学员</span>
              <ArrowUpRightIcon
                aria-hidden="true"
                className="ml-auto size-4 text-primary"
              />
            </div>
          </a>
        ))}
      </div>
      {!courses.length && (
        <section className="empty-state">
          <h2>从第一门课程开始</h2>
          <p>创建课程后，你可以添加模块、编写课时内容并发布。</p>
        </section>
      )}
    </main>
  );
}
