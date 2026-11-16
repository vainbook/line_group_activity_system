# 群組活動布告欄

給 LINE 群組用的活動布告欄。成員在 LINE 裡打開網頁，就能發起活動、報名、留言、打卡，不用另外裝 App。

> **想架一份給自己的群組用？** 請用乾淨範本 [line-group-board](https://github.com/vainbook/line-group-board)，按一顆按鈕就能部署到你自己的 Cloudflare。這個專案是原作者自己群組正在用的版本，直接複製會連到別人的資料。

## 功能

**活動**

- 發起揪團、報名／取消、活動留言
- 許願團：三天內湊到人就成團，湊不到自動消失
- 興趣調查：一排可左右滑的標籤，大家點自己有興趣的
- 交棒主揪、加強推廣（同時最多 3 個）
- 開團直接發到群組；複製活動資訊或 `@成員` 標記，貼回群組
- 每個活動都能「加到我的日曆」

**打卡**

- 成員自己登記，第一次登記自動加入名單
- 管理員勾選「打卡成功」，兩層權限分開
- 名單可搜尋、排序、依打卡狀態篩選，一鍵複製未打卡成員的 `@名字`

**管理**

- 管理員模式（密碼驗證，入口藏在頁首版本號）
- 可編輯／刪除任何活動、移除成員、重置打卡與興趣調查
- 所有操作都留紀錄，過期活動每天自動整理

## 架構

| 部分 | 位置 | 發布方式 |
|---|---|---|
| 網站 | `index.html`（單一檔案）、`version.json`、`assets/` | GitHub Pages |
| 後端 | `api/src/index.js`：Cloudflare Worker＋Durable Object（SQLite） | `cd api && npx wrangler@4 deploy` |
| 學員範本 | `template/`＋`scripts/build-template.mjs` | 產生到另一個 repo，見下方 |

網站與後端各自發布，更新其中一邊不會自動更新另一邊。維護細節與不能改的規則寫在 `AGENTS.md`。

### 更新學員範本

範本的網站與後端直接取自這個專案，改完功能後重新產生一次：

```bash
node scripts/build-template.mjs
```

產生到旁邊的 `line_group_board_template/` 資料夾，再從那裡推上範本 repo。腳本會檢查範本裡有沒有殘留這個專案的網址或 LIFF ID，有的話直接停下來。

範本裡網站與後端是同一個 Worker：網頁從 `/config.js` 拿到自己的後端網址與 LIFF ID（LIFF ID 由學員在 Cloudflare 後台設定），所以學員不用改任何程式。

### 本機測試後端

```bash
cd api && npx wrangler@4 dev --port 8799 --test-scheduled
```

另開一個終端機跑 `node api/test/api.test.mjs`。測試用的密碼放在 `api/.dev.vars`（不會進 Git）。
