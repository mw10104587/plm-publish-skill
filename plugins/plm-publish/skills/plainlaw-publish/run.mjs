// /plainlaw-publish skill wrapper — invoked by SKILL.md via the launcher
// (~/.claude/skills/plainlaw-publish/run.sh) on editor machines, or directly
// via `node` for Chi-An's local dev.
//
// Usage:
//   node run.mjs <notion-url-or-id>
//
// Sends Accept: application/x-ndjson and consumes the streaming response
// line-by-line, rendering each phase event as a Traditional Chinese status
// line. Editors see real-time progress instead of a black box. The wrapper
// branches on the final response shape to print either a one-line article
// result or a multi-bullet edition summary, both in Chinese.
//
// Plain-Node ESM. No tsx, no project deps, no .env.local. Reads the
// bearer from PLAINLAW_BEARER (set by the launcher on editor machines,
// or by Chi-An's shell during dev). Endpoint defaults to production;
// override with PLAINLAW_INGEST_URL for local dev.

import { classifyIntent } from "./intent.mjs";
import { formatEditionSummary } from "./summary.mjs";

// Sub-command dispatch — used by SKILL.md to drive the conversational flow:
//   node run.mjs <url-or-keyword>             → execute publish OR scaffold
//   node run.mjs inspect <url>                → read-only intent probe (publish gate 1)
//   node run.mjs validate <url>               → read-only readiness check (publish gate 2)
//   node run.mjs scaffold-preview <keyword>   → read-only "what will be created" (scaffold gate)
//   node run.mjs classify <input>             → print intent JSON only, no side effects
//
// The skill's SKILL.md orchestrates:
//   Publish path:    inspect → AskUserQuestion → validate → AskUserQuestion → execute
//   Scaffold path:   scaffold-preview → AskUserQuestion → execute
//   Bare verb / ambiguous / empty: SKILL.md uses AskUserQuestion to gather
//   missing info, then jumps into the appropriate path above.
// 子命令分流:每條路徑都有「先預覽,再確認,最後寫入」三步。
const rawArgs = process.argv.slice(2);
const subCommand = ["inspect", "validate", "scaffold-preview", "classify"].includes(
  rawArgs[0] ?? "",
)
  ? rawArgs[0]
  : null;
const urlArg = subCommand ? rawArgs[1] : rawArgs[0];

if (!urlArg && subCommand !== "classify") {
  console.error(
    "usage: run.mjs [inspect|validate|scaffold-preview|classify] <notion-url-or-id-or-keyword>",
  );
  process.exit(2);
}

// `classify` is the only subcommand that can run with no urlArg — it just
// prints the intent classification for the (possibly empty) input.
if (subCommand === "classify") {
  const intent = classifyIntent(urlArg ?? "");
  console.log(`CLASSIFY_JSON: ${JSON.stringify(intent)}`);
  process.exit(0);
}

const secret = process.env.PLAINLAW_BEARER;
if (!secret) {
  console.error(
    "找不到 bearer。請確認您是透過 plainlaw-publish 安裝包安裝此技能。\n" +
      "(PLAINLAW_BEARER environment variable is not set. The launcher script " +
      "should set this; ask Chi-An for an installation bundle if needed.)",
  );
  process.exit(2);
}

const ingestUrl =
  process.env.PLAINLAW_INGEST_URL ?? "https://plainlaw-site-mvp.vercel.app/api/ingest";
// Reader-facing site origin (no /api path) — used to build ?draft=1 preview
// links for draft content. 預覽連結用的網站根網址。
const siteBaseUrl = ingestUrl.replace(/\/api\/ingest$/, "");
const scaffoldUrl = ingestUrl.replace(/\/api\/ingest$/, "/api/scaffold");
const scaffoldPreviewUrl = ingestUrl.replace(/\/api\/ingest$/, "/api/scaffold/preview");
const inspectUrl = ingestUrl.replace(/\/api\/ingest$/, "/api/inspect");
const validateUrl = ingestUrl.replace(/\/api\/ingest$/, "/api/validate");

