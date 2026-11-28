# w-dwdata-ftp 處理要點

> 業務端之特化要求與其處理流程。規則見 `sgud/rule/rulebook.md`,現況見 `sgud/state/state.md`。

## 1. 測試

- 全套:`npm test`(mocha,`test/*.test.mjs`)。假伺服器為 `test/lib/fakeSftpServer.mjs`、`test/lib/fakeFtpServer.mjs`(port 給 0 由系統指派,不連任何真實伺服器);各案之資料夾以 `./_<前綴>_*` 建於 cwd 並於測完自刪,測試不得留下 `_*` 資料夾。
- 故障注入:兩個假伺服器皆提供執行期變更故障設定之 `setFault`(SFTP:中途斷線 `breakOn`、`ls` 失敗、拒絕認證、停滯 `stallOn`;FTP:RETR 回 425、資料連線中途關閉 `truncateRetr`、`ls` 失敗、錯誤回覆附帶文字;兩者:`virtual` 虛擬檔案,列舉時原樣回報任意名稱且不讀寫實體檔)。新增故障形態時,先擴充假伺服器,再寫測試。
- 名稱類測試(`unit-serverNameDownload`)之沙盒建於 `test/_tmp/serverName/<案名>/`:目標名稱一律指向沙盒內(絕對路徑亦以沙盒路徑組成),沙盒目標資料夾須深至相對名稱上溯兩層仍在沙盒內;以沙盒全樹比對驗資料夾外無寫入與刪除;Windows 保留名之字面檔案由測試自行清除。植入變異時至少保留名稱層與落點層之一,避免變異碼寫到沙盒外。
- 時間相關之測試一律以 `opt.onTrace` 事件同步,不以延時;時間本身為規格者(整輪逾時)用 `node:test` 之 `mock.timers`(僅 `Date`);僅斷言下界者(重試間隔)以事件之相鄰時間差斷言。
- 每次改動下載或搬移邏輯後,全套與新增測試須於修前碼(鏡像根,僅複製檔案、不建目錄連結)為紅、修後為綠,並對關鍵邏輯逐項植入單點變異(錨點不存在或不唯一須報失敗)確認測試轉紅。

## 2. 依賴與設定

- `w-ftp` 須為 `^1.0.75` 以上(下載暫存與大小核對由 w-ftp 負責)。升 w-ftp 時比對其 `src/chkServerName.mjs` 之判準是否變動(內部模組,不引用),有變動即同步 `src/chkServerName.mjs`(R-SN-01～03)。
- `st.fdDownloadTemp` 不可位於 `fdDwStorageTemp` 內(每輪清空且列為成果)。未給時 w-ftp 預設為 cwd 相對之 `./_wftpDownloadTemp`,測試與使用端皆建議明給。
- `opt.timeFile`(預設 100000ms)對 SFTP 大檔自 w-ftp 1.0.75 起生效,大檔須自行給較大值;`opt.timeRound` 預設 0(不限),使用端宜依排程週期設定。`timeFile` 為 w-ftp 各操作(下載自傳輸開始起計、查詢遠端檔案資訊、列舉、連線、quit)各自之時限,非單次嘗試之總和:控制連線停滯時,一次嘗試加上失敗後之 quit 與重新連線之 `ls` 驗證,最壞可累計約 3～4 個 `timeFile`;一個一直逾時之壞檔最壞約 (1+`retry`)×(3～4)×`timeFile` + `retry`×`retryInterval`,故 `timeRound` 之實際結束時刻可能晚於設定值至多一次檔案之嘗試。

## 3. 使用端須知(破壞性變更)

- `downloadFiles` 之回傳由陣列改為 `{ files, failed }`。
- `WDwdataFtp` 之 `funAdd`、`funModify`、`funRemove` 須可重複執行(至少一次語意:未列於本輪結果 `success` 之項〔處理失敗,或函數成功而排程器任務狀態更新失敗〕與取消之輪未處理之項,下輪補處理)。
- `WDwdataFtp` 本輪取消(`msgCancel` 有值,含 `'no difference'`)時不搬移 `fdDwStorage`;自給 `funGetCurrent` 而比對基準領先 `fdDwStorage` 者,`fdDwStorage` 於下次有差異之輪才更新。
- `WDwdataFtp` 之使用端 `funBeforeEnd` 收到本輪結果 `{ success, failed, msgCancel }`;單項處理失敗不中止本輪(w-data-scheduler 1.0.77 起)。
- 以鏡像方式同步 `downloadFiles` 結果之使用端須自行處理 `failed`;其中 `name` 為空字串者為名稱被拒之檔(R-SN-04),含此類條目之輪不應刪除既有檔。
