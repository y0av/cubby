// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 y0av

// ESLint flat config, close to GNOME Shell's own style. Run with
// `npx eslint` from the repository root (ESLint 9).

const gjsGlobals = {
    global: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    console: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    {
        files: ['src/**/*.js', 'tests/**/*.js', 'tools/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'no-var': 'error',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'indent': ['error', 4, {
                // the class body of GObject.registerClass() is not indented
                ignoredNodes: [
                    'CallExpression[callee.object.name=GObject][callee.property.name=registerClass] > ClassExpression:first-child',
                ],
                MemberExpression: 'off',
            }],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
            'object-curly-spacing': ['error', 'never'],
            'arrow-parens': ['error', 'as-needed'],
            'brace-style': ['error', '1tbs'],
            'keyword-spacing': 'error',
            'space-before-blocks': 'error',
            'no-trailing-spaces': 'error',
            'eol-last': 'error',
            'prefer-template': 'error',
            'prefer-arrow-callback': 'error',
        },
    },
];
