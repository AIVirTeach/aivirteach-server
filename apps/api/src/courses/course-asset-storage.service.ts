import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { put } from '@vercel/blob';

@Injectable()
export class CourseAssetStorageService {
  async upload(pathname: string, filePath: string): Promise<string> {
    const body = await readFile(filePath);
    return this.uploadBuffer(pathname, body, 'application/octet-stream');
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
}
