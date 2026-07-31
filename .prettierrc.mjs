/**
 * Shared Prettier configuration.
 *
 * Kept identical in beyond-borders-admin and beyond-borders-web so formatting
 * never differs across the two repos.
 *
 * @type {import('prettier').Config}
 */
const config = {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'es5',
}

export default config
