export function apiBaseUrl(): string {
  const base = process.env.API_BASE_URL;
  if (!base) throw new Error('API_BASE_URL 未配置');
  return base;
}
