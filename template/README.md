# LINE 群組活動布告欄

給 LINE 群組用的活動網頁，從群組裡直接打開。成員可以：

- 開揪團、報名、留言，名額滿了自動擋下
- 許願活動：三天內湊到 4 人就成團，沒湊到自動消失
- 興趣調查：一排標籤，大家點自己有興趣的
- 打卡名單：成員自己登記，管理員勾選打卡成功

網站和資料都放在你自己的 Cloudflare 帳號，免費方案就夠用。

## 你需要

- Cloudflare 帳號（免費）
- GitHub 帳號（免費）
- LINE 帳號，用來登入 LINE Developers

## 架設步驟（大約 30 分鐘）

### 1. 部署網站

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vainbook/line-group-board)

按上面的按鈕，登入 Cloudflare 並連結 GitHub。

部署畫面會要你填 `ADMIN_PASSWORD`，這是管理員密碼，自己取一組不容易猜的。其他設定都不用改，直接按部署。

完成後會拿到一個網址，像這樣：`https://line-group-board.你的帳號.workers.dev`

### 2. 打開網址

會看到「網站已經部署好，還差最後一步」。畫面上的網址就是下一步要填的 **Endpoint URL**，先複製起來。

### 3. 在 LINE Developers 建立 LIFF

1. 到 [LINE Developers](https://developers.line.biz/console/) 登入，建立一個 Provider，名稱自己取。
2. 在 Provider 裡建立一個 **LINE Login** channel。
3. 進入 channel 的 **LIFF** 分頁，按 Add：
   - Size：**Full**
   - Endpoint URL：貼上第 2 步複製的網址
   - Scopes：勾選 `profile`、`openid`、`chat_message.write`
4. 建好後會看到 **LIFF ID**（像 `1234567890-AbCdEfGh`），複製起來。
5. 回到 channel 頂端，把狀態從 **Developing** 改成 **Published**。沒改的話只有你自己能用。

### 4. 把 LIFF ID 告訴網站

到 Cloudflare 後台 → Workers → `line-group-board` → 設定 → 變數和密碼，新增一個變數：

- 名稱：`LIFF_ID`
- 值：第 3 步的 LIFF ID

存檔後重新整理網站，看到活動列表就完成了。

### 5. 放進群組

群組裡要分享的網址是：

```
https://liff.line.me/你的LIFF_ID
```

建議設成群組公告。成員從 LINE 裡打開才能報名；用一般瀏覽器開只能看。

## 怎麼當管理員

點網頁標題旁邊的版本號，輸入 `ADMIN_PASSWORD`，就能刪除任何活動、移除報名的人、管理打卡名單。重新整理後會自動退出。

## 常見問題

**打開網站一直顯示「還差最後一步」**
`LIFF_ID` 或 `ADMIN_PASSWORD` 沒設好。到 Cloudflare 的「變數和密碼」確認兩個都在。

**成員說打不開或要求登入**
確認 LINE Login channel 已經改成 **Published**。

**開團時不會自動發到群組**
LIFF 的 Scopes 要勾 `chat_message.write`。勾了之後，成員下次打開會再跳一次授權畫面。

**資料在哪裡？**
在你 Cloudflare 帳號裡這個 Worker 的 Durable Object。不會傳給任何其他人。
