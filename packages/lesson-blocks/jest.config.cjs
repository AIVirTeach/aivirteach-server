module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  // index.ts 只是转发导出，其中的 getter 不是业务逻辑
  collectCoverageFrom: ['**/*.(t|j)s', '!index.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
