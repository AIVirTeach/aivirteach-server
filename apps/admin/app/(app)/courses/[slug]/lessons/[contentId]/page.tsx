import { notFound, redirect } from 'next/navigation';
import { getDraft, listAssets, listCourses } from '@/lib/courses-api';
import { LessonEditor } from '@/components/editor/lesson-editor';
export default async function LessonPage({
  params,
}: {
  params: Promise<{ slug: string; contentId: string }>;
}) {
  const { slug, contentId } = await params;
  const course = (await listCourses()).find((c) => c.slug === slug);
  if (!course) notFound();
  if (!course.hasDraft) redirect(`/courses/${encodeURIComponent(slug)}`);
  const [draft, assets] = await Promise.all([getDraft(slug), listAssets(slug)]);
  const module = draft.modules.find((m) =>
    m.lessons.some((l) => l.contentId === contentId),
  );
  const lesson = module?.lessons.find((l) => l.contentId === contentId);
  if (!module || !lesson) notFound();
  return (
    <LessonEditor
      key={`${draft.id}-${contentId}`}
      slug={slug}
      draft={draft}
      lesson={lesson}
      moduleTitle={module.title}
      initialAssets={assets}
    />
  );
}
