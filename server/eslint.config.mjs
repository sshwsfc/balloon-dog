import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * server/ 自己的 lint 配置（Node 运行时，无 React）。
 * 与前端配置分开，避免把浏览器全局量当成 Node 的、或用 React 规则去要求后端代码。
 */
export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'src/generated']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // 下划线前缀 = 有意不使用（Express 错误处理器的 _next、解构排除的字段等）
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // 后端确实有必须用 any 的位置（腾讯云 SDK、Prisma JSON、Express 错误对象），
      // 但要求显式写出 eslint-disable 注释说明原因，而不是静默放过。
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
])
