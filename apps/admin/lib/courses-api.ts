import { z } from 'zod';
import {
  CourseListItemSchema,
  CourseAssetSchema,
  CourseDraftReadSchema,
} from '@aivirteach/admin-contract';
import { apiFetch } from './api-client';
async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`读取课程失败（${response.status}）`);
  return schema.parse(await response.json());
}
export const listCourses = () =>
  read('/admin/courses', z.array(CourseListItemSchema));
export const getDraft = (slug: string) =>
  read(
    `/admin/courses/${encodeURIComponent(slug)}/draft`,
    CourseDraftReadSchema,
  );
export const listAssets = (slug: string) =>
  read(
    `/admin/courses/${encodeURIComponent(slug)}/assets`,
    z.array(CourseAssetSchema),
  );
