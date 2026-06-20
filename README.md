# plainlaw-publish — 法白上稿工具

把 Notion 頁面上稿到 **plainlaw.me** 的 Claude Code 技能。貼一個 Notion 連結,
它會自動判斷是「整期期刊」「單篇典藏文章」還是「作者頁」,先給你預覽、你確認後
才真的發布。也能用關鍵字(例:`期刊範本`)幫你在 Notion 開好一期的草稿結構。

> 這個工具只在 **Claude Code**(終端機裡的 AI 助理)裡使用。安裝一次,之後每次
> 在 Claude Code 打 `/plainlaw-publish` 就能用。

---

## 你需要準備

1. **Claude Code** 已安裝且登入(沒有的話請先請 Chi-An 協助安裝)。
2. **Node.js**(macOS 通常已內建;沒有的話 Claude Code 會提示)。
3. **一把發布金鑰**(`PLAINLAW_BEARER`)—— 由 **Chi-An 另外私下給你**,
   **不會**寫在這個網頁、也**不要**貼到 Claude 的對話框裡。

---

## 安裝(兩種方式,擇一)

### 方式 A:用 Claude Code 外掛市集(建議)

在 Claude Code 裡依序輸入:

```
/plugin marketplace add mw10104587/plm-publish-skill
/plugin install plm-publish@plainlaw
```

裝好後,重啟 Claude Code 讓技能生效。

### 方式 B:請 Claude 直接幫你裝(最簡單,適合不熟指令的人)

在 Claude Code 裡直接用中文說:

> 請把 `github.com/mw10104587/plm-publish-skill` 裡
> `plugins/plm-publish/skills/plainlaw-publish` 這個資料夾,
> 下載到我的 `~/.claude/skills/plainlaw-publish`。

Claude 會幫你抓下來放到正確位置。

---

## 設定發布金鑰(只做一次)

技能裝好後,還要把 Chi-An 給你的金鑰放進你電腦的設定檔。**最安全的做法是讓
Claude 幫你開好一行空白、你自己把金鑰貼進去**(金鑰不會經過對話):

1. 在 Claude Code 裡說:**「請幫我在 `~/.zshrc` 開一行 `export PLAINLAW_BEARER=""`」**
   Claude 會幫你加好那一行(引號中間是空的)。
2. **你自己**打開 `~/.zshrc`,把 Chi-An 給你的金鑰**貼進兩個引號中間**:
   ```bash
   export PLAINLAW_BEARER="貼在這裡"
   ```
   存檔。
3. 重開一個終端機視窗(或重啟 Claude Code),設定才會生效。

> ⚠️ 金鑰請**不要**貼到 Claude 的對話框、也不要傳到任何群組或信件。它等同
> 「發布到正式網站」的鑰匙,只放在你自己電腦的 `~/.zshrc` 裡就好。

---

## 開始使用

在 Claude Code 裡輸入 `/plainlaw-publish`,後面接你要做的事:

| 你想做的事 | 這樣打 |
| --- | --- |
| 上稿某個 Notion 頁面 | `/plainlaw-publish <貼上 Notion 連結>` |
| 開新一期的草稿結構 | `/plainlaw-publish 期刊範本` |
| 新增一篇典藏文章草稿 | `/plainlaw-publish 文章範本` |
| 不確定 / 想被引導 | 直接打 `/plainlaw-publish`,它會問你 |

每次發布前,工具都會先**檢查(inspect)**、再**驗證內容齊全(validate)**,
每一步都會等你確認才繼續 —— 不會在你還沒點頭前就寫到正式網站。

---

## 之後要更新工具

- 用**方式 A** 裝的:在 Claude Code 裡執行 `/plugin marketplace update plainlaw`,
  再 `/plugin install plm-publish@plainlaw`。
- 用**方式 B** 裝的:再跟 Claude 說一次「請更新 plainlaw-publish 技能」即可。

---

## 遇到問題?

- 顯示「還沒看到 plainlaw-publish 的安裝」→ 安裝沒成功,重做上面的安裝步驟。
- 顯示「少一把發布金鑰 / MISSING_BEARER」→ 金鑰還沒設好,重做「設定發布金鑰」。
- 其他狀況 → 把畫面截給 Chi-An。

---

*技術細節(給工程師看):這是一個 thin client,只把 Notion 頁面 ID + bearer
送到 `plainlaw.me` 的 `/api/ingest`;不含任何密鑰,所有資料庫 / Notion / 圖床
憑證都在伺服器端。`run.mjs` 從 `PLAINLAW_BEARER` 環境變數讀取金鑰,本檔與本 repo
都不包含金鑰值。*
