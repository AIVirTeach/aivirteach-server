import { listCourses } from '@/lib/courses-api';
import { CourseList } from '@/components/courses/course-list';
export default async function CoursesPage() {
  return <CourseList courses={await listCourses()} />;
}
