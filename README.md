# rubyclean

套房清潔管理系統 + TTLock 智慧門鎖整合（Cloudflare Worker）。

## 房客 LINE 自助取門鎖密碼

房客在 LINE 官方帳號輸入「密碼」即可取得**當日**門鎖密碼，規則：

- 門鎖綁定房客的 LINE User ID，**只有該 User ID** 能索取。
- 密碼**當天有效**（至台北時間 23:59），同一天重複索取回傳**同一組密碼**。
- 免費 **3 次／年**（每年 1/1 重置），第 4 次起每次收 **50 元** 作業費，記入待收帳款。

### 檔案

| 檔案 | 說明 |
|------|------|
| `worker.js` | Cloudflare Worker：`/line/webhook`（房客取密碼）、TTLock、短網址、KV |
| `tenant-admin.html` | 後台：手動綁定 User ID ↔ 門鎖、查看用量、結清帳款 |
| `index.html` | 清潔管理後台 |

### 需要的 Worker 環境變數

TTLock（既有）：`TTLOCK_CLIENT_ID`、`TTLOCK_CLIENT_SECRET`、`TTLOCK_USERNAME`、`TTLOCK_PASSWORD`

LINE（新增）：
- `LINE_CHANNEL_ACCESS_TOKEN` — Messaging API 長期 access token
- `LINE_CHANNEL_SECRET` — 用於驗證 webhook 簽章

### LINE 設定

1. LINE Developers → Messaging API channel → Webhook URL 設為
   `https://<你的worker網域>/line/webhook`，並開啟 **Use webhook**。
2. 建議加圖文選單按鈕，動作設為傳送文字「密碼」。
3. 在 `tenant-admin.html` 輸入房客的 User ID 與門鎖 Lock ID 完成綁定。

### KV 資料結構

```jsonc
tenants_db = { "<lineUserId>": { name, lockIds: [998877] } }   // 後台維護
tenant_usage:<lineUserId> = {
  year, issuedThisYear,                 // 計費依據（每年重置）
  today: { date, passcodes, n, charged },
  charges: [ { date, amount: 50, paid: false } ]
}
```

> ⚠️ 安全備註：`/db/*`、`/ttlock/*` 端點目前無鑑權，任何人知道網址即可呼叫。
> `/line/webhook` 已驗證 LINE 簽章。若要加固其餘端點可再處理。
