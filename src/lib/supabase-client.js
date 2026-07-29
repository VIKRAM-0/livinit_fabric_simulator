// Thin wrapper around supabase-js, loaded via CDN ESM import (no build step
// in this repo — see docs/superpowers/specs/2026-07-29-real-login-tenant-gating-design.md
// §3 for why this over a hand-rolled fetch client or a bundler).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOutSupabase() {
  await supabase.auth.signOut();
}

export async function getSupabaseSession() {
  const { data } = await supabase.auth.getSession();
  return data.session; // null if no persisted session
}

export function onAuthStateChange(callback) {
  supabase.auth.onAuthStateChange((event, session) => callback(event, session));
}
