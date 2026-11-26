# w-dwdata-ftp 經驗

> 執行時累積之經驗,留給後續嘗試、執行、判斷。現況見 `sgud/state/state.md`,規則見 `sgud/rule/rulebook.md`。

## 2026-11 wsemi 列舉函數第 2 參數改為 opt(Gitea #220)

1. **舊寫法兩種形狀都要改**:第 2 參數為數字層數者(`fsTreeFolderWithHash` 另有第 3 參數 `{ type }` 之舊形)於新版拋錯(易見);**省略第 2 參數者(舊預設 1 層)靜默變窮舉**,盤點時須同時找出。`fsTreeFolderWithHash` 之舊第 3 參數併入同一物件:`{ levelLimit: 1, type, forFile, forFolder }`。
2. **層數語意測試之注入**:列舉點之前一刻有 `srLog.info` 事件者(`getVfps` 開始、`keep-previous-file` 完成),以該事件同步於資料夾內建立子資料夾與第 2 層檔案,比用延時可靠;沒有事件可用者(`fdDwStorage` 之比對基準)於兩輪之間直接放入。
3. **不要斷言「子資料夾項目本身」之處理**:`treeFolderAndGetFilesHash` 不濾除第 1 層之子資料夾項目(見 `sgud/state/state.md` 已知缺口),首版以「cmp 與舊值完全相同」斷言而在正確碼上失敗(多出 `stray` 之移除事件);改為與「僅有空子資料夾」之對照組逐項比對,只留第 2 層檔案這一個差別。
4. **變異/修前鏡像根跑 mocha 須加 `--exit`**:修前版對新 wsemi 大量失敗,各案之假伺服器未關而使 mocha 在印完結果後不退出,測試鎖與 `quiet-run` 一併被占住(約 10 分鐘);為自己起之行程,確認後以行程樹終止並回驗已消失。正式全套不加 `--exit`。

## 2026-11 下載失敗不交殘檔與只搬入已處理者(Gitea #216)

1. **w-ftp 1.0.75 起 `download` 自帶原子語意**:先寫唯一暫存檔(`<檔名>.<pid>.<隨機碼>.part`)、傳完且本機大小等於遠端才移至目標,失敗刪暫存並 reject;SFTP 之 `timeLimit` 與 `levelLimit` 自此生效。因此升級後,舊版所需之「失敗後刪殘檔」變為防禦性空操作;本套件仍保留「失敗後確認目標不存在」,以不依賴下層保證(測試以事件同步於失敗當下於目標寫入半截檔來驗證)。
2. **FTP 之 `conn` 不實際連線**:重新連線須再以 `ls` 驗證,否則 FTP 之重連失敗無從偵測。
3. **全量模式「清單內沒有即刪除」是最易被忽略之風險**:失敗之檔不在下載清單內,會被比對為已刪除而連動刪除 `fdResult` 並自 `fdDwStorage` 鏡像移除。沿用前次檔案之邏輯放在知道 `fdDwStorage` 之 `WDwdataFtp`,不放進 `downloadFiles` 之選項。
4. **主階段取消在比對之前時,比對基準尚未取得**:須自 `fdDwStorage` 計算 hash 作為基準,否則「伺服器已刪除而刪除尚未處理」之檔會被鏡像移除,下輪不再比對出刪除。
5. **`WDataScheduler` 之 `funRemove` 於防抖(`timeToleranceRemove > 0`)時仍即時呼叫**,防抖只影響其內部任務清單,故以「`funRemove` 回傳而未拋錯」記為已處理與無防抖時一致。
6. **測試鏡像根與預設暫存區**:以修前碼跑新測試(鏡像根)時,修前碼無 `st.fdDownloadTemp` 位置檢查,測試會把 `./_wftpDownloadTemp` 當 `fdDwStorageTemp` 而於 cwd 留下資料夾,使「預設暫存區」之測試於下次因資料夾已存在而誤判;該測試改以哨兵檔判定「未清空、未下載」,不依賴資料夾是否存在。測試中引用 `WDwdataFtp` 之預設資料夾(`./_result` 等)亦會於 cwd 留下資料夾,故測試一律給齊各資料夾,不以空字串觸發預設。
7. **測試中之外部事件同步**:下載失敗、重連失敗、整輪逾時等情境皆以 `opt.onTrace` 事件為同步點(例如於 `fail` 事件當下變更假伺服器之故障設定、推進假時鐘),不以延時;真實計時器之案(`timeFile` 停滯)門檻取 3000ms,遠大於本機小檔於負載下之下載耗時。
8. **新增之 src 檔與換行**:`src/` 兩個既有檔為 CRLF(`.editorconfig`),整檔重寫後須轉回 CRLF(否則整檔 diff);`Edit` 工具改既有 CRLF 檔時會保留換行。

## opt 讀取收斂至 wsemi `getOptReader`(2026-11-27,wsemi 1.9.82)

1. **`funLog` 第 2 引數之 `fn` 改為整個 tag**:自寫版為函數名(`'downloadFiles'`),wsemi 版為建立讀取器時給之 tag(`'w-dwdata-ftp downloadFiles'`);警告字樣 `[<tag>] invalid opt.<key>: must be …, using default …` 不變。斷言 `info.fn` 之測試須同改。
2. **去重表與 wsemi 內部共用**:測試前後重設一律用 `getOptReader.resetWarned()`;修前鏡像(自寫讀取器)下該函數重設不到自寫之去重集合,「重設後再警告」類案因此於修前轉紅,可作為接線證據。
3. **`downloadFiles` 之 `srLog` 讀取須在建立讀取器之後**:`rd.read('srLog')` 取代原 `readKey`,故 `rd` 之建立前移至函數開頭(`rd` 建立時讀 `opt.debug` 一次,不拋錯,順序不影響行為)。
4. **測試掛「讀取拋錯之存取器」須在 opt 最終物件上**:`runRound` 以展開語法合併 `optExtra` 時會即時讀取存取器而拋錯於測試自身,故加 `fnOpt` 參數,於傳給 `WDwdataFtp` 前才掛存取器。
5. **變異 `getOptReader(tag, {})`(讀取器不傳入 opt)使 32 案紅且耗時約 6 分鐘**(各案之重試等待):只跑接線相關之案可縮短,但全檔仍跑較能顯示殺傷面。
