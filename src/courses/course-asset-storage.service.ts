import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { put } from '@vercel/blob';

@Injectable()
export class CourseAssetStorageService {
  async upload(pathname: string, filePath: string): Promise<string> {
    const body = await readFile(filePath);
    const blob = await put(pathname, body, { access: 'public' });
    return blob.url;
  }
}
