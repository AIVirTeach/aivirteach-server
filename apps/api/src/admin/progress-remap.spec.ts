import { remapRemovedLessons } from './progress-remap';

describe('remapRemovedLessons', () => {
  it('maps a removed lesson to the next later retained lesson', () => {
    expect(remapRemovedLessons(['a', 'b', 'c', 'd'], ['a', 'c', 'd'])).toEqual(
      new Map([['b', 'c']]),
    );
  });

  it('maps a removed tail lesson to the last lesson in the new order', () => {
    expect(remapRemovedLessons(['a', 'b', 'c'], ['a', 'b'])).toEqual(
      new Map([['c', 'b']]),
    );
  });

  it('does not remap pointers when the new course is empty', () => {
    expect(remapRemovedLessons(['a', 'b'], [])).toEqual(new Map());
  });

  it('does not remap retained lesson IDs', () => {
    expect(remapRemovedLessons(['a', 'b'], ['b', 'a'])).toEqual(new Map());
  });
});
