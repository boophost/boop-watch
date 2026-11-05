// Text shared by everything that compares a catalog title to a release name.
import { decode } from 'he'

/**
 * Lowercased words, for comparing titles. Accents fold rather than break the
 * word: stripping non-ASCII outright turned "Léon" into "l on", which no
 * "Leon.The.Professional" release can ever match. Used on both sides of every
 * comparison, so search and download matching have to agree.
 */
export const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** apibay returns names HTML-encoded: "L&eacute;on.The.Professional.1994". */
export const decodeReleaseName = (s: unknown): string => decode(String(s ?? ''))
