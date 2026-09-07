// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'drizzle/**',
      'data/**',
      'web/dist/**',
      // Макеты из Claude Design — чужой код, не наш стиль.
      'ui/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Компоненты Vue: разметку разбирает vue-eslint-parser, скрипт внутри —
  // тот же типизированный парсер, что и на бэкенде.
  // `essential`, а не `recommended`: правила про переносы и порядок атрибутов —
  // это форматирование, а Prettier в проекте нет и код форматируется руками.
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      // Компоненты живут в браузере: window, setTimeout, EventSource.
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // Имя одного слова читается как элемент разметки; в этом проекте
      // компоненты названы по месту, а не по шаблону «Base*».
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
