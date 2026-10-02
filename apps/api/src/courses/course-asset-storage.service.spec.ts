import { join } from 'node:path';
import { put } from '@vercel/blob';
import { CourseAssetStorageService } from './course-asset-storage.service';

jest.mock('@vercel/blob', () => ({
  put: jest.fn(),
}));

const FIXTURE_FILE = join(
  __dirname,
  '__fixtures__',
  'sample-course',
  'cover.png',
);

describe('CourseAssetStorageService.upload', () => {
  it('读本地文件，上传到公开可读的 Blob 存储，返回其 URL', async () => {
    (put as jest.Mock).mockResolvedValue({
      url: 'https://blob.vercel-storage.com/courses/sample-course/cover.png',
    });
    const service = new CourseAssetStorageService();

    const url = await service.upload(
      'courses/sample-course/cover.png',
      FIXTURE_FILE,
    );

    expect(put).toHaveBeenCalledWith(
      'courses/sample-course/cover.png',
      expect.any(Buffer),
      { access: 'public' },
    );
    expect(url).toBe(
      'https://blob.vercel-storage.com/courses/sample-course/cover.png',
    );
  });

  it('uploads a buffer using the supplied content type', async () => {
    (put as jest.Mock).mockResolvedValue({
      url: 'https://blob.test/image.png',
    });
    const service = new CourseAssetStorageService();
    const body = Buffer.from('png');
    await expect(
      service.uploadBuffer('courses/c1/a.png', body, 'image/png'),
    ).resolves.toBe('https://blob.test/image.png');
    expect(put).toHaveBeenCalledWith('courses/c1/a.png', body, {
      access: 'public',
      contentType: 'image/png',
      addRandomSuffix: true,
    });
  });
});
