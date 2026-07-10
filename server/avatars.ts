import path from 'node:path'

/** Custom profile-picture uploads live under DATA_DIR/avatars, one file per user
 *  (id-prefixed filename; a re-upload replaces the previous one). Its own module
 *  so both index.ts (writes) and publicRoutes.ts (serves) can import it without
 *  a circular dependency on index.ts. */
export const AVATARS_DIR = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), 'avatars')
