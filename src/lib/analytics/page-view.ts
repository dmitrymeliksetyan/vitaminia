import { trackEvent } from './track-event';

// ЭТАП 1 аналитики — page_view для "значимых" страниц (см. ТЗ часть 3).
// Классификация по пути, чтобы не нужно было добавлять вызов в каждый файл
// страницы отдельно — достаточно одного <script> в BaseLayout/AppLayout.
// Технические/неперечисленные страницы намеренно пропускаются (ТЗ: "не
// обязательно записывать каждую техническую страницу").

export function trackPageView(): void {
  const path = window.location.pathname;

  if (path === '/') {
    trackEvent('page_view', { content_type: 'home' });
    return;
  }
  if (path === '/how-it-works' || path === '/how-it-works/') {
    trackEvent('page_view', { content_type: 'how_it_works' });
    return;
  }
  if (path === '/my' || path === '/my/') {
    trackEvent('page_view', { content_type: 'my_card' });
    return;
  }
  if (path === '/assistant' || path === '/assistant/') {
    trackEvent('page_view', { content_type: 'assistant' });
    return;
  }

  // /symptoms/[topic]/[slug]/ — страница конкретного симптома.
  const symptomMatch = path.match(/^\/symptoms\/([^/]+)\/([^/]+)\/?$/);
  if (symptomMatch) {
    trackEvent('page_view', { content_type: 'symptom', slug: symptomMatch[2] });
    return;
  }

  // /symptoms/[topic]/ — страница категории ("каталог симптомов" по теме).
  const categoryMatch = path.match(/^\/symptoms\/([^/]+)\/?$/);
  if (categoryMatch) {
    trackEvent('page_view', { content_type: 'symptom_category', slug: categoryMatch[1] });
    return;
  }

  // Остальные страницы (auth, assistant-test, hangover и т.д.) намеренно
  // не отслеживаются на Этапе 1.
}
