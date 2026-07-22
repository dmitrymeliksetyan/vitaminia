import { siteConfig } from "./site";

export interface SeoInput {
  title: string;
  description: string;
  path: string; // например "/vitaminas/vitamina-d"
  image?: string; // абсолютный или относительный URL, по умолчанию siteConfig.defaultOgImage
  type?: "website" | "article";
  publishedTime?: string; // ISO, только для type="article"
  modifiedTime?: string; // ISO, только для type="article"
}

export interface SeoOutput {
  title: string;
  description: string;
  canonical: string;
  og: {
    title: string;
    description: string;
    url: string;
    image: string;
    type: "website" | "article";
    siteName: string;
    locale: string;
    publishedTime?: string;
    modifiedTime?: string;
  };
  twitter: {
    card: "summary_large_image";
    site: string;
    title: string;
    description: string;
    image: string;
  };
}

function absoluteUrl(path: string): string {
  if (path.startsWith("http")) return path;
  return `${siteConfig.url}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Единая точка сборки SEO-метаданных. Любая страница вызывает это вместо
 * того, чтобы вручную собирать canonical/OG/Twitter — так гарантируется,
 * что формат одинаков везде и не разъезжается по страницам.
 */
export function buildSeo(input: SeoInput): SeoOutput {
  const canonical = absoluteUrl(input.path);
  const image = absoluteUrl(input.image ?? siteConfig.defaultOgImage);
  const type = input.type ?? "website";

  return {
    title: input.title,
    description: input.description,
    canonical,
    og: {
      title: input.title,
      description: input.description,
      url: canonical,
      image,
      type,
      siteName: siteConfig.name,
      locale: siteConfig.locale,
      ...(type === "article" ? { publishedTime: input.publishedTime, modifiedTime: input.modifiedTime } : {})
    },
    twitter: {
      card: "summary_large_image",
      site: siteConfig.twitterHandle,
      title: input.title,
      description: input.description,
      image
    }
  };
}
