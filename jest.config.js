// eslint-disable-next-line
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|ts|tsx)$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@noble/(ed25519|curves|hashes|ciphers)|expo/virtual)/)',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/__tests__/**/*.test.(ts|tsx)'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
