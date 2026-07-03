// Error Flying — watches Secret Flying's Europe deals page and emails you a link
// whenever a NEW post with "ERROR FARE" in the title appears.
//
// Run it every 30 min (see README for Windows Task Scheduler setup).
// No dependencies — needs Node 18+ (built-in fetch).
//
// Config via environment variables:
//   RESEND_API_KEY   (required) your Resend API key  -> https://resend.com/api-keys
//   TO_EMAIL         (required) where to send alerts (your email)
//   FROM_EMAIL       (optional) sender; default onboarding@resend.dev (works to your own inbox)
//   PAGE_URL         (optional) page to watch; default the Europe deals page
//   MATCH            (optional) case-insensitive phrase to match in titles; default "ERROR FARE"

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = join(HERE, "seen.json");

// .trim() strips stray whitespace/BOM that shells sometimes add to secrets.
const env = (k) => (process.env[k] || "").trim();
const PAGE_URL = env("PAGE_URL") || "https://www.secretflying.com/europe-flight-deals/";
const MATCH = (env("MATCH") || "ERROR FARE").toUpperCase();
const TO_EMAIL = env("TO_EMAIL");
const FROM_EMAIL = env("FROM_EMAIL") || "onboarding@resend.dev";
const RESEND_API_KEY = env("RESEND_API_KEY");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---- Fetch the page, bypassing Cloudflare bot-blocking -------------------
// Secret Flying's Cloudflare blocks node's built-in fetch (its TLS/HTTP
// fingerprint reads as a bot -> 403), but a normal `curl` with a browser
// User-Agent passes -> 200. curl ships with Windows 10/11 and every CI
// runner, so we shell out to it. Falls back to the free r.jina.ai reader
// proxy if curl isn't available for some reason.
// A response only counts as the real page if it contains post links —
// Cloudflare sometimes serves a bot-challenge page instead (e.g. to
// datacenter IPs like GitHub Actions runners), which is HTML but has no
// posts. In that case we fall back to the proxy.
function looksReal(html) {
  return html && html.includes("secretflying.com/posts/");
}

async function fetchPage(url) {
  try {
    const { stdout } = await execFileP(
      "curl",
      ["-sL", "--compressed", "-A", BROWSER_UA, url],
      { maxBuffer: 20 * 1024 * 1024 }
    );
    if (looksReal(stdout)) return { html: stdout, via: "curl" };
    console.warn("curl got a challenge/empty page; falling back to proxy.");
  } catch (e) {
    console.warn(`curl fetch failed (${e.message}); falling back to proxy.`);
  }

  // X-Return-Format: html makes jina return the page's raw HTML instead of
  // markdown, so the same anchor parser works for both fetch paths.
  const res = await fetch("https://r.jina.ai/" + url, {
    headers: { "User-Agent": BROWSER_UA, "X-Return-Format": "html" },
  });
  if (!res.ok) throw new Error(`Proxy fetch also failed: HTTP ${res.status}`);
  const html = await res.text();
  if (!looksReal(html)) throw new Error("Proxy returned a page with no post links.");
  return { html, via: "jina-proxy" };
}

// ---- Extract post links from the page ------------------------------------
// Secret Flying posts are anchors like:
//   <a href="https://www.secretflying.com/posts/...." rel="bookmark">TITLE</a>
// The jina proxy returns markdown links: [TITLE](https://.../posts/...)
// Handle both. Returns [{title, link}] for titles containing MATCH.
function extractPosts(html) {
  const posts = new Map(); // key by link to dedupe within the page

  // HTML anchors
  const anchorRe =
    /<a\s+[^>]*href="(https:\/\/www\.secretflying\.com\/posts\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const link = m[1];
    const title = decodeEntities(stripTags(m[2])).trim();
    if (title) posts.set(link, title);
  }

  // Markdown links (jina proxy output)
  const mdRe = /\[([^\]]+)\]\((https:\/\/www\.secretflying\.com\/posts\/[^)]+)\)/g;
  while ((m = mdRe.exec(html))) {
    const title = decodeEntities(m[1]).trim();
    const link = m[2];
    if (title && !posts.has(link)) posts.set(link, title);
  }

  const out = [];
  for (const [link, title] of posts) {
    if (title.toUpperCase().includes(MATCH)) out.push({ link, title });
  }
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8217;/g, "’")
    .replace(/&#8211;/g, "–")
    .replace(/&#8230;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ---- Seen-state (so we only email each post once) ------------------------
async function loadSeen() {
  try {
    return new Set(JSON.parse(await readFile(SEEN_FILE, "utf8")));
  } catch {
    return null; // null = file doesn't exist yet (first run)
  }
}
async function saveSeen(set) {
  await writeFile(SEEN_FILE, JSON.stringify([...set], null, 2), "utf8");
}

// ---- Email via Resend ----------------------------------------------------
async function sendEmail(posts) {
  const subject =
    posts.length === 1
      ? `🚨 New ERROR FARE: ${posts[0].title}`
      : `🚨 ${posts.length} new ERROR FARE deals`;

  const html =
    `<h2>New error fare${posts.length > 1 ? "s" : ""} on Secret Flying</h2><ul>` +
    posts
      .map((p) => `<li><a href="${p.link}">${escapeHtml(p.title)}</a></li>`)
      .join("") +
    `</ul>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: TO_EMAIL, subject, html }),
  });
  if (!res.ok) {
    throw new Error(`Resend error HTTP ${res.status}: ${await res.text()}`);
  }
  console.log(`Emailed ${posts.length} deal(s) to ${TO_EMAIL}.`);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- Main ----------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && (!RESEND_API_KEY || !TO_EMAIL)) {
    throw new Error("Set RESEND_API_KEY and TO_EMAIL env vars (or use --dry-run).");
  }

  const { html, via } = await fetchPage(PAGE_URL);
  const posts = extractPosts(html);
  console.log(`Fetched via ${via}; found ${posts.length} "${MATCH}" post(s) on the page.`);

  if (dryRun) {
    for (const p of posts) console.log(`  - ${p.title}\n    ${p.link}`);
    return;
  }

  const seen = await loadSeen();

  // First run: record everything currently on the page WITHOUT emailing,
  // so you don't get blasted with the whole backlog.
  if (seen === null) {
    await saveSeen(new Set(posts.map((p) => p.link)));
    console.log(`First run: seeded ${posts.length} existing post(s) as seen. No email sent.`);
    return;
  }

  const fresh = posts.filter((p) => !seen.has(p.link));
  if (fresh.length === 0) {
    console.log("No new error fares.");
    return;
  }

  await sendEmail(fresh);
  for (const p of fresh) seen.add(p.link);
  await saveSeen(seen);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
