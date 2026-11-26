# w-dwdata-ftp 規則帳本(藍圖)

> 本檔為程式碼須長成什麼樣之規則,附判準與對應測試;**現況**(各條做到哪裡)見 `sgud/state/state.md`.
> 套件定位:`downloadFiles`(由 FTP/SFTP 逐檔下載第 1 層檔案至本機暫存資料夾,回傳完整檔案與失敗檔案)與 `WDwdataFtp`(基於檔案之下載 FTP 數據與任務建構器,於下載、比對、處理、搬入儲存區各階段維持「不丟失、不交出不完整」)。
> 需求出處:使用端提出之 Gitea #216(下載中途失敗仍交出殘檔;主階段處理失敗時未處理之檔仍被搬入儲存區)。

## 1. downloadFiles(`src/downloadFiles.mjs`)

| 條號 | 規則 | 判準 / 對應測試(`test/unit-downloadFail.test.mjs`) | 狀態 |
|---|---|---|---|
| R-DL-01 | 逐檔下載(`ftp.ls` 後只取第 1 層之檔案,逐檔呼叫 `ftp.download(rpath, fpLocal, cb)` 三參數);不用 w-ftp 之 `syncToLocal`(其遇第一個失敗即停) | 「僅下載 fdIni 第 1 層之檔案」 | 已做 |
| R-DL-02 | 某檔失敗(含中途斷線、逾時、w-ftp 因大小不符而 reject)→ 紀錄、quit 舊連線、確認該檔目標不存在、等 `retryInterval`、重新連線(`conn` 後以 `ls` 驗證可用,因 FTP 之 `conn` 不實際連線)、重試該檔,至多 `retry` 次(預設 2、間隔 2000ms) | 「一直失敗」「重連重試成功」「retry 為 0/字串/非預期」「每次重試前至少等待」「FTP 資料連線中途關閉」 | 已做 |
| R-DL-03 | 重試用盡之檔**不視為整輪失敗**:不入 `files`、不留殘檔,列入 `failed`(`{ name, rpath, attempts, msg }`),其餘檔案照常下載 | 「一直失敗」「確認目標不存在殘檔」 | 已做 |
| R-DL-04 | 下列為整輪失敗:reject 並清空 `fdDwStorageTemp`——初次連線失敗(不重試)、`ls` 失敗、重新連線失敗(1+`retry` 次皆失敗)、有檔案須下載而**全部**失敗(不交出空清單;錯誤物件另帶 `failed`)、失敗後殘檔刪不掉、起手清空 `fdDwStorageTemp` 失敗(前輪檔案仍在,不得當成本輪成果交出);整輪逾時而無任何完整檔亦同全部失敗 | 「ls 失敗」「全部失敗」「無法重新連線」「連線建立失敗」「timeRound 無任何完整檔」 | 已做;「殘檔刪不掉」「起手清空失敗」之 reject 路徑未涵蓋(無法以假伺服器觸發) |
| R-DL-05 | 回傳為物件 `{ files, failed }`(**破壞性變更,不留舊形相容層**,原則 14);`files` 為完整下載之檔案資訊陣列(取自磁碟),`failed` 全部成功時為 `[]`;伺服器無任何檔案時 resolve `{ files: [], failed: [] }` | 「一直失敗」(鍵集合、非陣列)「伺服器無任何檔案」 | 已做 |
| R-DL-06 | 依賴 w-ftp ≥ 1.0.75:各檔先寫 w-ftp 之下載暫存區、傳完且本機大小等於遠端才移至目標,失敗刪暫存並 reject;本套件**不另核對大小**(`verifySize` 已移除),但仍於失敗後確認目標不存在(不依賴下層保證)。FTP 伺服器不支援 `SIZE` 時 w-ftp 拒絕下載,各檔皆失敗 | 「資料連線中途關閉(每次/僅 1 次)」「確認目標不存在殘檔」 | 已做 |
| R-DL-07 | `st.fdDownloadTemp` 經 `st` 原樣轉交 w-ftp;**不得為 `fdDwStorageTemp` 或其內**(否則 `.part` 暫存檔會被當成成果,且每輪清空會刪掉進行中之檔);未給時 w-ftp 預設為 `./_wftpDownloadTemp`,同樣檢查;違者 reject,訊息不回顯值(`invalid st.fdDownloadTemp: must be outside of fdDwStorageTemp`),不清空、不下載 | 「st.fdDownloadTemp 為 fdDwStorageTemp 或其內」「未給 st.fdDownloadTemp 時…預設暫存區」 | 已做 |
| R-DL-08 | `opt.timeFile`(預設 100000ms)為各檔單次下載時限,傳給 w-ftp 之 `timeLimit`(SFTP 自 w-ftp 1.0.75 起亦受約束,大檔須自行給較大值);`opt.timeRound`(預設 0 = 不限制)為整輪時限:逾時後不再下載與重試,未完成者列入 `failed`(`attempts` 為 0) | 「某檔下載停滯逾 timeFile」「timeRound」 | 已做 |
| R-DL-09 | opt 依 K3:`undefined`/`null` 取預設;給了而非預期(含超出範圍)視為未給改用預設,不報錯;數字字串轉換後使用(K4);每鍵只讀一次、讀取拋錯視為未給;`opt.debug === true` 時另警告(出口 `opt.funLog(msg, { fn, reason, key })` 或 `console.warn`),警告為固定詞彙、不含輸入值、同一函數同一鍵每行程一次。一律經 wsemi 1.9.82 起公開之 `getOptReader(tag, opt)`(opt 取值、種類檢測、`debug` 警告之單一擁有者;本庫不自寫讀取器,原 `src/_optReader.mjs` 已刪):`WDwdataFtp` 之 tag 為 `'w-dwdata-ftp WDwdataFtp'`、`downloadFiles` 為 `'w-dwdata-ftp downloadFiles'`;轉傳之鍵與 `srLog` 以 `rd.read(鍵)` 取原值(讀取拋錯視為未給),`debug`、`funLog` 以 `rd.debug`、`rd.funLog` 轉交下游;**與自寫版之差異**(2026-11-27 收斂):`funLog` 第 2 引數之 `fn` 由函數名(`'downloadFiles'`)改為整個 tag(`'w-dwdata-ftp downloadFiles'`),去重表與 wsemi 內部共用(上限 256 筆),測試重設改用 `getOptReader.resetWarned()`;警告字樣、預設值、觸發條件不變。盤點:`git grep -nE "function (readKey\|pickOpt\|readOpt\|optReader)\b\|from '(wsemi/src/_\|\./_)" -- src` 應為 0 處;`git grep -n "getOptReader(" -- src` 應為 `WDwdataFtp.mjs` 與 `downloadFiles.mjs` 各 1 處 | 「opt 非預期之輸入…debug」「opt 為 null 或非物件…讀取拋錯」;接線由 `test/unit-optReader.test.mjs`(src 不自寫、tag 與 `rd.read`/`rd.debug`/`rd.funLog` 接線,掃描器附盲點自測)與 `test/unit-downloadFail.test.mjs` 之 `WDwdataFtp` 讀取拋錯兩案、`funLog` 存取器拋錯案釘住 | 已做 |
| R-DL-10 | `opt.onTrace`(觀察回調)依規格(計時器相關函數之觀察回調):以 wsemi `getTrace` 取得,未給時不組事件;事件為凍結 `{ type, ... }`,type 為 `ls`({ num })、`attempt`({ name, attempt })、`done`({ name, attempt })、`fail`({ name, attempt, msg })、`retry`({ name, attempt })、`reconnect`({ ok, attempt, msg })、`giveup`({ name, attempts, msg })、`expired`({ num });回調拋錯/rejection 不影響結果 | 「onTrace 事件依序」「onTrace 之五種回調」;其餘計時相關測試以事件為同步點 | 已做 |
| R-DL-11 | 外來錯誤文字(後端、驅動之錯誤原文)經 wsemi 之 `maskDiagText`/`maskDiagErr` 遮罩帳密後才輸出:srLog 與 onTrace 用診斷清單(含單獨帳號)、`failed[].msg` 與 reject 錯誤用對外清單(只遮憑證);不自寫遮罩器 | 「外來錯誤文字…遮罩」 | 已做 |
| R-DL-12 | 逐檔進度事件名稱與訊息不變(`{ event: 'ftp.syncToLocal', name, progress, msg: 'running...' }`),使用端以此濾除進度紀錄;新增事件 `ftp.download`、`ftp.reconnect`(僅失敗時出現) | `unit-srLog.test.mjs` | 已做 |