if (subCommand === "inspect") {
  const pageId = extractPageId(urlArg);
  await runInspect(pageId, inspectUrl, secret);
  process.exit(0);
}

if (subCommand === "validate") {
  const pageId = extractPageId(urlArg);
  await runValidate(pageId, validateUrl, secret);
  process.exit(0);
}

if (subCommand === "scaffold-preview") {
  const intent = classifyIntent(urlArg);
  if (intent.mode !== "scaffold-edition" && intent.mode !== "scaffold-article") {
    console.error(`💥 scaffold-preview 預期關鍵字(例:期刊範本 / 文章範本),收到的是:「${urlArg}」`);
    process.exit(2);
  }
  await runScaffoldPreview(intent, scaffoldPreviewUrl, secret);
  process.exit(0);
}

// Intent dispatch — URL routes to publish, keywords route to scaffold.
// Empty / ambiguous / publish-without-url modes are normally handled by
// SKILL.md (Claude asks the editor to clarify via AskUserQuestion before
// invoking this script). When this script is called directly (Chi-An's
// dev workflow), they surface as a clear usage error instead.
//
// 編輯丟連結就是上稿;丟「期刊範本 / create edition / 文章範本…」就是建範本。
const intent = classifyIntent(urlArg);
if (intent.mode === "scaffold-edition" || intent.mode === "scaffold-article") {
  await runScaffold(intent, scaffoldUrl, secret);
  process.exit(0);
}

if (intent.mode === "empty") {
  console.error("usage: run.mjs <notion-url-or-id-or-keyword> — no input given");
  process.exit(2);
}

if (intent.mode === "ambiguous") {
  console.error(
    `💥 不認得這個輸入:「${intent.input}」\n` +
      `預期是 Notion URL、或關鍵字(例:期刊範本 / 文章範本 / 上稿)。\n` +
      `若您是透過 /plainlaw-publish 呼叫,請讓 skill 透過對話補上完整意圖。`,
  );
  process.exit(2);
}

if (intent.mode === "publish" && !intent.hasUrl) {
  console.error(`💥 偵測到上稿動詞,但沒有 Notion URL。請提供 Notion 頁面的連結。`);
  process.exit(2);
}

if (intent.mode === "publish-unclear") {
  console.error(
    `💥 偵測到 Notion 連結,但後面多了不認得的字:「${intent.extra}」\n` +
      `目前沒有對應的發布選項(草稿狀態請在 Notion 的 Status 欄位設定,` +
      `?draft=1 只是網站預覽,不是上稿選項)。\n` +
      `若透過 /plainlaw-publish 呼叫,請讓 skill 與您確認意圖後再發布。`,
  );
  process.exit(2);
}

const pageId = extractPageId(urlArg);

const t0 = Date.now();
let res;
try {
  res = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Ask the server to stream phase events as NDJSON. The server falls
      // back to a single JSON body if it doesn't recognize this header
      // (older deploys), and the client below detects that and degrades.
      accept: "application/x-ndjson",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ notionPageId: pageId }),
    // Edition publishes can run 30+ seconds (4-6 articles, image rehosts).
    // 120s gives generous headroom; if it bites, the per-phase timer
    // (Sprint 2.7) tells us where the time goes.
    signal: AbortSignal.timeout(120_000),
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`💥 連線失敗:${message}`);
  process.exit(1);
}

const contentType = res.headers.get("content-type") ?? "";
const isStream = contentType.includes("application/x-ndjson");

// Hard-failure paths (auth, bad request) come back as a single JSON body
// even when we asked for a stream. Drain the body once and surface it.
if (!res.ok) {
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text };
  }
  console.error(`HTTP ${res.status}:${parsed?.error ?? text}`);
  process.exit(1);
}

let finalResult = null;
let finalError = null;

