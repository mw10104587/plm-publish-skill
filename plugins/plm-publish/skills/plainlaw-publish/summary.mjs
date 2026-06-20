// Pure categorizer + formatter for an edition publish result. Kept dependency-
// free (plain ESM) so run.mjs can import it on editor machines AND the vitest
// suite can import it directly to lock the behavior down.
//
// The bug this guards against: an `archived` article is written to the DB but
// excluded from the live site, so /article/<slug> 404s. The wrapper used to
// print it as a green ✓ success with that dead link. The truth is it was 下架
// (taken off the live site) — which is NEITHER a success NOR a "skip". This
// module splits the result so the wrapper can say so.
//
// 把整期發布結果分類:已上線 / 下架 / 草稿 / 失敗。
// 「下架」不是「成功」也不是「跳過」—— 它會從上線版本移除,且連結會 404。

/**
 * @typedef {Object} EditionArticle
 * @property {boolean} ok
 * @property {string} [status]   "published" | "archived" | "draft"
 * @property {string} [path]
 * @property {string} [title]
 * @property {string} [notionPageId]
 * @property {string} [error]
 */

/**
 * Split an edition result's articles into display buckets by outcome.
 * A success with status "published" (or missing, for back-compat with older
 * servers that don't emit status) is live; "archived" is 下架; "draft" is
 * a non-live draft; !ok is a failure.
 *
 * @param {EditionArticle[]} articles
 */
export function categorizeEditionArticles(articles) {
  const live = [];
  const takenDown = [];
  const draft = [];
  const failed = [];
  for (const a of articles ?? []) {
    if (!a.ok) {
      failed.push(a);
    } else if (a.status === "archived") {
      takenDown.push(a);
    } else if (a.status === "draft") {
      draft.push(a);
    } else {
      live.push(a);
    }
  }
  return { live, takenDown, draft, failed };
}

/**
 * Build a `?draft=1` preview URL for a draft item from its relative path.
 * Draft content 404s on its normal URL, so the editor needs the preview link
 * to review it. Falls back to a bare relative path + ?draft=1 if no base URL
 * was threaded in (older callers).
 *
 * 草稿在正常網址會 404,要附 ?draft=1 預覽連結讓編輯能看。
 *
 * @param {string} path        relative path, e.g. "/article/foo" or "/edition/20"
 * @param {string} [siteBaseUrl]  e.g. "https://plainlaw-site-mvp.vercel.app"
 */
function previewUrl(path, siteBaseUrl) {
  return `${siteBaseUrl ?? ""}${path}?draft=1`;
}

/**
 * Build the editor-facing summary lines for an edition publish. Pure: returns
 * an array of strings the caller prints.
 *
 * A draft edition (editionStatus === "draft") is NOT live, so it gets a
 * 草稿 · 預覽 header with a ?draft=1 preview link instead of "已發布". Draft
 * articles (held back inside an otherwise-published edition) get the same
 * preview link rather than a dead /article/<slug> that 404s. 下架 is listed
 * without a link and counted separately — never folded into 成功 or "跳過".
 *
 * @param {{ editionNumber: number, path: string, editionStatus?: string, articles: EditionArticle[] }} result
 * @param {string} totalSeconds  already-formatted elapsed seconds, e.g. "4.6"
 * @param {string} [siteBaseUrl]  base site URL for building preview links
 */
export function formatEditionSummary(result, totalSeconds, siteBaseUrl) {
  const { live, takenDown, draft, failed } = categorizeEditionArticles(result.articles);
  const lines = [];
  if (result.editionStatus === "draft") {
    lines.push(
      `📝 第 ${result.editionNumber} 期(草稿,尚未上線)— 預覽:${previewUrl(result.path, siteBaseUrl)}`,
    );
  } else {
    lines.push(`✅ 第 ${result.editionNumber} 期已發布 — ${result.path}`);
  }

  for (const a of live) lines.push(`   ✓ ${a.path}   ${a.title}`);
  for (const a of takenDown) lines.push(`   ⊘ 已下架(已從上線版本移除):${a.title}`);
  for (const a of draft)
    lines.push(`   ◌ 草稿(預覽):${previewUrl(a.path, siteBaseUrl)} — ${a.title}`);
  for (const a of failed) lines.push(`   ✗ ${a.notionPageId}   ${a.error}`);

  // Count line — 下架 / 草稿 are deliberately NOT counted as 成功, and the
  // word 跳過 never appears: archived means actively taken off the live site.
  const parts = [`${live.length} 篇上線`];
  if (takenDown.length > 0) parts.push(`${takenDown.length} 篇下架`);
  if (draft.length > 0) parts.push(`${draft.length} 篇草稿`);
  if (failed.length > 0) parts.push(`${failed.length} 篇失敗`);
  lines.push(
    `   共 ${(result.articles ?? []).length} 篇,耗時 ${totalSeconds} 秒 (${parts.join(", ")})`,
  );
  return lines;
}
