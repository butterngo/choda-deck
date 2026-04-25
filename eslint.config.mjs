import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'scripts/**'] },
  ...tseslint.configs.recommended,
  eslintConfigPrettier
)
