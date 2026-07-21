// ЭТАП 1 аналитики, часть 15 — ориентировочная стоимость AI-запросов.
//
// ВАЖНО (см. ТЗ): "не хардкодить цену без объяснения; архитектура должна
// учитывать изменение модели и цены". Поэтому:
//   - цены здесь — таблица per-model, а не одно число;
//   - для модели, которой нет в таблице, стоимость просто не считается
//     (возвращается null), но токены всё равно показываются — это
//     единственный вариант, не гадать цену для неизвестной модели;
//   - таблицу нужно обновлять руками при смене модели/тарифов Anthropic —
//     это осознанный компромисс для Этапа 1 (ТЗ прямо разрешает: "если
//     это сильно усложняет Этап 1, достаточно токенов").
//
// Источник цен: официальный прайс-лист Anthropic на момент разработки
// (июль 2026), $ за миллион токенов. ПРОВЕРЬТЕ АКТУАЛЬНОСТЬ перед тем, как
// полагаться на эту цифру для реальных бизнес-решений — цены могут
// измениться, а данные аналитики этого сами не отследят.

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING_USD_PER_MILLION_TOKENS: Record<string, ModelPricing> = {
  'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-8': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4 },
};

export interface AiCostEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null; // null — модель не в таблице цен, посчитать нельзя
}

export function estimateAiCost(model: string, inputTokens: number, outputTokens: number): AiCostEstimate {
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model];
  const estimatedCostUsd = pricing
    ? (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion
    : null;

  return { model, inputTokens, outputTokens, estimatedCostUsd };
}