## 2. WDwdataFtp(`src/WDwdataFtp.mjs`)

| 條號 | 規則 | 判準 / 對應測試 | 狀態 |
|---|---|---|---|
| R-WD-01 | 全量模式(`useExpandOnOldFiles=false`)以下載清單為「全部檔案」,清單內沒有之檔案會被視為已刪除;故 `failed` 內之檔若 `fdDwStorage` 有前次檔案,複製進 `fdDwStorageTemp` 沿用(內容同 `fdDwStorage`,視為未變更),新檔(無前次檔案)僅不納入;增量模式不須沿用。此邏輯在 `WDwdataFtp`(知道 `fdDwStorage`),不作為 `downloadFiles` 之選項 | 「WDwdataFtp(全量/增量): a2.bin 一直下載失敗…」「從未下載成功過之 a2.bin」 | 已做 |
| R-WD-02 | 下載階段整輪失敗(連線/`ls`/全部失敗)→ `funDownload` 拋錯,builder 取消該輪,`fdDwStorage` 與 `fdResult` 不變 | 「全部檔案皆失敗或 ls 失敗時取消該輪」 | 已做 |
| R-WD-03 | 結束前(`funBeforeEndNec`)只搬入已處理成功者:包裝 `funDownload`、`funGetCurrent` 記下本輪與比對基準之 hash(以 id 為鍵),包裝 `funAdd`/`funModify`/`funRemove` 於回傳而未拋錯時記下 id;**未處理之新增/變更**(hash 與比對基準不同且 id 不在成功記錄)不搬入——增量模式複製時略過、全量模式於暫存夾還原為 `fdDwStorage` 前次檔案(無則移除);**未處理之刪除**(全量模式比對基準有、本輪下載無、刪除不在成功記錄)自 `fdDwStorage` 補回暫存夾,使鏡像同步不刪;兩集合皆空(正常情形)時行為同舊。`vfpsDw`(搬移依據)須於下載與計算 hash 全部完成後才設定,下載階段中途失敗者不搬入。id 以自有鍵判定(`hasOwnProperty`),不用 lodash `has`(含點之檔名會被當路徑)。語意為「至少一次」:`funAdd`/`funModify`/`funRemove` 須可重複執行 | 「新增檔處理失敗而其後被略過」「變更檔處理失敗…」「主階段於處理前被取消」「刪除檔處理失敗」「伺服器刪除之檔遇主階段於比對前被取消」「刪除防抖」「下載完成後計算 hash 階段失敗」「檔名含點(log 與 log.1)」 | 已做 |
| R-WD-04 | 主階段於取得既有數據前即被取消(`funGetCurrent` 未完成)時,比對基準改取 `fdDwStorage` 內檔案之 hash,新增/變更/刪除一律視為未處理 | 「主階段於處理前被取消」「伺服器刪除之檔遇主階段於比對前被取消」 | 已做 |
| R-WD-05 | `retry`、`retryInterval`、`timeFile`、`timeRound`、`onTrace`、`debug`、`funLog` 原樣轉交 `downloadFiles`(轉傳之鍵由下游檢測);自身各 opt 鍵同 R-DL-09 檢測並於 `debug` 時警告;`move-files-to-storage` 之錯誤文字經遮罩 | 「retry、onTrace 等…原樣傳給」「timeFile 原樣傳給」「opt.debug 為 true 時…」 | 已做;`move-files-to-storage` 錯誤文字之遮罩路徑未涵蓋(檔案系統錯誤不含網路憑證,無法以假伺服器觸發) |

