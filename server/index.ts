import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  searchAnime,
  pickPosterUrl,
  fetchAnimeFull,
  fetchAnimeEpisodesPage,
  episodeNumberFromUrl,
} from './jikan.js'
import * as seriesDb from './db.js'
import { publicRouter } from './publicRoutes.js'
import { warmScope } from './jellyfin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.disable('x-powered-by')
const PORT = parseInt(process.env.PORT ?? '3001')
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'
const AUTH_USERNAME = process.env.AUTH_USERNAME ?? 'admin'
const AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? 'changeme'
const COOKIE_NAME = 'ai_session'
const IS_PROD = process.env.NODE_ENV === 'production'

app.use(express.json())
app.use(cookieParser())

// Public, no-login portal routes (catalog, player, HLS/sub/image proxies,
// schedule). Registered before the authed admin APIs and the SPA catch-all.
app.use(publicRouter)

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  let token = req.cookies[COOKIE_NAME] as string | undefined
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1]
  }

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { username?: string, email?: string }
    res.locals.username = payload.email || payload.username || 'admin'
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

app.get('/api/me', requireAuth, (_req, res) => {
  res.json({ username: res.locals.username as string })
})

app.get('/api/search/anime', requireAuth, async (req, res) => {
  const raw = req.query.q
  const q = typeof raw === 'string' ? raw : ''
  if (!q.trim()) {
    res.json({ results: [] })
    return
  }
  try {
    const data = await searchAnime(q)
    res.json({
      results: data.map((a) => ({
        mal_id: a.mal_id,
        title: a.title,
        synopsis: a.synopsis ?? '',
        image_url: pickPosterUrl(a),
        url: a.url,
      })),
    })
  } catch (e) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Search failed'
    res.status(502).json({ error: msg })
  }
})

app.get('/api/series', requireAuth, (_req, res) => {
  seriesDb.getDb()
  res.json({ series: seriesDb.listSeries() })
})

app.get('/api/series/:id/detail', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const series = seriesDb.getSeriesById(id)
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  try {
    const mal = await fetchAnimeFull(series.mal_id)
    res.json({ series, mal })
  } catch (e) {
    console.error(e)
    res.json({
      series,
      mal: null,
      malError: e instanceof Error ? e.message : 'Could not load MAL details',
    })
  }
})

app.get('/api/series/:id/episodes', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const series = seriesDb.getSeriesById(id)
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  const pageRaw = req.query.page
  const p =
    typeof pageRaw === 'string' && Number.isFinite(Number(pageRaw))
      ? Math.max(1, Math.floor(Number(pageRaw)))
      : 1
  try {
    const { episodes, pagination } = await fetchAnimeEpisodesPage(series.mal_id, p)
    res.json({
      episodes: episodes.map((e) => ({
        mal_id: e.mal_id,
        url: e.url,
        title: e.title,
        title_japanese: e.title_japanese ?? null,
        aired: e.aired ?? null,
        filler: e.filler,
        recap: e.recap,
        episode: episodeNumberFromUrl(e.url),
      })),
      pagination,
    })
  } catch (e) {
    console.error(e)
    res.status(502).json({
      error: e instanceof Error ? e.message : 'Could not load episodes',
    })
  }
})

app.post('/api/series', requireAuth, (req, res) => {
  const body = req.body as {
    mal_id?: unknown
    title?: unknown
    synopsis?: unknown
    image_url?: unknown
    url?: unknown
  }
  const mal_id = typeof body.mal_id === 'number' ? body.mal_id : Number(body.mal_id)
  const title = typeof body.title === 'string' ? body.title : ''
  const synopsis =
    typeof body.synopsis === 'string' ? body.synopsis : body.synopsis == null ? null : String(body.synopsis)
  const image_url =
    typeof body.image_url === 'string' ? body.image_url : body.image_url == null ? null : String(body.image_url)
  const url =
    typeof body.url === 'string' ? body.url : body.url == null ? null : String(body.url)

  if (!Number.isFinite(mal_id) || !title) {
    res.status(400).json({ error: 'mal_id and title are required' })
    return
  }
  if (seriesDb.findByMalId(mal_id)) {
    res.status(409).json({ error: 'Already in your list' })
    return
  }
  try {
    const row = seriesDb.insertSeries({
      mal_id,
      title,
      synopsis,
      image_url,
      url,
    })
    res.status(201).json({ series: row })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Could not save series' })
  }
})

app.delete('/api/series/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  if (!seriesDb.deleteSeries(id)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ ok: true })
})

app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  res.send(`window.ENV = {
    SUPABASE_URL: ${JSON.stringify(process.env.SUPABASE_URL)},
    SUPABASE_ANON_KEY: ${JSON.stringify(process.env.SUPABASE_ANON_KEY)}
  };`)
})

if (IS_PROD) {
  const distPath = path.join(__dirname, '../dist')
  
  app.use(express.static(distPath))
  app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'))
      return
    }
    res.status(404).end()
  })
}

app.listen(PORT, () => {
  seriesDb.getDb()
  warmScope()
  console.log(`Server running on http://localhost:${PORT}`)
})
