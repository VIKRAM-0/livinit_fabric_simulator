// Public Supabase project config — the anon key is safe to ship client-side
// by design (Postgres RLS is the real security boundary, not this key).
// Same project backend-livinit points at (src/settings.py SUPABASE_URL/KEY).
export const SUPABASE_URL = 'https://nyvlydjdvhsunqbliqru.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55dmx5ZGpkdmhzdW5xYmxpcXJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1MjcwMTMsImV4cCI6MjA3NTEwMzAxM30.mUByk0Bz7kp-w6007yJC-3w5zRGGTE0WrezL-n0QTZw';