if (isStream) {
  // The server pumps one JSON event per line. Buffer chunks across newlines
  // because a single read() can split a line in half (especially with
  // multi-byte UTF-8 CJK content).
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        console.error(`⚠️  無法解析事件:${line}`);
        continue;
      }
      const handled = renderEvent(event);
      if (handled === "result") finalResult = event.result;
      if (handled === "error") finalError = event.error;
    }
  }
  // Flush any tail without a trailing newline.
  const tail = buffer.trim();
  if (tail) {
    try {
      const event = JSON.parse(tail);
      const handled = renderEvent(event);
      if (handled === "result") finalResult = event.result;
      if (handled === "error") finalError = event.error;
    } catch {
      console.error(`⚠️  無法解析結尾事件:${tail}`);
    }
  }
} else {
  // Server didn't honor the streaming Accept header (old deploy or test
  // harness). Fall back to single-shot JSON parsing.
  const text = await res.text();
  try {
    finalResult = JSON.parse(text);
  } catch {
    console.error(`💥 無法解析回應:${text}`);
    process.exit(1);
  }
}

const totalMs = Date.now() - t0;

if (finalError) {
  console.error(`💥 發布失敗:${finalError}`);
  process.exit(1);
}

if (!finalResult) {
  console.error("💥 沒有收到完整結果(伺服器回應不完整)");
  process.exit(1);
}

console.log("");
console.log("─────────────────────────────────");

if (isAuthorResult(finalResult)) {
  console.log(`✅ 作者頁已更新 — ${finalResult.path}`);
  if (finalResult.headshotRehosted) {
    console.log(`   大頭照已重新上傳至 Vercel Blob`);
  }
  if (Array.isArray(finalResult.warnings)) {
    for (const w of finalResult.warnings) {
      console.log(`   ⚠️  ${w}`);
    }
  }
  console.log(`   耗時 ${(totalMs / 1000).toFixed(1)} 秒`);
  process.exit(0);
}

if (isArticleResult(finalResult)) {
  // Single standalone (典藏) article. Report honestly by status: a 下架
  // (archived) or 草稿 (draft) article was synced but is NOT on the live
  // site, so its /article/<slug> would 404 — never print it as a green ✓
  // with a dead link (same discipline as the per-article edition summary).
  // 單篇典藏:依狀態誠實回報,下架/草稿不印出會 404 的連結。
  if (finalResult.status === "archived") {
    console.log(`⊘ 已下架(不會出現在典藏):『${finalResult.title}』`);
  } else if (finalResult.status === "draft") {
    console.log(
      `◌ 草稿(預覽):${siteBaseUrl}${finalResult.path}?draft=1 — 『${finalResult.title}』`,
    );
    console.log(`   尚未公開;在 Notion 把 Status 設為「已發布」後重發即上線到典藏。`);
  } else {
    const embedNote =
      finalResult.embedded === "created"
        ? "  ⟲ 已更新語意搜尋向量"
        : finalResult.embedded === "failed"
          ? "  (語意向量稍後自動補上)"
          : "";
    console.log(`✅ 單篇文章已發布到典藏 — ${siteBaseUrl}${finalResult.path}${embedNote}`);
  }
  if (Array.isArray(finalResult.warnings)) {
    for (const w of finalResult.warnings) {
      console.log(`   ⚠️  ${w}`);
    }
  }
  console.log(`   耗時 ${(totalMs / 1000).toFixed(1)} 秒`);
  process.exit(0);
}

if (isEditionResult(finalResult)) {
  // Categorize + format in one pure place (summary.mjs) so 下架/草稿 are
  // reported honestly — never as a ✓ success with a 404 link, never as "跳過".
  for (const line of formatEditionSummary(finalResult, (totalMs / 1000).toFixed(1), siteBaseUrl)) {
    console.log(line);
  }
  // Partial failures still exit 0 so the user sees the bullet summary
  // and can retry just the failed page IDs. Hard failures (HTTP 4xx/5xx)
  // exited above.
  process.exit(0);
}

