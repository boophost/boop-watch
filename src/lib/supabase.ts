import { createClient } from '@supabase/supabase-js'

const env = (window as any).ENV || {}
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || env.SUPABASE_URL || ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || ''

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
