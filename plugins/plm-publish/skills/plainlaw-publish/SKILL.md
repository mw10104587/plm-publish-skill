---
name: plainlaw-publish
description: |
  Publish a Notion page to plainlaw.me. The pipeline auto-detects whether
  the page is a whole edition (parent page with child article pages
  underneath) or a single article. Use when the user wants to "publish",
  "上稿", "ingest", "上線", "上 plainlaw", "publish edition" /
  "publish this article". Always go through this skill — never curl
  /api/ingest directly; the skill handles ID extraction and bearer auth.
allowed-tools:
  - Bash
  - AskUserQuestion
  - Read
triggers:
  - 上稿
  - publish edition
  - publish to plainlaw
  - publish this notion page
  - publish this article
  - 上 plainlaw
  - ingest notion
---

# /plainlaw-publish

Publish OR scaffold via plainlaw. ONE input — a Notion URL **or** a
template keyword — and the wrapper dispatches:

**Publish** (URL input) — the existing flow. Re-syncs an Edition DS row,
an Author DS row, or a standalone Article DS row. Three sub-modes
(handled by /api/ingest):

- **Edition** — Edition DS row. Re-syncs edition + every linked article
  - every author those articles cite.
- **Author** — Author DS row. Re-syncs bio, social URL, re-hosts the
  headshot to Vercel Blob.
- **Article (單篇典藏)** — a standalone Article DS row (NO Edition
  relation). Re-syncs that one article (default or feature) into the 典藏
  archive (`/archive`), syncing its byline authors too. An Article row that
  IS linked to an edition is refused — publish the edition instead.

**Scaffold** (keyword input) — bilingual. Creates fresh Notion DS rows
ready for the editor to fill in. No publish yet; that comes later.

- `create edition template` / `期刊範本` / `新刊` → one Edition row +
  5 default Article rows + 1 feature Article row, all linked, Status=draft,
  Order=1..6. Anything after the keyword becomes the issue title; empty is
  fine (editor renames in Notion).
- `create article template` / `文章範本` / `典藏文章` → one standalone
  Article row, no Edition relation. Add the word "feature" anywhere to
  scaffold a feature-type article instead of default.

Anything outside those modes throws a clear error today. Single-article
(典藏) **publishing** is live: scaffold creates the standalone row, fill
it in, then publish its URL to push it to `/archive`.

## Language — ALWAYS reply in Traditional Chinese (繁中)

PLM editors are the audience and they do **not** want English. Every
human-facing line you write while running this skill — narration between
tool calls ("正在檢查…", "驗證通過,正在發布…"), `AskUserQuestion` prompts
and option labels, the inspect/validate/publish summaries you relay, and
any error or punch-list — MUST be in Traditional Chinese. Notion page
titles, slugs, IDs, URLs, and CLI commands stay verbatim. Do not narrate
your reasoning in English ("Inspect confirms…", "Running validation…");
write it in 繁中 ("檢查完成…", "開始驗證…"). This applies to the whole
flow, not just the cards the scripts print.

## Steps (conversational dispatch — every path has a confirm gate)

This skill is a **conversation**, not a parser. Read the editor's input,
classify it into one of five intent modes, and either dispatch directly
(if the intent is complete) or **ask one targeted question to complete
it** before any write happens. Never silently fail on partial input.

### 0. Resolve paths + verify install (once per session)

The helper script `run.mjs` ships inside this skill. Depending on how the
editor installed it, it lives EITHER under `~/.claude/skills/` (copied as a
normal skill folder) OR under the plugin marketplace cache. Resolve it once
and reuse the printed path (`$RUN`) in every command below. Also confirm the
publish key is set. 一次解析腳本路徑 + 確認金鑰,之後每個指令都用同一個 `$RUN`。

```bash
RUN=$(ls ~/.claude/skills/plainlaw-publish/run.mjs 2>/dev/null \
  || find ~/.claude/plugins/cache -path '*/skills/plainlaw-publish/run.mjs' 2>/dev/null | head -1)
test -n "$RUN"             && echo "RUN=$RUN" || echo "MISSING_SKILL"
test -n "$PLAINLAW_BEARER" && echo "BEARER_OK" || echo "MISSING_BEARER"
```

