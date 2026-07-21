/**
 * Грубая, ПРИБЛИЗИТЕЛЬНАЯ оценка стоимости вызова Anthropic для лога (п.19
 * ТЗ AI-редакции, "логирование стоимости") — не тарифная точность, а порядок
 * величины для мониторинга расходов на производство одного материала.
 * Сверяйте с актуальным прайсом Anthropic при необходимости точных цифр.
 *
 * Раньше жила ТОЛЬКО внутри medizin-worker/src/ai/ai-client.ts. Вынесена в
 * medizin-shared, потому что после разделения на medizin (SSR)/medizin-worker
 * у неё РЕАЛЬНО два независимых потребителя: Worker считает стоимость
 * каждого этапа при записи content_job_runs/content_strategy_runs, а SSR
 * (GET /api/admin/content/jobs) агрегирует уже сохранённые usage-токены в
 * ту же самую сумму для отображения администратору — теми же коэффициентами,
 * иначе цифры в двух местах интерфейса неизбежно разойдутся.
 */

const APPROX_PRICE_PER_MTOK_INPUT_USD = 3;
const APPROX_PRICE_PER_MTOK_OUTPUT_USD = 15;

export function estimateCostUsd(inputTokens, outputTokens) {
  return (
    (inputTokens / 1_000_000) * APPROX_PRICE_PER_MTOK_INPUT_USD +
    (outputTokens / 1_000_000) * APPROX_PRICE_PER_MTOK_OUTPUT_USD
  );
}