## 3. 範圍外(本套件不處理,由他套件或使用端處理)

- 主階段逐項處理遇錯即停(壞檔使其後各檔每輪被略過):屬 w-data-scheduler。
- builder 之 `fdDwAttime → fdDwCurrent` 無條件同步:屬 w-dwdata-builder;`WDwdataFtp` 預設比對基準為 `fdDwStorage`,不受影響,使用端若自給以 `fdDwCurrent` 為基準之 `funGetCurrent` 須自行留意。
- 以鏡像方式同步 `downloadFiles` 結果之使用端(清單內沒有即刪除):須自行處理 `failed` 內之檔案(例如沿用前次檔案),否則失敗之檔會被視為已刪除。

## 4. wsemi 列舉函數之用法(`fsTreeFolder`、`fsTreeFolderWithHash` 等)

> 需求出處:wsemi 1.9.80 起列舉函數之第 2 參數由 `levelLimit`(舊預設 1 層)改為 `opt = {}`,`opt.levelLimit` 為有效正整數才限層,**未給即窮舉全部層級**;給了而非物件(含舊寫法之數字)拋 `invalid opt: must be an object`;Gitea #220。
> 盤點指令(每處須為 `{ levelLimit: n }` 或表意窮舉之省略,不得為數字):`git grep -nE "\b(fsTreeFolder|fsTreeFolderWithHash|fsGetFilesInFolder|fsGetFilesWithHashInFolder|fsGetFoldersInFolder)(Core)?\s*\(" -- . ':!dist' ':!docs'`

