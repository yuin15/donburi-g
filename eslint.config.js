import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true, skipTemplates: true }],
    },
    ignores: ['dist/**'],
  },
);