Read the output and branch:

- **`MISSING_SKILL`** (no path found): the skill isn't installed. Tell the
  editor _"我這邊還沒看到 plainlaw-publish 的安裝。請先請 Chi-An 給您安裝
  連結,照著把工具裝好後再回來。"_ and stop.
- **`MISSING_BEARER`** ($RUN found but no key): the script is installed but the
  publish key isn't set in this shell. Offer to set it up **without ever putting
  the key into our chat** (Option B): tell the editor _"工具裝好了,但還少一把
  發布金鑰。我可以幫您在 `~/.zshrc` 開好一行 `export PLAINLAW_BEARER=\"\"`,
  您再把 Chi-An 給您的金鑰**貼進引號中間**(不要貼到這個對話框),存檔後重開
  終端機即可。要我幫您開好那一行嗎?"_ If they agree, append
  `export PLAINLAW_BEARER=""` to `~/.zshrc` (leave the value EMPTY — the editor
  fills it in themselves), then stop and ask them to paste their key into the
  blank, save, and restart the terminal. **Never write the key value yourself;
  never ask them to paste it into this conversation.**
- **Both OK** (`RUN=…` + `BEARER_OK`): proceed to step 1.

In every command in the steps below, `$RUN` means the path printed here.
Reuse that same absolute path; re-resolve only if a later command reports
the file is missing.

### 1. Classify the editor's input

The editor's argument (after `/plainlaw-publish`) falls into one of:

| Input shape                                                                                            | Intent mode                              | What to do                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| Notion URL or 32-hex page id (with or without a trailing _known_ verb like `上稿` / `publish`)         | `publish, hasUrl:true`                   | Go to **Publish path** (§A)               |
| Notion URL + an _unrecognized_ trailing word (e.g. `<url> draft`)                                      | `publish-unclear`                        | **Confirm intent** (§B3) before any write |
| Bare publish verb only: `上稿`, `上傳`, `上線`, `發布`, `publish`, `ingest`                            | `publish, hasUrl:false`                  | **Ask for URL** (§B1), then jump into §A  |
| Scaffold keyword: `期刊範本`, `新刊`, `文章範本`, `典藏文章`, `create edition`, `create article`, etc. | `scaffold-edition` or `scaffold-article` | Go to **Scaffold path** (§C)              |
| Empty (no arg)                                                                                         | `empty`                                  | **Greet and ask** (§B2), then dispatch    |
| Anything else (random text, unrecognized phrase)                                                       | `ambiguous`                              | **Ask to clarify** (§B2), then dispatch   |

You can pattern-match this yourself from the editor's input — the rules
are simple. If you want a deterministic answer, run:

```bash
node "$RUN" classify "$EDITOR_INPUT"
```

This prints `CLASSIFY_JSON: {...}` with the same shape the script uses
internally. No side effects, useful when intent is genuinely unclear.

---

### §A Publish path (Notion URL → 5 steps, both gates fire)

Run the gates in order. Never skip a gate. Never proceed past a gate
without the editor's explicit answer. **Every run starts with a fresh
`inspect` (A1) — never carry a previous run's status forward; the editor
may have changed Notion seconds ago.**

**A1. INSPECT (read-only).**

```bash
node "$RUN" inspect "$NOTION_URL"
```

Script prints a Chinese summary card + `INSPECT_JSON: {...}` line.
Parse the JSON: it carries `kind` (edition / author / article / unknown),
whether the page is already deployed, and `isStale`.

> **ALWAYS REFETCH — never reuse a prior inspect.** Run this `inspect`
> command **fresh on every single invocation**, even if you (or an earlier
> turn in the same session) already inspected the same URL seconds ago.
> NEVER answer the confirm gate from a remembered `INSPECT_JSON` — re-run
> the command and read the new output. This skill's whole job is firing
> updates: editors edit Notion and re-run within seconds, so `Status`,
> `articleCount`, `archived`, and `lastEditedAt` routinely change between
> two back-to-back runs. A stale read silently publishes the wrong thing
> (e.g. publishing as `published` when the editor just flipped it to
> `draft`). If the editor re-runs after editing, treat that as a signal
> that the page changed and re-inspect. Re-running `inspect` is read-only
> and cheap — there is never a reason to skip it.