console.error("⚠️  收到非預期的回應格式");
process.exit(1);

/**
 * Render a single phase event as a Traditional Chinese status line on stdout.
 * Returns "result" if the event carries the final IngestResult, "error" if
 * the event signals pipeline failure, or undefined otherwise.
 */
function renderEvent(event) {
  if (!event || typeof event !== "object") return;
  switch (event.phase) {
    case "detect":
      console.log(`🔗 偵測到 Notion 連結 (${shortId(event.notionPageId)}…),正在連線…`);
      return;
    case "mode":
      if (event.mode === "author") {
        console.log(`👤 確認為作者頁:『${event.title}』(同步 bio + 大頭照)`);
      } else if (event.mode === "article") {
        const typeLabel = event.articleType === "feature" ? "Feature 互動" : "一般";
        console.log(`📄 確認為單篇文章(${typeLabel}):『${event.title}』(發布到典藏)`);
      } else {
        console.log(
          `📚 確認為第 ${event.editionNumber} 期:『${event.title}』(共 ${event.articleCount} 篇文章)`,
        );
      }
      return;
    case "article_start":
      console.log(`⏳ [${event.index}/${event.total}] 上傳中:『${event.title}』…`);
      return;
    case "article_done":
      // Tell the truth per article: a 下架 (archived) or 草稿 (draft) article
      // was synced but is NOT on the live site, so its /article/<slug> would
      // 404 — don't print it as a green ✓ with a dead link.
      // 下架/草稿雖同步但不在上線版本,別印出會 404 的連結。
      if (event.status === "archived") {
        console.log(
          `⊘ [${event.index}/${event.total}] 已下架(不會出現在上線版本):『${event.title}』`,
        );
      } else if (event.status === "draft") {
        // Draft is synced but off the live site — hand the editor the
        // ?draft=1 preview link so they can review it. 附預覽連結讓編輯能看草稿。
        console.log(
          `◌ [${event.index}/${event.total}] 草稿(預覽):${siteBaseUrl}${event.path}?draft=1 — 『${event.title}』`,
        );
      } else {
        // Note when a semantic-search vector was (re)generated for this article,
        // so the editor knows search was kept in sync. A failed embed is shown
        // as a warning below (the array pushed by the pipeline), not here.
        // 標註是否重新建立了語意搜尋向量,讓編輯知道搜尋已同步。
        const embedNote =
          event.embedded === "created"
            ? "  ⟲ 已更新語意搜尋向量"
            : event.embedded === "failed"
              ? "  (語意向量稍後自動補上)"
              : "";
        console.log(`✅ [${event.index}/${event.total}] 完成:${event.path}${embedNote}`);
      }
      // Per-article warnings: surfaced so the editor sees non-fatal issues
      // (unknown author chip, unsupported block fallback, etc.) without
      // needing to dig in server logs.
      // 非致命警告:讓編輯直接看到不認識的作者、unsupported block 等問題。
      if (Array.isArray(event.warnings)) {
        for (const w of event.warnings) {
          console.log(`   ⚠️  ${w}`);
        }
      }
      return;
    case "article_error":
      console.log(`❌ [${event.index}/${event.total}] 失敗:『${event.title}』 — ${event.error}`);
      return;
    case "complete":
      return "result";
    case "error":
      return "error";
    default:
      // Forward-compat: don't crash if the server emits a phase the client
      // doesn't know yet — print a generic line so the editor still sees
      // *something* and we can debug from the log.
      console.log(`ℹ️  ${JSON.stringify(event)}`);
      return;
  }
}

function shortId(id) {
  return typeof id === "string" ? id.replace(/-/g, "").slice(0, 8) : "?";
}

