/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// Infrastructure v2: раньше здесь типизировался Cloudflare Pages Functions
// runtime binding (`DirectoryRuntime` из @astrojs/cloudflare, App.Locals.runtime.env).
// Node-адаптер этой концепции не имеет — серверные секреты читаются напрямую
// из process.env (см. src/lib/assistant/runtime-env.ts, единственная точка
// чтения). App.Locals для этого проекта сейчас ничего специального не
// добавляет — интерфейс оставлен пустым намеренно (не удалён совсем), чтобы
// при появлении реальной необходимости (например, middleware, кладущее
// что-то в locals) не пришлось заново заводить объявление модуля.
declare namespace App {
  interface Locals {}
}

