// MEDIZIN — Аналитика и админка, Этап 2.
//
// Единственное место, вычисляющее статус пользователя (Новый/Активный/
// Вернувшийся/Неактивный) — переиспользуется и в /api/admin/users (список,
// фильтр по статусу, карточка), и в /api/admin/analytics (компактный блок
// сегментов на главной, см. ТЗ п.9). Никакой второй копии этой логики нет.
//
// Правила сознательно простые (см. ТЗ: "не усложнять модель") и полностью
// объясняются в интерфейсе — см. STATUS_RULES_DESCRIPTION ниже, который
// рендерится рядом со статусами, а не только хранится в коде.

export type UserStatus = 'new' | 'active' | 'returning' | 'inactive';

export const STATUS_LABELS: Record<UserStatus, string> = {
  new: 'Новый',
  active: 'Активный',
  returning: 'Вернувшийся',
  inactive: 'Неактивный',
};

export const STATUS_RULES_DESCRIPTION: Record<UserStatus, string> = {
  new: 'Зарегистрирован 3 дня назад или позже — ещё рано судить о поведении.',
  active:
    'Последнее действие — за последние 3 дня, и либо аккаунту меньше 2 недель, либо активность была примерно в половине дней с регистрации и чаще (без явных долгих перерывов).',
  returning:
    'Последнее действие — за последние 3 дня, но аккаунту больше 2 недель, и активных дней было меньше половины от всех дней с регистрации — то есть были заметные перерывы, а потом пользователь снова начал действовать.',
  inactive: 'Последнее действие было более 3 дней назад.',
};

const DAY_MS = 86_400_000;

/**
 * @param now текущее время
 * @param registeredAt profiles.created_at (is_primary=true)
 * @param lastActiveAt максимум дат активности (см. analytics_user_footprint().last_active_at)
 * @param activeDaysCount число различных дней с событиями (analytics_events) — приближение, см. миграцию 007
 */
export function classifyUserStatus(
  now: Date,
  registeredAt: Date,
  lastActiveAt: Date,
  activeDaysCount: number,
): UserStatus {
  const daysSinceRegistration = (now.getTime() - registeredAt.getTime()) / DAY_MS;
  const daysSinceLastActive = (now.getTime() - lastActiveAt.getTime()) / DAY_MS;

  if (daysSinceRegistration <= 3) return 'new';
  if (daysSinceLastActive > 3) return 'inactive';

  // Последнее действие недавнее (<=3 дня) и аккаунт старше 3 дней —
  // отличаем "стабильно активного" от "вернувшегося после перерыва" по
  // грубой доле активных дней от всех дней с регистрации.
  const activeDaysRatio = activeDaysCount / Math.max(1, daysSinceRegistration);
  if (daysSinceRegistration > 14 && activeDaysRatio < 0.5) return 'returning';
  return 'active';
}

/** Короткий анонимизированный "хвост" ID — тот же формат, что и в
 * /api/admin/analytics ("Последняя активность"): последние 4 символа,
 * недостаточно, чтобы деанонимизировать, достаточно, чтобы отличить записи.
 */
export function shortId(id: string): string {
  return `…${id.slice(-4)}`;
}
