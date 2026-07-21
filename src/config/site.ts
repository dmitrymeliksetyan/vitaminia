export const siteConfig = {
  name: "Vitaminia",
  description: "Tu país de vitaminas. Información clara y confiable sobre vitaminas, minerales, nutrientes y suplementos para vivir mejor cada día.",
  // Временно поддомен medizin.ru, пока vitaminia.mx не зарегистрирован —
  // сменить на "https://vitaminia.mx" сразу после регистрации домена и DNS.
  url: "https://vitaminia.medizin.ru",
  locale: "es-MX",
  twitterHandle: "@vitaminia", // плейсхолдер — заменить на реальный аккаунт перед публикацией
  defaultOgImage: "/og-default.png" // плейсхолдер — заменить реальным 1200x630 изображением
} as const;
