// Pure-JS intent classifier for /plm-publish.
//
// Lives here (not in lib/) so the editor's install bundle is self-contained:
// run.mjs imports it via relative path, and the bundle just zips this
// directory. The matching vitest suite at lib/scaffold/intent.test.ts
// imports this same file so there's exactly ONE source of truth — drift
// between the shipped skill and the tested classifier is impossible.
//
// 把 classifier 抽到這支 .mjs,run.mjs + 測試都共用一份,避免兩個版本飄。

const EDITION_KW =
  /create\s+(new\s+)?edition(\s+template)?|new\s+edition(\s+template)?|edition\s+template|scaffold\s+edition|期刊範本|新增期刊|新刊|建立新期刊|給我期刊範本|創建新期刊/i;
const ARTICLE_KW =
  /create\s+(feature\s+)?article(\s+template)?|new\s+article|article\s+template|scaffold\s+article|single\s+article|文章範本|新增文章|新文章|典藏文章|建立新文章/i;
// Matches: 32-hex page id (bare), dashed UUID (8-4-4-4-12 hex), and notion.so/notion.com hosts.
// Previously only matched 32-hex + host strings, so a dashed UUID input
// fell through to the catch-all (which used to default to publish). The new
// classifier surfaces unmatched input as `ambiguous`, so dashed UUIDs need
// to be recognized explicitly here or editors pasting them get a needless
// dialogue.
const URL_KW =
  /[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}|notion\.so|notion\.com/;

// Bare-verb match: editor expresses publish intent without supplying a URL.
// Anchored to the start so a URL ending in "publish" doesn't trigger this
// path (URL_KW runs first anyway, but defense in depth). Matched verbs
// route to {mode:"publish", hasUrl:false} so the skill knows to prompt
// the editor for the missing URL via AskUserQuestion.
//
// Trailing lookahead `(?=\s|$)` instead of `\b` because JS regex's word-
// boundary doesn't fire after CJK characters (CJK chars aren't word-
// chars by Unicode property in non-unicode-flag regexes) — so `上稿\b`
// would fail to match the bare string "上稿". The lookahead accepts the
// verb followed by either whitespace or end-of-string, which works for
// both English and CJK alike.
//
// 編輯只打動詞(沒給 URL)→ 走「補問 URL」路徑,而不是直接報錯。
const ACTION_VERB_KW =
  /^(上稿|上傳|上線|發布|發佈|publish|ingest|上 plainlaw|publish\s+edition|publish\s+to\s+plainlaw)(?=\s|$)/i;

/**
 * Classify the editor's input into one of five intent modes:
 *
 *   { mode: "publish", hasUrl: true }
 *       — URL detected; ready to run the 5-step inspect→confirm→validate
 *         →confirm→publish flow.
 *
 *   { mode: "publish", hasUrl: false }
 *       — Editor wrote a publish verb (上稿, publish, etc.) without
 *         supplying a URL. Skill prompts for the URL, then proceeds.
 *
 *   { mode: "publish-unclear", input, extra }
 *       — URL present BUT followed by an unrecognized word (e.g. `draft`)
 *         that isn't a known publish verb. `extra` holds that leftover.
 *         Skill confirms intent (there's no draft-publish mode) instead of
 *         silently publishing live.
 *
 *   { mode: "scaffold-edition", title }
 *       — Edition-scaffold keyword. Skill previews + confirms + creates.
 *
 *   { mode: "scaffold-article", articleType, title }
 *       — Article-scaffold keyword. articleType ∈ {"default","feature"}.
 *
 *   { mode: "ambiguous", input }
 *       — Input doesn't match any of the above (random text, unrecognized
 *         phrasing). Skill asks the editor what they want via a 3-option
 *         question (上稿 / 開新一期 / 新增文章) plus free-form.
 *
 *   { mode: "empty" }
 *       — No argument at all. Skill greets and asks the same 3 options.
 *
 * URL detection wins over keywords; ambiguous falls through to a dialogue,
 * not a silent error. The classifier never throws — every input maps to
 * exactly one of the five modes.
 *
 * Bilingual: matches common English + Traditional Chinese phrasings.
 */
export function classifyIntent(arg) {
  const trimmed = (arg ?? "").trim();
  if (!trimmed) return { mode: "empty" };

  if (URL_KW.test(trimmed)) {
    // URL present. A bare URL — or a URL plus a known publish verb the editor
    // tacked on for emphasis (`<url> 上稿`, `<url> publish`) — is a clean
    // publish; the verb is noise. But a URL plus an UNRECOGNIZED word (e.g.
    // `<url> draft`) must NOT be silently reduced to publish: `draft` most
    // likely means "don't go live", and there's no draft-publish mode. Strip
    // the URL token(s) and any leading known verb; if a meaningful remainder
    // survives, surface it for clarification instead of dropping it.
    // URL + 不認得的字(例 draft)→ 不靜默發布,回 publish-unclear 讓 skill 確認。
    const extra = trimmed
      .split(/\s+/)
      .filter((tok) => !URL_KW.test(tok))
      .join(" ")
      .replace(ACTION_VERB_KW, "")
      .trim();
    if (!extra) return { mode: "publish", hasUrl: true };
    return { mode: "publish-unclear", input: trimmed, extra };
  }

  if (EDITION_KW.test(trimmed)) {
    const title = trimmed.replace(EDITION_KW, "").trim() || null;
    return { mode: "scaffold-edition", title };
  }

  if (ARTICLE_KW.test(trimmed)) {
    const articleType = /feature/i.test(trimmed) ? "feature" : "default";
    // Strip the keyword phrase AND the standalone word "feature" so the
    // remainder can be used as a draft title. Empty → server uses date.
    const title =
      trimmed
        .replace(ARTICLE_KW, "")
        .replace(/\bfeature\b/i, "")
        .trim() || null;
    return { mode: "scaffold-article", articleType, title };
  }

  if (ACTION_VERB_KW.test(trimmed)) {
    return { mode: "publish", hasUrl: false };
  }

  return { mode: "ambiguous", input: trimmed };
}
