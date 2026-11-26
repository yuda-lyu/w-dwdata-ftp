# w-dwdata-ftp 狀態(現況)

> 只記現況,不寫過程(過程見 `sgud/exp/experience.md`)。規則見 `sgud/rule/rulebook.md`,處理要點見 `sgud/proc/process.md`。

## 功能現況

| 功能 | 規則 | 現況 | 測試 |
|---|---|---|---|
| `downloadFiles` 逐檔下載、重試、重連 | R-DL-01~03、R-DL-06 | 已做:各檔依 `retry`/`retryInterval` 重試,重試用盡列入 `failed`,不留殘檔 | `test/unit-downloadFail.test.mjs` |
| 整輪失敗(連線/ls/重連/全部失敗/清空失敗) | R-DL-04 | 已做;「殘檔刪不掉」「起手清空失敗」之 reject 路徑未涵蓋(無法以假伺服器觸發) | 同上 |
| 回傳 `{ files, failed }` | R-DL-05 | 已做(破壞性變更,無相容層) | 同上 |
| `st.fdDownloadTemp` 位置檢查 | R-DL-07 | 已做(含 w-ftp 預設暫存區) | 同上 |
| `timeFile`、`timeRound` | R-DL-08 | 已做(預設 100000ms、0) | 同上 |
| opt 檢測與 `debug` 警告 | R-DL-09 | 已做;共用實作 `src/_optReader.mjs` 暫代 wsemi 未公開之同類函數 | 同上 |
| `onTrace` 觀察回調 | R-DL-10 | 已做(`ls`、`attempt`、`done`、`fail`、`retry`、`reconnect`、`giveup`、`expired`) | 同上 |
| 外來錯誤文字遮罩 | R-DL-11 | 已做;`WDwdataFtp` 之 `move-files-to-storage` 錯誤文字遮罩路徑未涵蓋 | 同上 |
| `WDwdataFtp` 全量模式沿用失敗檔之前次版本 | R-WD-01 | 已做 | 同上 |
| `WDwdataFtp` 只搬入已處理成功者 | R-WD-02~04 | 已做(至少一次語意) | 同上 |
| opt 轉交與自身檢測 | R-WD-05 | 已做 | 同上 |
| wsemi 列舉函數第 2 參數(`{ levelLimit: 1 }`,僅第 1 層) | R-WS-01~03 | 已做:`src` 3 處與測試 8 處(2026-11-26);3 處 `src` 站點各有層數語意測試 | 同上(4 案) |

## 依賴與版本

- `w-ftp ^1.0.76`(1.0.76 起其內部列舉已用 wsemi 新簽章);`wsemi ^1.9.80`(列舉函數第 2 參數改為 `opt`);`w-dwdata-builder ^1.1.41`。
- 套件 `version` 未動(1.1.40;破壞性變更由發布流程決定版號)。

## 最近一次驗證(2026-11-26)

- `npm test` 80 案全綠(既有 19 + 新增 61);發布包解開目錄(`npm pack`)再跑一次 80 案全綠;eslint 0 錯誤。
- 新增測試於修前碼(鏡像根、僅回傳形狀適配)為 53 紅、8 綠(綠者為回歸守門);全套連跑 5 次、新檔單獨連跑 20 次皆全綠;對 `src/` 三檔逐項植入 49 項單點變異,48 項被殺死、1 項存活(起手清空暫存夾失敗之 reject 路徑,無法以假伺服器觸發)。

- 2026-11-26(wsemi 1.9.80 遷移後):`npm test` 84 案全綠(新增 4 案);修前版(舊寫法)對 wsemi 1.9.80 為 7 綠、73 紅(`invalid opt: must be an object`);3 處 `src` 站點各以「省略」與 `{ levelLimit: 2 }` 兩種變異共 6 項,各使對應之層數語意案轉紅(1~2 案),對照組全綠;eslint 0 錯誤。

## 已知缺口與待辦

- 範圍外(他套件):w-data-scheduler 逐項遇錯即停;w-dwdata-builder 之 `fdDwAttime → fdDwCurrent` 無條件同步(見 R-WD 範圍外一節)。
- 以鏡像方式同步 `downloadFiles` 結果之使用端須自行處理 `failed`。
- 升級後第一輪:SFTP 全量模式下,`fdDwStorage` 內來自舊版 w-ftp(SFTP 忽略 `levelLimit`)之子資料夾內容會被鏡像同步移除(與 FTP 行為一致,且依 JSDoc 本就只處理第 1 層)。
- `src/_optReader.mjs` 待 wsemi 公開 opt 讀取函數後改用(見 `sgud/feedback/feedback.md`)。
- 起手 `fsCleanFolder(fdDwStorageTemp)` 失敗(例如目標為符號連結)現為整輪失敗;原為靜默續行並把前輪檔案當成果交出。
- 範圍外,未修(待裁示):`treeFolderAndGetFilesHash` 對 `fdDwStorage` 第 1 層之子資料夾項目不濾除(`forFolder: false` 只是不算其 hash,項目仍在清單內),子資料夾會以其名稱成為一筆無 hash 之項目;正常流程下 `fdDwStorage` 只含檔案,不致觸發。層數語意測試(R-WS-01)以「與僅有空子資料夾之對照組比對結果相同」斷言,不依賴此處理。
