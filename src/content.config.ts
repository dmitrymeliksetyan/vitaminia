import { defineCollection, z, reference } from "astro:content";

// Vitaminia es-MX — texto plano en español, sin envoltura localizedString
// (el proyecto original MEDIZIN traía ru/en; Vitaminia es monolingüe es-MX).

const categories = defineCollection({
  type: "content",
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    shortTitle: z.string().optional(),
    breadcrumbLabel: z.string().optional(),
    description: z.string(),
    icon: z.string().optional(),
    accentColor: z.string().optional(),
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),
    order: z.number().default(0)
  })
});

const sourceSchema = z.object({
  title: z.string(),
  url: z.string().url()
});

const faqItemSchema = z.object({
  q: z.string(),
  a: z.string()
});

// "nutrients" reemplaza a "symptoms" del proyecto base: la entidad central
// ahora es la sustancia (vitamina / mineral / nutriente / suplemento), no el
// síntoma. La plantilla de campos sigue la estructura pedida en el TZ:
// Qué es / Para qué sirve / Beneficios / Déficit / Exceso / Fuentes /
// Dosis diaria / Suplementos / Contraindicaciones / FAQ.
const nutrients = defineCollection({
  type: "content",
  schema: z.object({
    // --- Identificación ---
    title: z.string(),
    slug: z.string(),
    category: reference("categories"),
    otherNames: z.array(z.string()).default([]), // ej. Calciferol para Vitamina D
    kind: z.enum(["vitamina", "mineral", "nutriente", "aminoacido", "suplemento"]),
    soluble: z.enum(["agua", "grasa"]).optional(), // solo aplica a vitaminas

    // --- Respuesta corta (primera pantalla) ---
    shortAnswer: z.string(),

    // --- Contenido estructurado (plantilla del TZ) ---
    whatIsIt: z.string(),                            // Qué es
    whatIsItFor: z.array(z.string()).default([]),     // Para qué sirve
    benefits: z.array(z.string()).default([]),        // Beneficios
    deficiencySigns: z.array(z.string()).default([]), // Señales de déficit
    excessSigns: z.array(z.string()).default([]),     // Señales de exceso
    foodSources: z.array(z.string()).default([]),     // Fuentes en la comida
    dailyIntake: z.array(z.string()).default([]),     // Dosis diaria (por grupo de edad)
    supplementForms: z.array(z.string()).default([]), // Formas en suplementos
    contraindications: z.array(z.string()).default([]), // Posibles contraindicaciones

    // --- Meta ---
    tags: z.array(z.string()).default([]),
    manualRelated: z.array(z.string()).default([]),
    updated: z.coerce.date(),
    reviewed: z.coerce.date().optional(),
    sources: z.array(sourceSchema).default([]),

    // --- SEO ---
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),

    // --- FAQ ---
    faq: z.array(faqItemSchema).default([])
  })
});

export const collections = { categories, nutrients };