**A2. GATE 1 — confirm intent (`AskUserQuestion`).**

- `kind: "unknown"` → **stop**. Tell the editor the `reason` verbatim
  and suggest pasting a DS row URL. Do not ask a question.
- `kind: "article"` → branch on `directPublishSupported` (= standalone or not):
  - **Edition-linked** (`directPublishSupported: false`, `notion.editionPageId`
    set) → **stop**. Single-article publish is refused for edition members
    (publishing one in isolation would half-sync the edition). Relay the inspect
    card's message verbatim: _"這篇文章屬於第 N 期,請改為發布所屬期刊(貼上該期
    Edition row 連結)。"_ (N from `notion.editionNumber`, falling back to
    `notion.editionTitle`.) Do not ask a question.
  - **Standalone 典藏** (`directPublishSupported: true`, `editionPageId` null) →
    this IS publishable to /archive. Treat it exactly like the edition/author
    confirm gate below (same first-time / fresh / stale options), then continue
    to **A3 (validate)**. Mention it publishes to 典藏 (`/archive`), not the home
    page. Draft-by-default still applies: a standalone article with no `Status`
    (or `Status: draft`) syncs as a draft preview — warn like the edition case.
- `kind: "edition"` or `kind: "author"`: ask the editor — options:
  - First-time (`deployed.present: false`): `[繼續]` / `[取消]`
  - Re-publish, fresh (`isStale: false`): `[仍要重新同步(目前無變更)]` / `[取消]`
  - Re-publish, stale (`isStale: true`): `[繼續(會更新上線版本)]` / `[取消]`

**Draft-by-default warning (edition mode).** Publishing now defaults to **draft**:
an edition goes live ONLY when its Notion `Status` is explicitly `published`. If
`INSPECT_JSON`'s `notion.status` is empty/`null` or `draft`, tell the editor in
the confirm prompt (繁中), so they're not surprised that nothing went public:

> 這期的 Status 沒有設成 `published`,會以**草稿**發布(僅預覽、不會上線)。
> 發布後我會給您 `?draft=1` 預覽連結。要正式上線,請先在 Notion 把該期
> `Status` 設為 `published` 再重跑。仍要以草稿發布嗎?

(They can proceed — draft publish is valid and gives a preview link — or cancel,
set `Status: published` in Notion, and re-run.)

Cancel → stop, no further action.

**A3. VALIDATE (read-only readiness check).**

```bash
node "$RUN" validate "$NOTION_URL"
```

Script prints a readiness card + `VALIDATE_JSON: {...}` line. Three
outcomes by `ok` / `blockers` / `warnings`:

- **All green** (`ok: true`, no warnings): auto-proceed to A5. Briefly
  tell the editor _"驗證通過,正在發布…"_ — no AskUserQuestion needed.
- **Warnings only** (`ok: true`, warnings ≥ 1): AskUserQuestion
  `[仍發布(忽略警告)]` / `[修好再來]`. 仍發布 → A5. 修好再來 → stop.
- **Blockers** (`ok: false`): **strict-stop. Do NOT prompt for force.**
  Show the punch list verbatim and surface two escape hatches:
  1. Fix the offending field(s) in Notion, then re-run.
  2. For editions with one bad article: set that article's
     `Status = archived` in Notion to pull it out of this publish.

**A4.** (placeholder — gate 2 confirmation handled inline in A3.)

**A5. PUBLISH (write).**

```bash
node "$RUN" "$NOTION_URL"
```

Wrapper streams progress lines and prints a final summary block:

- **Author mode**:

  ```
  ✅ 作者頁已更新 — /author/<slug>
     大頭照已重新上傳至 Vercel Blob
  ```