/**
 * Notion URLs end in a 32-char hex page id, sometimes with dashes. Match
 * either form anywhere in the input. If the input is already a raw id
 * (with or without dashes), the same regexes catch it.
 *
 * Database/data-source URLs have the shape
 *   https://app.notion.com/p/<dsId>?v=<viewId>&p=<pageId>&pm=s
 * where the FOCUSED page (the one the user clicked) is the `p=` query
 * param, not the leading path segment. We prefer `p=<id>` so editors can
 * paste the link straight from Notion's "Copy link to view" without
 * accidentally syncing the wrong row.
 *
 * The dashed/undashed fallbacks remain for plain page URLs
 * (https://www.notion.so/<slug>-<32hex>) and raw IDs.
 */
function extractPageId(input) {
  const trimmed = input.trim();

  // 1. Prefer `?p=<32-hex>` (database row inside a view URL).
  const pParam = trimmed.match(/[?&]p=([a-fA-F0-9-]{32,36})\b/);
  if (pParam?.[1]) return toDashed(pParam[1]);

  // 2. Dashed UUID anywhere in the input.
  const dashed = trimmed.match(
    /[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/,
  );
  if (dashed) return dashed[0];

  // 3. Bare 32-hex anywhere in the input.
  const undashed = trimmed.match(/[a-fA-F0-9]{32}/);
  if (undashed) return toDashed(undashed[0]);

  console.error(`could not extract Notion page id from:${input}`);
  process.exit(2);
}

function toDashed(id) {
  const bare = id.replace(/-/g, "");
  if (bare.length !== 32) return id;
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
}

function isEditionResult(x) {
  return typeof x === "object" && x !== null && x.mode === "edition" && Array.isArray(x.articles);
}

function isAuthorResult(x) {
  return typeof x === "object" && x !== null && x.mode === "author" && typeof x.path === "string";
}

function isArticleResult(x) {
  return typeof x === "object" && x !== null && x.mode === "article" && typeof x.path === "string";
}

/**
 * Read-only inspection — does NOT write to DB or Notion.
 *
 * Prints two things:
 *   1. A Chinese summary card the editor can read directly in the terminal.
 *   2. A single machine-readable line `INSPECT_JSON: <one-line-json>` that
 *      Claude's skill orchestration (SKILL.md) parses to drive the
 *      AskUserQuestion confirmation gate.
 *
 * The JSON line is the contract — keep it parseable + on a single line.
 * Don't break it across multiple lines or add prose suffixes.
 *
 * 列印給編輯看的卡片 + 給 Claude 解析的 JSON 標記行;後者是固定格式。
 */
async function runInspect(pageId, url, secret) {
  console.log(`🔍 正在檢查 Notion 頁面 (${shortId(pageId)}…) …`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ notionPageId: pageId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`💥 連線失敗:${message}`);
    process.exit(1);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`💥 無法解析回應:${text}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`💥 HTTP ${res.status}:${json.error ?? JSON.stringify(json)}`);
    process.exit(1);
  }

  console.log("");
  console.log("─────────────────────────────────");
  renderInspectionCard(json);
  console.log("─────────────────────────────────");
  // Single machine-readable line for Claude to parse. Keep on one line.
  console.log(`INSPECT_JSON: ${JSON.stringify(json)}`);
}

function renderInspectionCard(insp) {
  if (insp.kind === "edition") {
    const n = insp.notion;
    const d = insp.deployed;
    const titleLine =
      n.number != null
        ? `📚 第 ${n.number} 期「${n.title}」`
        : `📚 期刊「${n.title}」(尚未設定期數)`;
    console.log(titleLine);
    if (d.present) {
      console.log(`   已上線:${d.path}`);
      if (d.publishedAt) console.log(`   首次發布:${formatDate(d.publishedAt)}`);
      if (d.lastSyncedAt) console.log(`   上次同步:${formatDate(d.lastSyncedAt)}`);
      if (insp.isStale) {
        console.log(`   ⚠️ Notion 上有未同步變更(${formatDate(n.lastEditedAt)})`);
      } else {
        console.log(`   ✓ 與 Notion 同步`);
      }
    } else {
      console.log(`   未上線 — 此為首次發布`);
    }
    console.log(
      `   ${n.articleCount} 篇文章` +
        (n.archivedCount > 0
          ? `,其中 ${n.archivedCount} 篇已封存(發布後會下架,不會出現在上線版本)`
          : ""),
    );
    return;
  }

  if (insp.kind === "author") {
    const n = insp.notion;
    const d = insp.deployed;
    console.log(`👤 作者「${n.name}」`);
    if (d.present) {
      console.log(`   已上線:${d.path}`);
      if (d.lastSyncedAt) console.log(`   上次同步:${formatDate(d.lastSyncedAt)}`);
      if (insp.isStale) {
        console.log(`   ⚠️ Notion 上有未同步變更(${formatDate(n.lastEditedAt)})`);
      } else {
        console.log(`   ✓ 與 Notion 同步`);
      }
    } else {
      console.log(`   未上線 — 此為首次發布`);
    }
    if (n.headshotFileCount === 0) {
      console.log(`   ⚠️ 大頭照尚未上傳`);
    } else if (n.headshotFileCount > 1) {
      console.log(`   ⚠️ Headshot 屬性有 ${n.headshotFileCount} 個檔案;發布時會取最上面那張`);
    }
    return;
  }

  if (insp.kind === "article") {
    const n = insp.notion;
    const d = insp.deployed;
    console.log(`📄 文章「${n.title}」(${n.articleType})`);
    if (d.present) {
      console.log(`   已上線:${d.path}`);
      if (d.editionNumber != null) console.log(`   屬於第 ${d.editionNumber} 期`);
      if (d.lastSyncedAt) console.log(`   上次同步:${formatDate(d.lastSyncedAt)}`);
      if (insp.isStale) {
        console.log(`   ⚠️ Notion 上有未同步變更(${formatDate(n.lastEditedAt)})`);
      }
    } else {
      console.log(`   未上線`);
    }
    const edNum = n.editionNumber ?? d.editionNumber ?? null;
    if (n.editionPageId) {
      // Edition-linked → not directly publishable; route to the edition.
      const ref =
        edNum != null ? `第 ${edNum} 期` : n.editionTitle ? `《${n.editionTitle}》` : "所屬期刊";
      console.log(`   ⚠️ 這篇文章屬於${ref},請改為發布所屬期刊(貼上該期 Edition row 連結)。`);
    } else {
      // Standalone (典藏) → directly publishable to /archive.
      console.log(`   ✓ 這是一篇單篇文章(未連結期刊),可直接發布到典藏(/archive)。`);
    }
    return;
  }

  if (insp.kind === "unknown") {
    console.log(`❓ 無法辨識的 Notion 頁面`);
    console.log(`   ${insp.reason}`);
    return;
  }
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

/**
 * Read-only readiness check — does NOT write.
 *
 * Same wire shape as runInspect:
 *   1. Chinese summary card the editor can read directly.
 *   2. A single `VALIDATE_JSON: <one-line-json>` marker line for Claude
 *      to parse and drive the strict gate (blockers stop, warnings
 *      prompt, all-green auto-proceed).
 *
 * 列印 readiness 卡 + 給 Claude 解析的 JSON 標記行。
 */
async function runValidate(pageId, url, secret) {
  console.log(`🔬 正在檢查內容是否齊全 (${shortId(pageId)}…) …`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ notionPageId: pageId }),
      // Validate walks every article + checks every author + reads
      // feature article blocks. 60s headroom for big editions.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`💥 連線失敗:${message}`);
    process.exit(1);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`💥 無法解析回應:${text}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`💥 HTTP ${res.status}:${json.error ?? JSON.stringify(json)}`);
    process.exit(1);
  }

  console.log("");
  console.log("─────────────────────────────────");
  renderValidationCard(json);
  console.log("─────────────────────────────────");
  console.log(`VALIDATE_JSON: ${JSON.stringify(json)}`);
}