| 條號 | 規則 | 判準 / 對應測試(`test/unit-downloadFail.test.mjs`) | 狀態 |
|---|---|---|---|
| R-WS-01 | 本套件 `src` 之 3 處列舉皆僅限第 1 層,寫為 `{ levelLimit: 1 }`,**不得省略第 2 參數**(省略即窮舉)、**不得傳數字**:`src/downloadFiles.mjs`(結束時收 `fdDwStorageTemp` 之檔案)、`src/WDwdataFtp.mjs`(失敗檔沿用前次檔案後取 `fdDwStorageTemp` 之檔案;`treeFolderAndGetFilesHash` 取比對基準之 hash,同時給 `type`、`forFile`、`forFolder` 於同一物件) | 盤點指令見本節表上方;測試各一案,於列舉前一刻(事件同步)或比對前於資料夾內建立子資料夾與第 2 層檔案 `ghost.txt`:「downloadFiles(SFTP): 結束時只收fdDwStorageTemp第1層之檔案」「WDwdataFtp(SFTP, 全量模式): 失敗檔沿用前次檔案後, 僅以fdDwStorageTemp第1層之檔案計算hash」「WDwdataFtp(SFTP, 全量/增量模式): 比對基準…只含第1層之項目」(與僅有空子資料夾之對照組比對結果相同);各站點改為省略或 `levelLimit: 2` 之變異皆使對應案轉紅 | 已做 |
| R-WS-02 | 測試內之列舉(`digestFolder`、`digestResult`、`partsLeft`、`fdDwStorageTemp` 之全層級列舉等)同用 `{ levelLimit: n }`;全層級列舉以 `{ levelLimit: 5 }` 表達(夾具深度不超過 2 層) | 同上盤點指令 | 已做 |
| R-WS-03 | 依賴 `wsemi` ≥ 1.9.80、`w-ftp` ≥ 1.0.76(w-ftp 1.0.76 起其內部列舉已改用新簽章) | `package.json` 之版本範圍 | 已做 |