- **Article mode (單篇典藏)** — one standalone article published to `/archive`.
  Status-aware, same honesty rules as the edition per-article lines:

  ```
  ✅ 單篇文章已發布到典藏 — <site>/article/<slug>   ⟲ 已更新語意搜尋向量
     耗時 1.2 秒
  ```

  A **draft** standalone article (`Status` blank / `draft`) reads
  `◌ 草稿(預覽):<site>/article/<slug>?draft=1` + a note that setting
  `Status: published` and re-running pushes it live to 典藏. An **archived**
  one reads `⊘ 已下架(不會出現在典藏)`. Relay whichever line the wrapper
  prints verbatim, including the preview link.

- **Edition mode**:

  ```
  ✅ 第 N 期已發布 — /edition/N
     ✓ /article/<slug-1>   MVP 測試文章_1
     ◌ 草稿(預覽):<site>/article/<slug-2>?draft=1 — 某篇草稿
     ⊘ 已下架(已從上線版本移除):某篇文章
     ✗ <notion-id>         <error message>
     共 N 篇,耗時 4.6 秒 (3 篇上線, 1 篇草稿, 1 篇下架, 1 篇失敗)
  ```

  An **archived** (`Status = archived` / 下架) article is synced but pulled
  OFF the live site — its `/article/<slug>` 404s. The summary reports it as
  `⊘ 下架`, counted separately, NOT as a ✓ success and NOT as "跳過"
  (跳過 would wrongly imply nothing happened; the article was actively
  removed).

  A **draft** (`Status = draft` / 草稿) article inside a published edition is
  synced but off the live site too. Instead of a dead link, the summary hands
  the editor a **preview link** — `◌ 草稿(預覽):<site>/article/<slug>?draft=1`
  — so they can review it. Relay that link verbatim so the editor can click it.

