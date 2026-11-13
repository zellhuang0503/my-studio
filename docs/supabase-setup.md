# Supabase 一般設定同步與安全 AI 後端

適用此專案的 `index.html`。本次程式不會自動建立遠端資料表、部署函式、修改 Supabase 設定或上傳金鑰。請依下列順序完成後台，再發布新版網頁。

## 1. 先準備管理帳號與備份

1. 開啟原本存放 `posts` 的 Supabase 專案，不必建立另一個專案。
2. 在 Supabase 管理帳號啟用多因素驗證；只讓必要管理員存取專案及 Secrets。
3. 備份目前網站及重要資料。此 SQL 不更動 `posts`、圖片 Storage 或既有資料。
4. 在仍使用舊版的自己的裝置，確認可以取得原先 OpenRouter／Gemini 金鑰，或到供應商管理頁建立新的專用金鑰。不要把金鑰貼進聊天、SQL、GitHub 或截圖。
5. 新版第一次載入會刪除瀏覽器 `demo-settings` 與帳號設定快取中的舊金鑰欄位，不會自動把金鑰上傳。其他尚未開啟新版的裝置仍可能保留舊金鑰；需要逐一開啟新版，或手動清除該網站舊設定。這不會撤銷供應商金鑰。

## 2. 建立設定表、核准名單與後端用量限制

1. Supabase 左側開啟 **SQL Editor → New query**。
2. 打開本專案 `supabase/migrations/202611130001_secure_ai.sql`，整份複製到 SQL Editor。
3. 按 **Run**，確認成功。

會建立：

| 名稱 | 用途 | 網頁使用者權限 |
| --- | --- | --- |
| `user_settings` | 一般設定，每帳號一列 | 只能讀寫自己的一列，不能刪除或改別人的資料 |
| `ai_members` | 管理員核准的帳號與使用上限 | 無權讀寫 |
| `ai_usage` | 後端記錄的用量 | 無權讀寫 |
| `reserve_ai_request` | 在資料庫鎖定並扣除一次額度 | 僅後端 `service_role` 能執行 |

`user_settings.data` 僅接受明列的一般設定欄位及字串值，不接受 `key`、`gkey` 等額外欄位。請勿把真實金鑰當作文字貼進品牌規格。

新建的核准名單是空的，所以一開始所有人都無法使用付費 AI，這是預期行為。

## 3. 設定登入安全，核准自己的平台帳號

1. 在 **Authentication → Sign In / Providers → Email**（後台名稱可能略有不同），保留 Email 驗證；不要為了方便關閉確認信。
2. 如果平台只給您與指定客戶使用，關閉開放新使用者註冊，改由管理員邀請。既有網頁註冊按鈕仍可能顯示，但後台會拒絕未開放的註冊。
3. 在 **Authentication → URL Configuration** 設定正式網站網址與允許的導回網址。若部署在目前 GitHub Pages，網站路徑為 `https://zellhuang0503.github.io/my-studio/`。
4. 用自己的平台 Email 登入／完成驗證。在 **Authentication → Users** 找到該帳號，複製 **User UID**。不要使用 Supabase 管理員帳號的 ID 代替平台使用者 UID。
5. 回 SQL Editor 執行以下內容，將 `您的平台使用者UID` 換成剛剛的 UUID：

```sql
insert into public.ai_members
  (user_id, enabled, daily_requests, daily_images, minute_requests)
values
  ('您的平台使用者UID'::uuid, true, 50, 5, 5)
on conflict (user_id) do update set
  enabled = excluded.enabled,
  daily_requests = excluded.daily_requests,
  daily_images = excluded.daily_images,
  minute_requests = excluded.minute_requests;
```

這表示每天最多 50 次供應商呼叫，其中最多 5 次生圖，每分鐘最多 5 次。每日以台灣時間換日；每分鐘是整分鐘窗口。文字失敗後改用 Gemini 會算另一次；供應商失敗、逾時也占一次，避免反覆重試繞過限制。

要停用某帳號：

```sql
update public.ai_members set enabled = false
where user_id = '要停用的使用者UID'::uuid;
```

此核准只控制 AI 使用資格，不會自動改動您原有貼文資料的 RLS；其他表及圖片權限仍須獨立管理。

## 4. 填入 Edge Function Secrets

1. 開啟 **Edge Functions → Secrets**。
2. 在 Key／Value 新增下列名稱及值，再按 **Save**。名稱大小寫必須完全一致。

