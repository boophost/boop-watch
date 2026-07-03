import packageJson from '../package.json' with { type: 'json' }

// Replaced at build time by Vite's `define` (see vite.config.ts).
declare const __APP_COMMIT__: string

export const APP_VERSION = packageJson.version
export const APP_COMMIT = __APP_COMMIT__
