import RSS from "rss";
import { getAllNutrients, categoryIdOf } from "../config/content";
import { siteConfig } from "../config/site";

export const prerender = true;

export async function GET() {
  const nutrients = await getAllNutrients();

  const feed = new RSS({
    title: siteConfig.name,
    description: siteConfig.description,
    site_url: siteConfig.url,
    feed_url: `${siteConfig.url}/feed.xml`,
    language: "es-mx"
  });

  const sorted = [...nutrients].sort(
    (a, b) => new Date(b.data.updated).getTime() - new Date(a.data.updated).getTime()
  );

  for (const n of sorted) {
    feed.item({
      title: n.data.title,
      description: n.data.shortAnswer,
      url: `${siteConfig.url}/${categoryIdOf(n)}/${n.data.slug}`,
      date: new Date(n.data.updated)
    });
  }

  return new Response(feed.xml({ indent: true }), {
    headers: { "Content-Type": "application/xml" }
  });
}