| Key | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | 您的 OpenRouter 真實金鑰 |
| `GEMINI_API_KEY` | 您的 Gemini 真實金鑰；不使用 Gemini 可不填 |
| `ALLOWED_ORIGINS` | `https://zellhuang0503.github.io`；若有自己的網域，改填實際來源 |
| `ALLOWED_OR_MODELS` | 管理員允許的 OpenRouter 文字模型 ID，多個以英文逗號分隔 |
| `ALLOWED_GEMINI_MODELS` | 管理員允許的 Gemini 模型 ID，多個以英文逗號分隔 |
| `ALLOWED_IMAGE_MODELS` | 管理員允許的 OpenRouter 生圖模型 ID，多個以英文逗號分隔 |

來源只含協定、網域及必要的連接埠，**沒有 `/my-studio/` 路徑，也沒有最後的 `/`**。不要填 `*` 或 `null`。正式環境只保留正式來源；本機測試若需要，暫加如 `http://127.0.0.1:8000`，測完移除。來源限制不能區分同個網域下不同 GitHub Pages 專案，也不能取代身分驗證與核准名單。

平台目前預設模型為：

```text
OpenRouter 文字：deepseek/deepseek-v4.1-flash
Gemini 文字：gemini-3.8-flash
OpenRouter 生圖：bytedance-seed/seedream-5-0-flash
```

以上是現有程式的偏好，**不代表已驗證您帳號能使用或供應商目前仍提供**。請先在供應商官方模型目錄確認，再將實際可用的精確 ID 填進白名單；網站「⚙ 設定」也選同一個 ID。各組都有「自己打模型名稱」欄位，可填入已核准且實際可用的模型。白名單留空會拒絕該組模型，不會自動放行所有模型。

