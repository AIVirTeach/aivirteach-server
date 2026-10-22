import { notFound } from 'next/navigation';
import { getDraft, listCourses } from '@/lib/courses-api';
import { CourseDetail } from '@/components/courses/course-detail';
export default async function CoursePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const course = (await listCourses()).find((c) => c.slug === slug);
  if (!course) notFound();
  const draft = course.hasDraft ? await getDraft(slug) : null;
  return <CourseDetail course={course} draft={draft} />;
}
