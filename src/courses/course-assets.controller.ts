import { Controller, Get, Param, Redirect } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CoursesService } from './courses.service';

// 故意不加 JwtAuthGuard：这个路由是给 <img src> 直接用的，浏览器加载图片不会带 Authorization
// header。数据面的保护在 CoursesService.getAssetUrl 里——只有已发布课程的素材才会给 URL。
@ApiTags('Courses')
@Controller('courses')
export class CourseAssetsController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get(':slug/assets/:assetId')
  @Redirect()
  async asset(
    @Param('slug') slug: string,
    @Param('assetId') assetId: string,
  ): Promise<{ url: string }> {
    const url = await this.coursesService.getAssetUrl(slug, assetId);
    return { url };
  }
}
