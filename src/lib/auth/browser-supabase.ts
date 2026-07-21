import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url     = import.meta.env.PUBLIC_SUPABASE_URL  as string;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    // Не задаём storageKey — используем дефолтный ключ Supabase.
    // Это гарантирует что все клиенты (логин, приложение) читают
    // из одного места в localStorage.
    _client = createClient(url ?? '', anonKey ?? '', {
      auth: {
        persistSession:    true,
        autoRefreshToken:  true,
        detectSessionInUrl: true,   // нужно для обработки токена из email-ссылок
      },
    });
  }
  return _client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const value = (client as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
