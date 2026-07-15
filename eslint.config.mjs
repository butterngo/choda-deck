import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'scripts/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Extension is plain classic-script / CommonJS browser code (MV3), not TS
    // modules — its dual-mode libs + tests use require()/module.exports.
    files: ['extension/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  eslintConfigPrettier
)