`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 是託管 Edge Functions 的內建環境變數，不需要把它們寫進網頁或 SQL。後端使用 service role 只做登入驗證與扣用量。供應商金鑰不回傳前端。此階段為公司共用後端金鑰；若要客戶各自提供金鑰，需另行做 Vault 與帳號對應機制，不要讓客戶操作專案 Secrets。

## 5. 部署 ai-proxy 後端函式

### 建議：使用 Supabase CLI，確保兩個檔案完整部署

這台 Windows 電腦已有 Node.js，可直接透過 `npx.cmd` 啟動 CLI，不必先安裝全域的 `supabase` 指令，也不必安裝 Docker。已驗證 CLI 版本為 3.1.0。

先在您自己的 PowerShell 執行登入，依提示於瀏覽器完成授權（驗證碼只輸入本機終端機，不要貼到聊天）：

```powershell
npx.cmd --yes supabase@3.1.0 login
```

顯示登入成功後，在專案目錄執行下列部署指令。CLI 3 使用 `--remote` 明確指定專案，無須先執行 `link` 或輸入資料庫密碼：

```powershell
Set-Location -LiteralPath 'C:\Users\zellh\Coding Projects\my-studio'
npx.cmd --yes supabase@3.1.0 functions deploy ai-proxy --remote=csfngjcugvabzpjfzvqa --use-api
```

此指令只部署 `ai-proxy`，會一起上傳所需程式檔；不會推送資料庫遷移、發布 GitHub Pages 或刪除其他函式。`--use-api` 使用伺服器端打包，不依賴 Docker。若希望由 Codex 接續部署，您只需先完成登入並回覆「登入好了」，無須提供存取權杖或金鑰。

函式包含兩個檔案，必須一起部署：

```text
supabase/functions/ai-proxy/index.ts
supabase/functions/ai-proxy/handler.ts
```

`supabase/config.toml` 已設定此函式的 `verify_jwt = false`：入口程式會在**每次請求**呼叫 Supabase Auth `getUser(token)` 驗證真實登入，再檢查資料庫核准名單。這是函式內驗證，不是匿名開放。不可刪掉 `verify`、`getUser` 或用量／名單檢查。

### 若要全部透過後台操作

1. **Edge Functions → Deploy a new function → Via Editor**，名稱填 `ai-proxy`。
2. 將本專案 `index.ts` 的內容放進編輯器的 `index.ts`。
3. 新增同一層 `handler.ts`，貼入本專案 `handler.ts` 的完整內容。
4. 若目前編輯器不提供新增檔案，改用上面的 CLI，不要只部署其中一個檔案。
5. 部署後進入函式 **Details／Settings**，將平台層的 **Verify JWT**（有些介面稱「Verify JWT with legacy secret」）關閉，與專案設定一致；函式內的 `getUser` 驗證必須保留。

## 6. 設定供應商費用防線

1. OpenRouter 使用平台專用金鑰，設定能接受的信用額度／消費限制，避免直接使用其他業務的共用無上限金鑰。
2. Gemini 在 Google Cloud 設定適當 API 配額與費用警示。**預算警示本身不保證自動停用或限制費用。**
3. 一開始只允許少數便宜模型，從低用量測試，再調整 `ai_members`。

目前後端限制的是請求次數、圖片次數、輸入大小（200 KB）、文字最多 8,000 output tokens，以及生圖一次一張 1K。**這不是美元金額硬上限**；實際費用仍受模型、輸入、推理與供應商計價影響。額度紀錄以後端 `ai_usage` 為準，畫面原有用量只是這台裝置的參考紀錄。

## 7. 發布網站與第一次同步

1. 先確認前面 SQL、Secrets、函式都已完成，再把新版 `index.html` 透過原有 GitHub Pages 流程發布。
2. 先使用自己的筆電登入，打開「⚙ 設定」。雲端若還沒有這個帳號的一般設定，會先帶入該裝置的舊一般設定供確認，按 **儲存** 才寫入雲端。
3. 看到「設定已同步到雲端」後，才到手機登入。同一帳號會載入雲端設定，無須輸入 API key。
4. 多裝置同時儲存採最後成功寫入者為準，不會逐欄合併。切換裝置要編輯設定時，先按「從雲端重新載入設定」。
5. 雲端讀取失敗會禁止儲存雲端設定及 AI 操作，請先重新載入；避免用空白或舊設定誤覆蓋雲端。沒登入仍可在本機編輯一般設定、使用手動貼回與原有本機功能。

登入後一般設定快取使用帳號專屬鍵；登出切回訪客設定。供應商金鑰不再保留於設定快取，但登入工作階段憑證仍是瀏覽器敏感資料。借用電腦請登出並清除貼文；不要讓瀏覽器記住密碼。

## 8. 驗收與故障對照

請先用自己的帳號做少量驗收；下列 AI 生成會真的使用供應商額度。

| 操作 | 預期結果 |
| --- | --- |
| 未登入按 AI | 提示先登入，不呼叫供應商 |
| 已登入但不在 `ai_members` 或 `enabled=false` | 拒絕 AI 使用資格 |
| 設定品牌文字後換手機登入 | 讀到相同一般設定，不需要金鑰 |
| 換成另一帳號 | 不會顯示上一帳號的雲端設定 |
| 選未列入白名單的模型 | 顯示未獲核准，不呼叫供應商 |
| 達到每日／圖片／分鐘限制 | 拒絕繼續呼叫 |
| 瀏覽器 Network 檢查 AI 要求 | 網頁只送到 `/functions/v1/ai-proxy`，沒有供應商金鑰 |
| 文字生成、改文、檢查、想圖、生圖 | 都經過此後端；結果正常顯示 |

「未設定這組 AI 服務」：檢查供應商 Secret 名稱；「模型未核准」：檢查精確模型 ID；401：重新登入並檢查部署的驗證設定；403：檢查來源與核准名單；429：查看 `ai_usage`；502：檢查供應商模型／餘額／配額；503：檢查 Secrets、SQL 及函式是否完整部署。

錯誤回應刻意不回傳供應商原始訊息，避免金鑰或其他敏感內容外流。請勿為了除錯把完整 headers、金鑰或使用者內容加入日誌。

## 本機自動驗證

Node 24 或以上；將 `playwright`、`@electric-sql/pglite` 安裝在測試用目錄，使用本機 Microsoft Edge。設定 `NODE_PATH` 指向該目錄的 `node_modules` 後執行：

```powershell
node tests/secure-ai.cjs
```

測試涵蓋後端拒絕邊界、PostgreSQL RLS／權限／額度，以及瀏覽器設定同步與 AI 路由。不使用真實金鑰、不呼叫付費 API、不連線修改正式資料庫。

## 官方參考（英文原始文件）

- Secrets：https://supabase.com/docs/guides/functions/secrets
- Auth getUser：https://supabase.com/docs/reference/javascript/auth-getuser
- Edge Function 驗證：https://supabase.com/docs/guides/functions/auth
- RLS：https://supabase.com/docs/guides/database/postgres/row-level-security
- 後台部署：https://supabase.com/docs/guides/functions/quickstart-dashboard
- OpenRouter 生圖：https://openrouter.ai/blog/tutorials/image-generation/
- Gemini 相容 API：https://ai.google.dev/gemini-api/docs/openai
