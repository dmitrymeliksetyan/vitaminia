import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ЭТАП 3: серверный Supabase-клиент для API-роутов Помощника.
//
// Важно: здесь НЕТ и не должно быть service role key (см. п.22 ТЗ Этапа 3).
// Вместо этого клиент создаётся с анонимным ключом, но с Authorization
// заголовком, содержащим access token текущей сессии пользователя (тот же
// токен, что уже есть в браузере через supabase.auth.getSession()).
//
// PostgREST/Supabase проверяет этот JWT и подставляет auth.uid() — то есть
// вся текущая RLS-модель (`auth.uid() = user_id` / `owner_user_id`) работает
// без изменений, а профиль или разговор из чужого аккаунта просто не будет
// виден серверу, даже если profile_id передан в теле запроса.

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

export function getServerSupabase(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL ?? '', SUPABASE_ANON_KEY ?? '', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
