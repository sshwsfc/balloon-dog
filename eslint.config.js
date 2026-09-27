import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // server/ 是独立的 npm 包（Express + Prisma，Node 运行时），有自己的 tsconfig 与
  // eslint 配置（见 server/eslint.config.js）。用这份「浏览器 + React」配置去 lint 它
  // 是错误的：globals.browser 会把 Node 全局量判成未定义，React 规则对后端也无意义。
  globalIgnores(['dist', 'server', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // 下划线前缀 = 有意不使用（解构时排除的字段、占位参数），
      // 比给每一处加 eslint-disable 更清晰。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
])
