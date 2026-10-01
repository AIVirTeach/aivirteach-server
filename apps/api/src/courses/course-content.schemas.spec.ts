import { CourseContentSchema, mapCourseLevel } from './course-content.schemas';
import sampleCourse from './__fixtures__/sample-course/course.json';

describe('CourseContentSchema', () => {
  it('解析真实结构的 course.json 不报错', () => {
    expect(() => CourseContentSchema.parse(sampleCourse)).not.toThrow();
  });

  it('缺少 modules 时报错', () => {
    const { modules: _modules, ...broken } = sampleCourse as any;
    expect(() => CourseContentSchema.parse(broken)).toThrow();
  });

  it('同一课程内两个不同模块复用了同一个课时 id 时报错', () => {
    const [firstModule] = sampleCourse.modules;
    const duplicated = {
      ...sampleCourse,
      modules: [
        firstModule,
        {
          ...firstModule,
          id: 'module-2',
          position: 2,
          title: 'Module Two',
          lessons: [{ ...firstModule.lessons[0] }],
        },
      ],
    };

    expect(() => CourseContentSchema.parse(duplicated)).toThrow('课时 id 在同一课程内重复');
  });
});

describe('mapCourseLevel', () => {
  it('大小写不敏感地映射到枚举', () => {
    expect(mapCourseLevel('Intermediate')).toBe('INTERMEDIATE');
    expect(mapCourseLevel('beginner')).toBe('BEGINNER');
    expect(mapCourseLevel('ADVANCED')).toBe('ADVANCED');
  });

  it('未知难度时报错', () => {
    expect(() => mapCourseLevel('Expert')).toThrow('未知的课程难度');
  });
});
