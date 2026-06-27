import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s', '!src/main.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@gosumo/shared(.*)$': '<rootDir>/../../packages/shared/src$1',
    '^@gosumo/database(.*)$': '<rootDir>/../../packages/database/src$1',
    '^@gosumo/config(.*)$': '<rootDir>/../../packages/config/src$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@common/(.*)$': '<rootDir>/src/common/$1',
  },
};

export default config;
