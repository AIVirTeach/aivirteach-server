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
