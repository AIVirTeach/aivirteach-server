import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { del, put } from '@vercel/blob';

@Injectable()
export class CourseAssetStorageService {
  async upload(pathname: string, filePath: string): Promise<string> {
    const body = await readFile(filePath);
    // CLI 摄取靠 URL basename 把 Markdown 图片文件名对回素材，所以这里不能加随机后缀；
    // Content-Type 交给 Blob 按扩展名推断。
    const blob = await put(pathname, body, { access: 'public' });
    return blob.url;
  }

  async uploadBuffer(
    pathname: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    const blob = await put(pathname, body, {
      access: 'public',
      contentType,
      addRandomSuffix: true,
    });
    return blob.url;
  }

  async delete(url: string): Promise<void> {
    await del(url);
  }
}