- **Draft edition** (the whole `Status = draft` / 草稿 edition): nothing goes
  live, so the header is NOT `✅ 已發布`. It reads:

  ```
  📝 第 N 期(草稿,尚未上線)— 預覽:<site>/edition/N?draft=1
     ◌ 草稿(預覽):<site>/article/<slug>?draft=1 — …
     共 N 篇,耗時 4.6 秒 (0 篇上線, N 篇草稿)
  ```

  The `?draft=1` preview is **`noindex`** (search engines won't list it) but is
  NOT secret — it's protected only by the URL being unguessed. Don't share a
  draft preview link anywhere public; treat it as internal-review only.

If any article failed, surface the failure list verbatim — the editor
needs the page IDs and error messages to fix and re-run.

---

### §B Conversational completion (when input is incomplete)

**B1. Bare verb without URL** (`publish, hasUrl:false`).

The editor wrote `上稿` / `publish` / `發布` etc. but didn't include a
URL. Ask one targeted free-form question:

> 好的,要上稿哪個 Notion 頁面?請貼上 URL。例如:
> • Edition (DS row): `https://app.notion.com/p/<editionsDsId>?p=<editionPageId>&pm=s`
> • Author (DS row): `https://app.notion.com/p/<authorsDsId>?p=<authorPageId>&pm=s`
> • Author (page link): `https://www.notion.so/作者名-<authorPageId>`

When the editor responds with a URL, jump into §A1.

**B2. Empty or ambiguous input.**

The editor typed `/plainlaw-publish` with no arg, or typed something
unrecognized (e.g. `春節`). Ask the editor what they want with
`AskUserQuestion`:

Options:

- `[上稿已寫好的內容]` — they have a Notion URL ready; jumps into §B1 (we'll then ask for the URL)
- `[開新一期(期刊範本)]` — jumps into §C with `scaffold-edition`, title `null`
- `[新增單篇文章(典藏)]` — jumps into §C with `scaffold-article`, type `default`, title `null`
- `[取消]` — stop, no further action

If the editor typed ambiguous text (e.g. `春節`), include the original
input in the question's preamble:

> 不太確定您想做什麼。「春節」是想要…

so they see their input echoed back and can correct it.

**B3. URL with an unrecognized extra word** (`publish-unclear`).

The editor pasted a valid Notion URL but tacked on a word the skill doesn't
recognize — the classic case is `<url> draft`. `CLASSIFY_JSON` carries the
leftover in `extra`. **Do NOT publish yet.** There is no draft-publish mode:
draft status is set via the Notion `Status` field, and `?draft=1` is only a
site-side preview, not an ingest option. (If the page's `Status` is already
`草稿`, publishing it normally syncs it as a draft and the §A5 summary hands
back a `?draft=1` preview link — the editor never needs a separate draft verb.)
Ask with `AskUserQuestion`, echoing the leftover so the editor sees what
tripped the skill:

> 我看到一個 Notion 連結,後面還有「{extra}」這個字。目前沒有「{extra}」
> 這個發布選項 —— 草稿狀態請在 Notion 的 `Status` 欄位設定,`?draft=1`
> 只是網站預覽。要怎麼處理?

Options:

- `[直接發布這個頁面]` — ignore the extra word; jump into **§A1** with the URL.
- `[取消]` — stop, no writes.

If the editor confirms publish, proceed through the normal gates (§A1 inspect
→ §A2 confirm → §A3 validate → §A5 publish). Never skip them.

---

### §C Scaffold path (keyword → 3 steps, one gate fires)

**C1. PREVIEW (read-only).**

```bash
node "$RUN" scaffold-preview "$KEYWORD"
```

Script prints a Chinese preview card + `SCAFFOLD_PREVIEW_JSON: {...}`
line. The preview describes exactly what will be created — for editions,
it shows the next issue number with the reason ("第 17 期 because
the current latest is 第 16 期").

**C2. GATE — confirm creation (`AskUserQuestion`).**

Show the editor the preview card. Options:

- For `kind: "edition"`: `[建立第 N 期]` / `[取消]`
- For `kind: "article"`: `[建立草稿]` / `[取消]`

Cancel → stop, no Notion writes happen.

**C3. EXECUTE (write).**

```bash
node "$RUN" "$KEYWORD"
```

Same script with the keyword instead of a URL. Wrapper prints the
final summary (which Notion rows got created, with their URLs).

## Notes

- **Endpoint**: defaults to `https://plainlaw-site-mvp.vercel.app/api/ingest`.
  The launcher can override via `PLAINLAW_INGEST_URL` for development;
  editors never need to set it.
- **Idempotency**: re-running on the same Notion page returns the same
  IDs (article slugs locked, edition number stable). Safe to re-run as
  the recovery path for any partial failure.
- **Draft by default** (edition mode): an edition is live ONLY when its Notion
  `Status` is explicitly `published` (or an alias: `已發布` / `上線` / `發布`).
  A blank/`draft` Status publishes as a **draft** — synced but off the public
  site, reachable via the `?draft=1` preview link in the summary. To launch an
  issue, set the edition's `Status: published` in Notion and re-run.
- **Status inheritance** (edition mode): when the edition is `published`,
  child articles inherit `published` UNLESS they have their own `Status`
  property overriding it. To keep one article draft inside a published
  edition, set `Status: draft` (or `草稿`) on that child page in Notion.
  (Inside a draft edition, Status-less articles inherit `draft` too.)
- **Edition title required**: edition pages need `第 N 期` somewhere in
  the title. If absent, the API returns 500 with a clear error; surface
  it verbatim so the editor knows to fix the title.

## The publish key (PLAINLAW_BEARER)

The script authenticates to `/api/ingest` with a bearer read from the
`PLAINLAW_BEARER` environment variable. On an editor's machine it is set
once in their shell profile (`~/.zshrc`):

```bash
export PLAINLAW_BEARER="<the key Chi-An gave you>"
```

The key value is **never** stored in this repo, in the skill files, or in
this conversation — only in the editor's own shell profile. If §0 reports
`MISSING_BEARER`, follow the Option-B flow there: open the blank line for
them, let them paste the value in themselves, never into chat.

## Local development (Chi-An only)

Skip everything above; export `PLAINLAW_BEARER` in your shell, set
`PLAINLAW_INGEST_URL=http://localhost:3000/api/ingest`, run the repo copy
directly:

```bash
node .claude/skills/plainlaw-publish/run.mjs "$NOTION_URL"
```
