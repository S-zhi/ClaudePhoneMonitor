import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '.gradle/**'] },
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-dupe-keys': 'error', 'no-debugger': 'error', 'no-constant-condition': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error', 'constructor-super': 'error', 'valid-typeof': 'error' },
  },
  { files: ['**/*.{js,mjs}'], rules: { 'no-undef': js.configs.recommended.rules['no-undef'] } },
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
];
