// MEDIZIN — единственное место с человеко-понятными названиями событий
// analytics_events для админки. Переиспользуется и в /api/admin/analytics
// ("Последняя активность"), и в /api/admin/users/[id] (лента событий
// конкретного пользователя) — чтобы не разошлись два независимых списка
// названий. page_view сюда сознательно не входит — см. комментарии на
// местах использования (самое частое событие, забьёт ленту шумом).
export const EVENT_LABELS: Record<string, string> = {
  signup_completed: 'Новая регистрация',
  card_opened: 'Открыта Карта',
  card_section_completed: 'Сохранён раздел Карты',
  assistant_opened: 'Открыт Помощник',
  assistant_first_message: 'Задан первый вопрос Помощнику',
  journal_created: 'Создан дневник',
  journal_entry_added: 'Добавлена запись в дневник',
};
