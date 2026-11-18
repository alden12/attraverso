/**
 * The site's home page (`DIST-10`): the README, for now. Rendered with the viewer's own markdown stack
 * (react-markdown with GFM), plus `rehype-raw` for the README's centred logo and screenshots, which are HTML.
 */
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import readme from "../README.md?raw";
import favicon from "../roadmap/favicon.svg";

const REPO = "https://github.com/alden12/attraverso";

/** The images the README shows, by the path it writes, each emitted by the build under its hashed name. */
const ASSETS: Record<string, string> = {
  "roadmap/favicon.svg": favicon,
  ...Object.fromEntries(
    Object.entries(import.meta.glob<string>("../docs/screenshots/*", { eager: true, query: "?url", import: "default" })).map(([path, url]) => [
      path.replace(/^\.\.\//, ""),
      url,
    ]),
  ),
};

/**
 * A README URL as the site needs it: an image it shows becomes the built copy, any other repo-relative path (the
 * licence, a doc) the file on GitHub, where it renders. Absolute URLs and anchors pass through, made safe as
 * react-markdown makes every URL.
 */
function urlOf(url: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return defaultUrlTransform(url);
  const path = url.replace(/^\.\//, "");
  return ASSETS[path] ?? `${REPO}/blob/master/${path}`;
}

export function Home() {
  return (
    <main className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} urlTransform={urlOf}>
        {readme}
      </Markdown>
      <hr />
      <p>
        <a href={REPO}>attraverso on GitHub</a> · <a href="https://www.npmjs.com/package/attraverso">on npm</a> ·{" "}
        {/* Relative, so it works under `/attraverso/` on Pages and at the root of the dev server alike. */}
        <a href="./open/">open a plan folder in this browser</a>
      </p>
    </main>
  );
}