function renderValidationCard(v) {
  if (v.kind === "unknown") {
    console.log(`❓ 無法辨識的 Notion 頁面`);
    console.log(`   ${v.reason}`);
    return;
  }

  if (v.kind === "edition") {
    const live = v.articles.filter((a) => !a.archived);
    const archived = v.articles.filter((a) => a.archived);
    const ready = live.filter((a) => a.blockers.length === 0 && a.warnings.length === 0);
    const warned = live.filter((a) => a.blockers.length === 0 && a.warnings.length > 0);
    const broken = live.filter((a) => a.blockers.length > 0);

    if (v.ok && v.warnings.length === 0) {
      console.log(`✅ 整期皆可發布(${live.length} 篇,全部 ready)`);
    } else if (v.ok) {
      console.log(`⚠️  整期可發布,但有 ${v.warnings.length} 項警告`);
    } else {
      console.log(`❌ 本期無法上線:${v.blockers.length} 項必須先修`);
    }

    if (archived.length > 0) {
      console.log("");
      console.log(`已封存(發布後會下架,不會出現在上線版本):`);
      for (const a of archived) {
        console.log(`   ⊘ ${a.title}`);
      }
    }

    if (broken.length > 0) {
      console.log("");
      console.log(`❌ 缺要件,擋住整期:`);
      for (const a of broken) {
        console.log(`   • ${a.title}`);
        for (const b of a.blockers) {
          console.log(`       — ${b.field}:${b.message}`);
        }
      }
    }

    if (warned.length > 0) {
      console.log("");
      console.log(`⚠️  有警告(可繼續發布):`);
      for (const a of warned) {
        console.log(`   • ${a.title}`);
        for (const w of a.warnings) {
          console.log(`       — ${w.field}:${w.message}`);
        }
      }
    }

    if (ready.length > 0 && (broken.length > 0 || warned.length > 0)) {
      console.log("");
      console.log(`✓ ${ready.length} 篇 ready`);
    }

    // Edition-level issues (its own Number / Title)
    if (v.blockers.some((b) => !b.notionPageId)) {
      console.log("");
      console.log(`❌ 期刊欄位問題:`);
      for (const b of v.blockers.filter((b) => !b.notionPageId)) {
        console.log(`   — ${b.field}:${b.message}`);
      }
    }
    return;
  }

  if (v.kind === "article" || v.kind === "author") {
    if (v.ok && v.warnings.length === 0) {
      console.log(`✅ 可發布(無問題)`);
    } else if (v.ok) {
      console.log(`⚠️  可發布,但有 ${v.warnings.length} 項警告`);
    } else {
      console.log(`❌ 無法發布:${v.blockers.length} 項必須先修`);
    }
    if (v.blockers.length > 0) {
      console.log("");
      console.log(`❌ 必修:`);
      for (const b of v.blockers) console.log(`   — ${b.field}:${b.message}`);
    }
    if (v.warnings.length > 0) {
      console.log("");
      console.log(`⚠️  警告:`);
      for (const w of v.warnings) console.log(`   — ${w.field}:${w.message}`);
    }
    return;
  }
}

