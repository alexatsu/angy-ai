import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import eslint from '@eslint/js'
import perfectionist from 'eslint-plugin-perfectionist'
import { defineConfig } from 'eslint/config'

export default defineConfig(
    js.configs.recommended,
    eslint.configs.recommended,
    tseslint.configs.recommended,
    prettier,
    {
        plugins: {
            perfectionist,
        },
        ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', 'eslint.config.js'],
        languageOptions: {
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // TypeScript
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
            ],
            '@typescript-eslint/no-import-type-side-effects': 'error',
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],

            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',

            // General
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'prefer-const': 'error',
            'object-shorthand': 'error',
            'prefer-template': 'error',
            '@typescript-eslint/no-misused-promises': [0],
            'perfectionist/sort-imports': 'error',
        },
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        ...tseslint.configs.disableTypeChecked,
    },
)
