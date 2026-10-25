'use server';
import { z } from 'zod';
import { apiFetchNoRedirect } from '@/lib/api-client';
import type { ActionResult } from '@/lib/action-result';
import {
  PublishIssueSchema,
  ValidationReportSchema,
} from '@aivirteach/admin-contract';

const ErrorSchema = z.object({
  message: z.union([z.string(), z.array(z.string())]).optional(),
  problems: z.array(z.string()).optional(),
  issues: z.array(PublishIssueSchema).optional(),
  validation: ValidationReportSchema.optional(),
});
export async function courseMutation<T = unknown>(
  slug: string,
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<ActionResult<T>> {
  if (
    !/^[a-z0-9-]+$/.test(slug) ||
    !/^(draft(?:\/(?:modules|lessons|assessments)\/[a-zA-Z0-9_-]+(?:\/(?:lessons|assessments))?|\/modules|\/order)?|publish)$/.test(
      path,
    )
  )
    return {
      status: 'error',
      message: '无效的课程操作',
      problems: [],
      issues: [],
    };
  return request<T>(`/admin/courses/${encodeURIComponent(slug)}/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export async function createCourseAction(input: {
  slug: string;
  title: string;
}): Promise<ActionResult<unknown>> {
  return request('/admin/courses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
export async function uploadAssetAction(
  slug: string,
  form: FormData,
): Promise<
  ActionResult<{
    id: string;
    url: string;
    altText: string | null;
    mimeType: string;
    createdAt: string;
  }>
> {
  return request(`/admin/courses/${encodeURIComponent(slug)}/assets`, {
    method: 'POST',
    body: form,
  });
}
async function request<T>(
  path: string,
  init: RequestInit,
): Promise<ActionResult<T>> {
  try {
    const response = await apiFetchNoRedirect(path, init);
    if (response.status === 401) return { status: 'unauthorized' };
    const data: unknown =
      response.status === 204 ? null : await response.json();
    if (response.ok) return { status: 'ok', data: data as T };
    const parsed = ErrorSchema.safeParse(data);
    const error = parsed.success ? parsed.data : {};
    return {
      status: 'error',
      message: Array.isArray(error.message)
        ? error.message.join('；')
        : (error.message ?? `请求失败（${response.status}）`),
      problems: error.problems ?? [],
      issues: error.issues ?? [],
      ...(error.validation ? { validation: error.validation } : {}),
    };
  } catch {
    return {
      status: 'error',
      message: '网络请求失败，本地改动已保留，请重试',
      problems: [],
      issues: [],
    };
  }
}
