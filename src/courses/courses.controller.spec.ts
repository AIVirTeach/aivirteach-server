import { Test } from '@nestjs/testing';
import { ENV } from '../config/env';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';

// @UseGuards(JwtAuthGuard) 在类上声明后，Nest 会把它自动接入模块的 provider 图谱并按真实
// 构造函数实例化（需要 ENV token）；这里只测试 controller 方法委托、不会真的触发守卫的
// canActivate，所以给 ENV 一个占位桩，让 JwtAuthGuard 能正常构造即可。
const JWT_AUTH_GUARD_STUB = { provide: ENV, useValue: { JWT_SECRET: 'test-secret' } };

describe('CoursesController', () => {
  it('GET /courses 委托给 service.listPublished', async () => {
    const service = { listPublished: jest.fn().mockResolvedValue([{ id: 'sample' }]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.list()).resolves.toEqual([{ id: 'sample' }]);
    expect(service.listPublished).toHaveBeenCalled();
  });

  it('GET /courses/:slug 委托给 service.getDetail', async () => {
    const service = { getDetail: jest.fn().mockResolvedValue({ id: 'sample' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.detail('sample')).resolves.toEqual({ id: 'sample' });
    expect(service.getDetail).toHaveBeenCalledWith('sample');
  });

  it('GET /courses/:slug/welcome 委托给 service.getWelcome', async () => {
    const service = { getWelcome: jest.fn().mockResolvedValue({ overviewHeading: 'hi' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.welcome('sample')).resolves.toEqual({ overviewHeading: 'hi' });
    expect(service.getWelcome).toHaveBeenCalledWith('sample');
  });

  it('GET /courses/:slug/lessons/:lessonId 委托给 service.getLesson', async () => {
    const service = { getLesson: jest.fn().mockResolvedValue({ markdown: 'body' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [{ provide: CoursesService, useValue: service }, JWT_AUTH_GUARD_STUB],
    }).compile();
    const controller = moduleRef.get(CoursesController);

    await expect(controller.lesson('sample', 'lesson_1')).resolves.toEqual({ markdown: 'body' });
    expect(service.getLesson).toHaveBeenCalledWith('sample', 'lesson_1');
  });
});
