import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
    {
        files: ['src/**/*.ts'],
        extends: [tseslint.configs.recommended],
        languageOptions: {
            globals: globals.node,
        },
        plugins: { sonarjs },
        rules: {
            complexity: ['error', 10],
            'max-depth': ['error', 4],
            'max-params': ['error', 4],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'sonarjs/cognitive-complexity': ['error', 15],
        },
    },
    eslintConfigPrettier,
);