/**
 * Read-only scaffold preview — does NOT write.
 *
 * Prints a Chinese preview card describing what scaffold WOULD create
 * (for edition: "next is 第 17 期 because previous is 第 16 期"; for
 * article: type + title) and a SCAFFOLD_PREVIEW_JSON marker line for
 * Claude to parse and drive the AskUserQuestion confirmation gate.
 *
 * 預覽 scaffold 即將建立什麼;Claude 拿到 JSON 後才呼叫真正的 /api/scaffold。
 */
async function runScaffoldPreview(intent, url, secret) {
  const body =
    intent.mode === "scaffold-edition"
      ? { kind: "edition", title: intent.title }
      : { kind: "article", articleType: intent.articleType, title: intent.title };
  console.log(`🔍 預覽即將建立的草稿…`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`💥 連線失敗:${message}`);
    process.exit(1);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`💥 無法解析回應:${text}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`💥 HTTP ${res.status}:${json.error ?? JSON.stringify(json)}`);
    process.exit(1);
  }

  console.log("");
  console.log("─────────────────────────────────");
  renderScaffoldPreviewCard(json);
  console.log("─────────────────────────────────");
  console.log(`SCAFFOLD_PREVIEW_JSON: ${JSON.stringify(json)}`);
}

function renderScaffoldPreviewCard(p) {
  if (p.kind === "edition") {
    console.log(`🪄 即將建立期刊範本`);
    console.log("");
    if (p.previousNumber == null) {
      console.log(`   ➜ 這會是第 ${p.nextNumber} 期(目前還沒有任何已上線的期刊)`);
    } else {
      console.log(`   ➜ 這會是第 ${p.nextNumber} 期(目前最新已上線:第 ${p.previousNumber} 期)`);
    }
    if (p.title) {
      console.log(`   標題:${p.computedTitle}`);
    } else {
      console.log(`   標題:${p.computedTitle}(沒帶主題,純編號)`);
    }
    console.log("");
    console.log(`   會在 Notion 上新增:`);
    console.log(`      • 1 個 Edition row(Status=draft)`);
    console.log(
      `      • ${p.structure.defaultArticles} 篇一般文章(linked,Order 1..${p.structure.defaultArticles},Status=draft)`,
    );
    console.log(
      `      • ${p.structure.featureArticles} 篇 feature 文章(linked,Order ${p.structure.defaultArticles + 1},Status=draft)`,
    );
    return;
  }

  if (p.kind === "article") {
    const typeLabel = p.articleType === "feature" ? "Feature(HTML 互動)" : "default(典藏)";
    console.log(`🪄 即將建立文章範本`);
    console.log("");
    console.log(`   類型:${typeLabel}`);
    if (p.title) {
      console.log(`   標題:${p.computedTitle}`);
    } else {
      console.log(`   標題:${p.computedTitle}(沒帶標題,系統用日期)`);
    }
    console.log("");
    console.log(`   會在 Notion 上新增:`);
    console.log(`      • 1 篇 Article row(無 Edition 關聯,Status=draft)`);
    return;
  }
}

async function runScaffold(intent, url, secret) {
  const body =
    intent.mode === "scaffold-edition"
      ? { kind: "edition", title: intent.title }
      : { kind: "article", articleType: intent.articleType, title: intent.title };
  console.log(
    intent.mode === "scaffold-edition"
      ? `🪄 建立新期刊範本${intent.title ? `:「${intent.title}」` : ""}…`
      : `🪄 建立${intent.articleType === "feature" ? "Feature " : ""}文章範本 (典藏)…`,
  );
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({ error: "non-JSON response" }));
  if (!res.ok) {
    console.error(`💥 HTTP ${res.status}:${json.error ?? JSON.stringify(json)}`);
    process.exit(1);
  }
  console.log("");
  console.log("─────────────────────────────────");
  if (json.kind === "edition") {
    console.log(`✅ 第 ${json.edition.number} 期範本已建立`);
    console.log(`   📄 ${json.edition.url}`);
    for (const a of json.articles) {
      const tag = a.articleType === "feature" ? "⭐" : "  ";
      console.log(`   ${tag} ${a.title}\n      ${a.url}`);
    }
  } else {
    const a = json.articles[0];
    console.log(`✅ ${a.articleType === "feature" ? "Feature " : ""}文章範本已建立 (典藏)`);
    console.log(`   📄 ${a.url}`);
  }
  console.log(`   耗時 ${(json.durationMs / 1000).toFixed(1)} 秒`);
}
