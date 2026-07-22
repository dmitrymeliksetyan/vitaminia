import { trackEvent } from './track-event';

// ЭТАП 1 аналитики — page_view для "значимых" страниц (см. ТЗ часть 3).
// Классификация по пути, чтобы не нужно было добавлять вызов в каждый файл
// страницы отдельно — достаточно одного <script> в BaseLayout/AppLayout.
// Технические/неперечисленные страницы намеренно пропускаются (ТЗ: "не
// обязательно записывать каждую техническую страницу").

// Категории Vitaminia — см. src/content/categories/*.mdx (slug). Список
// небольшой и меняется редко, поэтому захардкожен здесь же, аналогично тому,
// как medizin хардкодил литерал "symptoms" в этом же файле — доступа к
// Astro-коллекциям из клиентского скрипта нет.
const CATEGORY_SLUGS = new Set(['vitaminas', 'minerales', 'nutrientes', 'suplementos']);

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

  // /{category}/{slug}/ — страница конкретного нутриента.
  const nutrientMatch = path.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (nutrientMatch && CATEGORY_SLUGS.has(nutrientMatch[1])) {
    trackEvent('page_view', { content_type: 'nutrient', slug: nutrientMatch[2] });
    return;
  }

  // /{category}/ — страница категории (каталог нутриентов по теме).
  const categoryMatch = path.match(/^\/([^/]+)\/?$/);
  if (categoryMatch && CATEGORY_SLUGS.has(categoryMatch[1])) {
    trackEvent('page_view', { content_type: 'nutrient_category', slug: categoryMatch[1] });
    return;
  }

  // Остальные страницы (auth, admin и т.д.) намеренно не отслеживаются.
}
