import { Test } from '@nestjs/testing';
import { CourseAssetsController } from './course-assets.controller';
import { CoursesService } from './courses.service';

describe('CourseAssetsController', () => {
  it('GET /courses/:slug/assets/:assetId 重定向到 service 返回的 URL，且不挂鉴权守卫', async () => {
    const service = {
      getAssetUrl: jest
        .fn()
        .mockResolvedValue(
          'https://blob.vercel-storage.com/courses/sample/cover.png',
        ),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CourseAssetsController],
      providers: [{ provide: CoursesService, useValue: service }],
    }).compile();
    const controller = moduleRef.get(CourseAssetsController);

    const result = await controller.asset('sample', 'asset_1');

    expect(service.getAssetUrl).toHaveBeenCalledWith('sample', 'asset_1');
    expect(result).toEqual({
      url: 'https://blob.vercel-storage.com/courses/sample/cover.png',
    });
  });
});
