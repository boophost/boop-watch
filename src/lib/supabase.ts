import { createClient } from '@supabase/supabase-js'

// Runtime config the server may inject as window.ENV; build-time VITE_* values win.
const env = (window as Window & { ENV?: { SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string } }).ENV || {}
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || env.SUPABASE_URL || ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || ''

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
