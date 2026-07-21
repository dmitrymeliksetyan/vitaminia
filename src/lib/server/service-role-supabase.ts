import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service role client — обходит RLS, поэтому используется ТОЛЬКО там, где
// таблица намеренно закрыта от anon/authenticated (см. миграции 004
// feedback_messages и 005 analytics_events — обе имеют RLS enabled без
// единой policy для клиентских ролей).
//
// Изначально этот файл жил как src/lib/feedback/server-supabase-admin.ts и
// был специфичен по названию для формы обратной связи, хотя реализация
// уже была полностью общей. Перенесён сюда при добавлении аналитики
// (Этап 1), чтобы не плодить два одинаковых helper'а — ТЗ прямо просило
// переиспользовать существующий service-role helper, а не дублировать.
//
// Секрет — ТОЛЬКО серверная переменная окружения SUPABASE_SERVICE_ROLE_KEY
// (Node process.env, см. .env.example/shared/.env.production), никогда не
// PUBLIC_*, никогда в git. Используйте этот клиент только для тех таблиц,
// где RLS осознанно не даёт доступа обычным ролям — не расширяйте его
// использование на что-либо ещё без пересмотра RLS-модели конкретной таблицы.

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string;

export function getServiceRoleSupabase(serviceRoleKey: string): SupabaseClient {
  return createClient(SUPABASE_URL ?? '', serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
