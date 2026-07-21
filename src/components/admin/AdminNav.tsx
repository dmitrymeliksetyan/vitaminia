import React from 'react';
import BuildInfoBadge from './BuildInfoBadge';

// Аналитика и админка. Этап 7 ТЗ (п.2, дословно): единый общий пункт
// «Контент» заменяется на два самостоятельных раздела верхнего уровня —
// «AI-редакция» (производство нового контента) и «Библиотека контента»
// (управление уже опубликованным). Они не пересекаются визуально (см.
// финальный отчёт Этапа 7): AI-редакция живёт под /admin/editorial/*,
// Библиотека — под /admin/content (тот же путь, что раньше, но теперь это
// ДРУГАЯ, куда более узкая страница — см. LibraryApp.tsx).
//
// ТЗ "Build Info в админке": AdminNav — единственный компонент, реально
// отрисовываемый КАЖДОЙ admin-страницей (AdminDashboard/EditorialApp/
// LibraryApp/UsersDashboard/UserDetail/FeedbackDashboard все его
// подключают) — поэтому именно сюда добавлен BuildInfoBadge справа от
// пунктов меню: это единственное место, гарантирующее "на всех страницах
// админки" без правки каждой страницы по отдельности.

// Vitaminia — форк админки medizin, упрощён под один тип контента
// (нутриент). «Библиотека контента» (кластеры/пробелы/SEO-здоровье) и
// «SEO Monitor» вырезаны как symptom-специфичный инструментарий анализа,
// не нужный для рабочего конвейера идея → черновик → публикация.
export type AdminSection = 'analytics' | 'users' | 'feedback' | 'editorial';

const NAV_ITEMS: Array<{ key: AdminSection; label: string; href: string }> = [
  { key: 'analytics', label: 'Аналитика', href: '/admin' },
  { key: 'users', label: 'Пользователи', href: '/admin/users' },
  { key: 'feedback', label: 'Обратная связь', href: '/admin/feedback' },
  { key: 'editorial', label: 'AI-редакция', href: '/admin/editorial' },
];

// ТЗ "Исправить меню AI-редакции" — раньше пункты меню жили в ОДНОЙ flex-
// строке вместе с BuildInfoBadge (`justify-content: space-between`), а сам
// список пунктов имел `overflowX: 'auto'` + `whiteSpace: 'nowrap'`. На узкой
// ширине (или когда Build Info "отъедал" фиксированную ширину справа —
// `flexShrink: 0` в BuildInfoBadge) пунктам физически не хватало места, они
// не могли перенестись на новую строку (nowrap) и вместо этого попадали в
// горизонтальный scroll-контейнер — отсюда и серые полосы прокрутки, и
// обрезанные/сжатые пункты.
//
// Исправление: главное меню — ОТДЕЛЬНАЯ строка, flex-wrap: wrap (никакого
// overflow/scroll, никакой фиксированной высоты — при нехватке ширины пункты
// сами переносятся на следующую строку). Build Info — СВОЯ строка ПОД
// главным меню, прижата вправо (`justify-content: flex-end`) — она больше
// не в одном flex-контейнере с пунктами меню и никогда не отбирает у них
// ширину.
export default function AdminNav({ current }: { current: AdminSection }) {
  return (
    <div style={{ marginBottom: 'var(--space-5)' }}>
      <nav
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-1)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = item.key === current;
          return (
            <a
              key={item.key}
              href={item.href}
              style={{
                fontSize: 'var(--font-size-sm)',
                fontWeight: active ? 'var(--font-weight-semibold)' : 'var(--font-weight-regular)',
                color: active ? 'var(--color-brand-blue)' : 'var(--color-text-secondary)',
                padding: '10px 14px',
                borderBottom: active ? '2px solid var(--color-brand-blue)' : '2px solid transparent',
                marginBottom: -1,
                textDecoration: 'none',
              }}
            >
              {item.label}
            </a>
          );
        })}
      </nav>
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
        <BuildInfoBadge />
      </div>
    </div>
  );
}
