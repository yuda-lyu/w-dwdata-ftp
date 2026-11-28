import fs from 'fs'
import get from 'lodash-es/get.js'
import size from 'lodash-es/size.js'
import each from 'lodash-es/each.js'
import map from 'lodash-es/map.js'
import filter from 'lodash-es/filter.js'
import cloneDeep from 'lodash-es/cloneDeep.js'
import isbol from 'wsemi/src/isbol.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import ispm from 'wsemi/src/ispm.mjs'
import cdbl from 'wsemi/src/cdbl.mjs'
import pmSeries from 'wsemi/src/pmSeries.mjs'
import getErrorMessage from 'wsemi/src/getErrorMessage.mjs'
import getOptReader from 'wsemi/src/getOptReader.mjs'
import getDiagSecrets from 'wsemi/src/getDiagSecrets.mjs'
import maskDiagText from 'wsemi/src/maskDiagText.mjs'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import fsIsFile from 'wsemi/src/fsIsFile.mjs'
import fsCopyFile from 'wsemi/src/fsCopyFile.mjs'
import fsDeleteFile from 'wsemi/src/fsDeleteFile.mjs'
import fsCleanFolder from 'wsemi/src/fsCleanFolder.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import fsDeleteFolder from 'wsemi/src/fsDeleteFolder.mjs'
import fsSyncFolder from 'wsemi/src/fsSyncFolder.mjs'
import fsTreeFolder from 'wsemi/src/fsTreeFolder.mjs'
import fsTreeFolderWithHash from 'wsemi/src/fsTreeFolderWithHash.mjs'
import fsGetFileBasicHash from 'wsemi/src/fsGetFileBasicHash.mjs'
import WDwdataBuilder from 'w-dwdata-builder/src/WDwdataBuilder.mjs'
import { downloadFilesCore } from './downloadFiles.mjs'
import chkServerName from './chkServerName.mjs'


/**
 * 基於檔案之下載FTP數據與任務建構器
 *
 * 執行階段最新hash數據放置於fdDwAttime，前次hash數據會於結束前自動備份至fdDwCurrent
 *
 * 執行階段最新數據放置於fdDwStorageTemp，前次數據放置於fdDwStorage，下載完成之輪於結束前會將fdDwStorageTemp內未變更與已處理成功之檔案搬入fdDwStorage(全量模式為鏡像同步，增量模式為複製)，再清空fdDwStorageTemp；本輪取消(結果之msgCancel有值，例如取得既有數據或比對階段錯誤、'no difference')時不搬移，fdDwStorage維持前次內容，僅清空fdDwStorageTemp
 *
 * 下載階段：逐檔下載，某檔失敗時重新連線後重試(opt.retry)，重試用盡之檔不視為整輪失敗，僅不納入本輪新下載檔案(全量模式沿用fdDwStorage內前次檔案，視為未變更，不會被當成已刪除)；連線、ls失敗或全部檔案皆失敗則取消該輪，詳見downloadFiles
 *
 * 伺服器回報之名稱不能原樣存為本機檔名者(判準見downloadFiles)不下載、不寫入任何檔；全量模式下fdDwStorage第1層若有指向同一本機檔之前次檔案(Windows檔名不分大小寫，其他平台須完全相同)，同樣沿用之(視為未變更)
 *
 * 主階段(funAdd、funModify、funRemove)逐項處理，某項拋錯或reject不中止本輪，其餘項照常處理(w-data-scheduler 1.0.77起)。是否處理成功以排程器交來之本輪結果success為準(與w-dwdata-builder更新fdDwCurrent一致)：未列於success之新增/變更檔不會搬入fdDwStorage，未列於success之刪除檔不會自fdDwStorage移除，含處理失敗者，以及函數成功而其後排程器之任務狀態更新失敗者(列於failed，msg為'failed to update task state')；下輪比對仍有差異而再處理，故為至少一次語意，funAdd、funModify、funRemove須可重複執行
 *
 * @param {String} st 輸入設定FTP連線資訊物件
 * @param {String} [st.transportation='FTP'] 輸入傳輸協定字串，可選'FTP'、'SFTP'，預設'FTP'
 * @param {String} [st.hostname=''] 輸入hostname字串，預設''
 * @param {Integer} [st.port=21|22] 輸入port正整數，當transportation='FTP'預設21，當transportation='SFTP'預設22
 * @param {String} [st.username=''] 輸入帳號字串，預設''
 * @param {String} [st.password=''] 輸入密碼字串，預設''
 * @param {String} [st.fdIni='./'] 輸入同步資料夾字串，預設'./'
 * @param {String} [st.fdDownloadTemp] 輸入w-ftp下載暫存區資料夾字串，經st原樣轉交downloadFiles，不得為opt.fdDwStorageTemp或其內，詳見downloadFiles
 * @param {Object} [opt={}] 輸入設定物件，預設{}；非預期之輸入視為未給改用預設
 * @param {Boolean} [opt.useExpandOnOldFiles=false] 輸入來源檔案是否僅為增量檔案布林值，預設false
 * @param {String} [opt.fdTagRemove='./_tagRemove'] 輸入暫存標記為刪除數據資料夾字串，預設'./_tagRemove'
 * @param {String} [opt.fdDwStorageTemp='./_dwStorageTemp'] 輸入最新下載檔案存放資料夾字串，預設'./_dwStorageTemp'
 * @param {String} [opt.fdDwStorage='./_dwStorage'] 輸入合併儲存檔案資料夾字串，預設'./_dwStorage'
 * @param {String} [opt.fdDwAttime='./_dwAttime'] 輸入當前下載供比對hash用之數據資料夾字串，預設'./_dwAttime'
 * @param {String} [opt.fdDwCurrent='./_dwCurrent'] 輸入已下載供比對hash用之數據資料夾字串，預設'./_dwCurrent'
 * @param {String} [opt.fdResult=`./_result`] 輸入已下載數據所連動生成數據資料夾字串，預設`./_result`
 * @param {String} [opt.fdTaskCpActualSrc='./_taskCpActualSrc'] 輸入任務狀態之來源端完整資料夾字串，預設'./_taskCpActualSrc'
 * @param {String} [opt.fdTaskCpSrc='./_taskCpSrc'] 輸入任務狀態之來源端資料夾字串，預設'./_taskCpSrc'
 * @param {Function} [opt.funDownload=null] 輸入取得最新下載檔案hash之函數，回傳資料陣列，預設null
 * @param {Function} [opt.funGetCurrent=null] 輸入取得已下載檔案hash之函數，回傳資料陣列，預設null
 * @param {Function} [opt.funAdd=null] 輸入當有新資料時，需要連動處理之函數，預設null
 * @param {Function} [opt.funModify=null] 輸入當有資料需更新時，需要連動處理之函數，預設null
 * @param {Function} [opt.funRemove=null] 輸入當有資料需刪除時，需要連動處理之函數，預設null
 * @param {Function} [opt.funAfterStart=null] 輸入偵測程序剛開始啟動時，需要處理之函數，預設null
 * @param {Function} [opt.funBeforeEnd=null] 輸入偵測程序要結束前，需要處理之函數，不論前面各階段有無錯誤皆呼叫(w-dwdata-builder更新fdDwCurrent失敗時除外)，呼叫時fdDwStorage之搬移已執行完畢(本輪取消時不搬移；搬移失敗僅記錄於srLog.error之move-files-to-storage)，接收本輪結果物件{ success: { add, modify, remove }, failed, msgCancel }(由w-data-scheduler產生，經w-dwdata-builder轉交)：success各陣列為處理成功之id(檔名)，failed各項為{ id, mode, event, msg }，msgCancel為本輪取消訊息(例如下載或比對階段錯誤、'no difference')，否則為空字串；可為async函數，預設null
 * @param {Integer} [opt.retry=2] 輸入各檔下載失敗後最多重試次數之非負整數，每次重試前會先重新連線，0代表不重試，預設2，詳見downloadFiles
 * @param {Integer} [opt.retryInterval=2000] 輸入重試前等待毫秒數之非負整數，預設2000，詳見downloadFiles
 * @param {Integer} [opt.timeFile=100000] 輸入各檔單次下載之時限毫秒數之正整數，SFTP自w-ftp 1.0.75起亦受此時限約束，大檔須自行給較大值，預設100000，詳見downloadFiles
 * @param {Integer} [opt.timeRound=0] 輸入整輪逐檔下載之時限毫秒數之非負整數，0代表不限制，預設0，詳見downloadFiles
 * @param {Function} [opt.onTrace=null] 輸入觀察回調函數，轉交downloadFiles，供測試與診斷以事件同步，事件種類見downloadFiles，預設null
 * @param {Boolean} [opt.debug=false] 輸入是否於opt出現非預期輸入時輸出警告布林值，須恰為true才生效，警告為固定詞彙(不含輸入值)，同一鍵同一行程只警告一次，並轉交downloadFiles，預設false
 * @param {Function} [opt.funLog=null] 輸入警告之出口函數，格式為(msg, { fn, reason, key })=>{}，其中fn為警告來源之標籤'w-dwdata-ftp WDwdataFtp'(轉交給downloadFiles之鍵由其警告，標籤為'w-dwdata-ftp downloadFiles')，僅opt.debug為true時使用，未給則以console.warn輸出，預設null
 * @param {Number} [opt.timeToleranceRemove=0] 輸入刪除任務之防抖時長，單位ms，預設0，代表不使用
 * @param {Object} [opt.srLog=null] 輸入事件紀錄物件，需提供函數info、warn與error，各接收一紀錄物件，供下載FTP檔案與偵測數據變更時紀錄各階段事件，未提供時不進行紀錄，其中warn用於本輪有逐項處理失敗項(事件fail-items-stage-main)與成功項找不到數據檔(事件move-data-to-current)時之紀錄，預設null
 * @param {Boolean} [opt.useShowLog=true] 輸入是否於偵測數據變更過程將錯誤與取消訊息輸出至console布林值，下載FTP檔案階段本身不輸出至console，惟其錯誤往上拋出後仍受此設定影響，預設true
 * @returns {Object} 回傳事件物件，可呼叫函數on監聽change與end事件，end事件之監聽函數接收本輪結果物件(內容同opt.funBeforeEnd所接收者)
 * @example
 *
 * import w from 'wsemi'
 * import WDwdataFtp from './src/WDwdataFtp.mjs'
 *
 * let st = {
 *     'transportation': 'FTP',
 *     'hostname': '{hostname}',
 *     'port': 21,
 *     'username': '{username}',
 *     'password': '{password}',
 *     'fdIni': './'
 * }
 * // console.log('st', st)
 *
 * //fdTagRemove
 * let fdTagRemove = `./_tagRemove`
 * w.fsCleanFolder(fdTagRemove)
 *
 * //fdDwStorageTemp
 * let fdDwStorageTemp = `./_dwStorageTemp`
 * w.fsCleanFolder(fdDwStorageTemp)
 *
 * //fdDwStorage
 * let fdDwStorage = `./_dwStorage`
 * w.fsCleanFolder(fdDwStorage)
 *
 * //fdDwAttime
 * let fdDwAttime = `./_dwAttime`
 * w.fsCleanFolder(fdDwAttime)
 *
 * //fdDwCurrent
 * let fdDwCurrent = `./_dwCurrent`
 * w.fsCleanFolder(fdDwCurrent)
 *
 * //fdResult
 * let fdResult = `./_result`
 * w.fsCleanFolder(fdResult)
 *
 * //fdTaskCpActualSrc
 * let fdTaskCpActualSrc = `./_taskCpActualSrc`
 * w.fsCleanFolder(fdTaskCpActualSrc)
 *
 * //fdTaskCpSrc
 * let fdTaskCpSrc = `./_taskCpSrc`
 * w.fsCleanFolder(fdTaskCpSrc)
 *
 * let opt = {
 *     useExpandOnOldFiles: false, //true, false
 *     fdTagRemove,
 *     fdDwStorageTemp,
 *     fdDwStorage,
 *     fdDwAttime,
 *     fdDwCurrent,
 *     fdResult,
 *     fdTaskCpActualSrc,
 *     fdTaskCpSrc,
 *     // funDownload,
 *     // funGetCurrent,
 *     // funRemove,
 *     // funAdd,
 *     // funModify,
 * }
 * let ev = await WDwdataFtp(st, opt)
 *     .catch((err) => {
 *         console.log(err)
 *     })
 * ev.on('change', (msg) => {
 *     delete msg.type
 *     console.log('change', msg)
 * })
 * // change { event: 'start', msg: 'running...' }
 * // change { event: 'proc-callfun-afterStart', msg: 'start...' }
 * // change { event: 'proc-callfun-afterStart', msg: 'done' }
 * // change { event: 'proc-callfun-download', msg: 'start...' }
 * // change { event: 'proc-callfun-download', num: 2, msg: 'done' }
 * // change { event: 'proc-callfun-getCurrent', msg: 'start...' }
 * // change { event: 'proc-callfun-getCurrent', num: 0, msg: 'done' }
 * // change { event: 'proc-compare', msg: 'start...' }
 * // change { event: 'proc-compare', numRemove: 0, numAdd: 2, numModify: 0, numSame: 0, msg: 'done' }
 * // change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' }
 * // change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' }
 * // change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' }
 * // change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' }
 * // ...
 *
 */
let WDwdataFtp = async(st, opt = {}) => {

    //rd, opt非預期之輸入視為未給改用預設, opt.debug為true時警告(dspec輸入參數之檢測機制K3), 一律經wsemi getOptReader(取值、檢測、警告之單一擁有者)
    let rd = getOptReader('w-dwdata-ftp WDwdataFtp', opt)

    //useExpandOnOldFiles
    let useExpandOnOldFiles = rd('useExpandOnOldFiles', false, isbol, 'a boolean', 'false')

    //fdTagRemove
    let fdTagRemove = rd('fdTagRemove', `./_tagRemove`, isestr, 'a non-empty string', `'./_tagRemove'`)

    //fdDwStorageTemp, 最新下載檔案存放資料夾
    let fdDwStorageTemp = rd('fdDwStorageTemp', `./_dwStorageTemp`, isestr, 'a non-empty string', `'./_dwStorageTemp'`)
    if (!fsIsFolder(fdDwStorageTemp)) {
        fsCreateFolder(fdDwStorageTemp)
    }

    //fdDwStorage, 合併儲存檔案資料夾
    let fdDwStorage = rd('fdDwStorage', `./_dwStorage`, isestr, 'a non-empty string', `'./_dwStorage'`)
    if (!fsIsFolder(fdDwStorage)) {
        fsCreateFolder(fdDwStorage)
    }

    //fdDwAttime
    let fdDwAttime = rd('fdDwAttime', `./_dwAttime`, isestr, 'a non-empty string', `'./_dwAttime'`)
    if (!fsIsFolder(fdDwAttime)) {
        fsCreateFolder(fdDwAttime)
    }

    //fdDwCurrent
    let fdDwCurrent = rd('fdDwCurrent', `./_dwCurrent`, isestr, 'a non-empty string', `'./_dwCurrent'`)
    if (!fsIsFolder(fdDwCurrent)) {
        fsCreateFolder(fdDwCurrent)
    }

    //fdResult
    let fdResult = rd('fdResult', `./_result`, isestr, 'a non-empty string', `'./_result'`)
    if (!fsIsFolder(fdResult)) {
        fsCreateFolder(fdResult)
    }

    //fdTaskCpActualSrc
    let fdTaskCpActualSrc = rd('fdTaskCpActualSrc', `./_taskCpActualSrc`, isestr, 'a non-empty string', `'./_taskCpActualSrc'`)
    if (!fsIsFolder(fdTaskCpActualSrc)) {
        fsCreateFolder(fdTaskCpActualSrc)
    }

    //fdTaskCpSrc
    let fdTaskCpSrc = rd('fdTaskCpSrc', './_taskCpSrc', isestr, 'a non-empty string', `'./_taskCpSrc'`)
    if (!fsIsFolder(fdTaskCpSrc)) {
        fsCreateFolder(fdTaskCpSrc)
    }

    //funDownload
    let funDownload = rd('funDownload', null, isfun, 'a function', 'the built-in function')

    //funGetCurrent
    let funGetCurrent = rd('funGetCurrent', null, isfun, 'a function', 'the built-in function')

    //funAdd
    let funAdd = rd('funAdd', null, isfun, 'a function', 'the built-in function')

    //funModify
    let funModify = rd('funModify', null, isfun, 'a function', 'the built-in function')

    //funRemove
    let funRemove = rd('funRemove', null, isfun, 'a function', 'the built-in function')

    //funAfterStartCall
    let funAfterStartCall = rd('funAfterStart', null, isfun, 'a function', 'null')

    //funBeforeEndCall
    let funBeforeEndCall = rd('funBeforeEnd', null, isfun, 'a function', 'null')

    //optDw, 下載FTP檔案之重試、時限、觀察回調與警告設定, 原樣傳給downloadFiles, 由其檢測與給予預設值(轉傳之鍵由下游檢測)
    let optDw = {
        retry: rd.read('retry'),
        retryInterval: rd.read('retryInterval'),
        timeFile: rd.read('timeFile'),
        timeRound: rd.read('timeRound'),
        onTrace: rd.read('onTrace'),
        debug: rd.debug,
        funLog: rd.funLog,
    }

    //timeToleranceRemove
    let timeToleranceRemove = rd('timeToleranceRemove', 0, isp0int, 'a non-negative integer', '0')
    timeToleranceRemove = cdbl(timeToleranceRemove)

    //srLog, 讀取拋錯(存取器)視為未給
    let srLog = rd.read('srLog')

    //useShowLog
    let useShowLog = rd('useShowLog', true, isbol, 'a boolean', 'true')

    //srLogInfo
    let srLogInfo = get(srLog, 'info', null)
    if (isfun(srLogInfo)) {
        srLogInfo = (...args) => {
            return srLog.info(...args)
        }
    }
    else {
        srLogInfo = () => {}
    }

    //srLogError
    let srLogError = get(srLog, 'error', null)
    if (isfun(srLogError)) {
        srLogError = (...args) => {
            return srLog.error(...args)
        }
    }
    else {
        srLogError = () => {}
    }

    //secrets, 帳密, 外來錯誤文字(檔案系統、後端之錯誤原文)經遮罩後才輸出(dspec診斷輸出與遮罩D1)
    let secrets = getDiagSecrets({ username: get(st, 'username'), password: get(st, 'password') })

    //getFilesHash
    let getFilesHash = async(vfps) => {

        //ltdtHash
        let ltdtHash = await pmSeries(vfps, async(v) => {
            let id = v.name //用檔名做id
            let hash = await fsGetFileBasicHash(v.path, { type: 'md5' })
            return {
                id,
                hash,
            }
        })

        return ltdtHash
    }

    //treeFolderAndGetFilesHash
    let treeFolderAndGetFilesHash = async (fd) => {

        //vfps
        let vfps = await fsTreeFolderWithHash(fd, { levelLimit: 1, type: 'md5', forFile: true, forFolder: false })

        //ltdtHash
        let ltdtHash = map(vfps, (v) => {
            let id = v.name //用檔名做id
            let hash = v.hash
            return {
                id,
                hash,
            }
        })

        return ltdtHash
    }

    //cvLtdtToKp
    let cvLtdtToKp = (ltdt) => {
        let kp = {}
        each(ltdt, (v) => {
            kp[v.id] = v.hash
        })
        return kp
    }

    //hasId, id是否為kp之自有鍵(不用lodash之has: 其以路徑解析鍵名, 含點之檔名如log.1會被誤判為log之索引)
    let hasId = (kp, id) => {
        return Object.prototype.hasOwnProperty.call(kp, id)
    }

    //mergeLtdt
    let mergeLtdt = (ltdtNew, ltdtOld) => {
        let kpNew = cvLtdtToKp(ltdtNew)
        let kpOld = cvLtdtToKp(ltdtOld)
        let kp = cloneDeep(kpOld)
        each(kpNew, (hash, id) => {
            kp[id] = hash
        })
        let ltdt = []
        each(kp, (hash, id) => {
            ltdt.push({
                id,
                hash,
            })
        })
        return ltdt
    }

    //vfpsDw
    let vfpsDw = []

    //funDownloadDef
    let funDownloadDef = async() => {

        //rDw, 下載所得, files為完整下載之新增檔案清單(檔案放置於fdDwStorageTemp內), failed為重試用盡仍失敗與名稱被拒(name為空字串)之檔案清單, namesRejected為名稱被拒之伺服器回報名稱
        let rDw = await downloadFilesCore(st, fdDwStorageTemp, {
            srLog,
            ...optDw,
        })

        //vfps, 本輪新增檔案清單, 須下載與計算hash皆完成才設為vfpsDw(結束前搬移之依據), 中途失敗者不得搬入
        let vfps = rDw.files
        // console.log('vfps', vfps[0], size(vfps))

        //keep, 全量模式下清單內沒有之檔案會被視為已刪除(比對後連動刪除fdResult內數據, 並自fdDwStorage鏡像移除),
        //故重試用盡仍失敗之檔案若fdDwStorage內有前次檔案, 複製進fdDwStorageTemp沿用(內容與fdDwStorage相同, 視為未變更), 無前次檔案者(新檔案)則僅不納入;
        //增量模式下fdDwStorage為累積存放不會被刪除, 不須沿用
        if (!useExpandOnOldFiles && size(rDw.failed) > 0) {
            each(rDw.failed, (v) => {
                let fpPrev = `${fdDwStorage}/${v.name}`
                if (fsIsFile(fpPrev)) {
                    let r = fsCopyFile(fpPrev, `${fdDwStorageTemp}/${v.name}`)
                    if (r.error) {
                        throw new Error(r.error)
                    }
                    srLogInfo({ event: 'keep-previous-file', name: v.name, msg: 'done' })
                }
            })
            //名稱被拒者, 僅沿用fdDwStorage第1層內指向同一本機檔之前次檔案(判定見chkServerName.namesKeep); 組路徑所用之名稱取自本機列舉, 伺服器回報之名稱只用於比對, 紀錄不含名稱
            let vfpsPrev = filter(fsTreeFolder(fdDwStorage, { levelLimit: 1 }), (v) => {
                return !v.isFolder
            })
            let namesKeep = new Set(chkServerName.namesKeep(map(vfpsPrev, 'name'), rDw.namesRejected))
            each(vfpsPrev, (v) => {
                if (!namesKeep.has(v.name)) {
                    return
                }
                let r = fsCopyFile(v.path, `${fdDwStorageTemp}/${v.name}`)
                if (r.error) {
                    throw new Error(r.error)
                }
            })
            if (namesKeep.size > 0) {
                srLogInfo({ event: 'keep-previous-file', num: namesKeep.size, msg: 'done' })
            }
            vfps = filter(fsTreeFolder(fdDwStorageTemp, { levelLimit: 1 }), (v) => {
                return !v.isFolder //僅使用檔案
            })
        }

        //check, 無檔案須報錯, 底層會中止與計算hash與計算檔案hash差異
        if (size(vfps) === 0) {
            throw new Error(`no files`)
        }

        //ltdtHashNewTemp, 計算新增檔案hash值
        let ltdtHashNewTemp = await getFilesHash(vfps)

        //ltdtHashNew
        let ltdtHashNew = []
        if (useExpandOnOldFiles) {

            //ltdtHashOld, 數據來源為fdDwStorage, 為舊hash清單
            let ltdtHashOld = await treeFolderAndGetFilesHash(fdDwStorage)

            //最新合併後檔案hash值清單
            ltdtHashNew = mergeLtdt(ltdtHashNewTemp, ltdtHashOld)

        }
        else {

            //當前下載檔案為全部檔案, 各檔案計算hash值皆須為新hash
            ltdtHashNew = ltdtHashNewTemp

        }
        // console.log('ltdtHashNew', ltdtHashNew)

        //清空fdDwAttime
        fsCleanFolder(fdDwAttime)

        //儲存新hash檔案至fdDwAttime
        each(ltdtHashNew, (v) => {

            //fp
            let fp = `${fdDwAttime}/${v.id}.json` //v.id雖為檔名但視為id使用, fdDwAttime與fdDwCurrent內檔案皆為對應hash檔案, 副檔名為.json

            //writeFileSync
            fs.writeFileSync(fp, JSON.stringify(v), 'utf8')

        })

        //vfpsDw, 為下載所得新增檔案清單, 檔案放置於fdDwStorageTemp內
        vfpsDw = vfps

        return ltdtHashNew
    }
    if (!isfun(funDownload)) {
        funDownload = funDownloadDef
    }

    //funGetCurrentDef
    let funGetCurrentDef = async() => {

        //ltdtHashOld, 數據來源為fdDwStorage, 為舊hash清單
        let ltdtHashOld = await treeFolderAndGetFilesHash(fdDwStorage)

        return ltdtHashOld
    }
    if (!isfun(funGetCurrent)) {
        funGetCurrent = funGetCurrentDef
    }

    //funRemoveDef
    let funRemoveDef = async(v) => {

        let fd = `${fdResult}/${v.id}`
        if (fsIsFolder(fd)) {

            let r = fsDeleteFolder(fd)

            if (r.error) {
                throw new Error(r.error)
            }

        }

    }
    if (!isfun(funRemove)) {
        funRemove = funRemoveDef
    }

    //funAddDef
    let funAddDef = async(v) => {

        let fd = `${fdResult}/${v.id}`
        if (!fsIsFolder(fd)) {
            fsCreateFolder(fd)
        }
        fsCleanFolder(fd)

        let fpStorage = `${fdDwStorageTemp}/${v.id}` //fdDwStorageTemp為新下載檔案, 使用v.id為實際檔案名稱
        let fpResult = `${fd}/${v.id}`
        let r = fsCopyFile(fpStorage, fpResult)

        if (r.error) {
            throw new Error(r.error)
        }

    }
    if (!isfun(funAdd)) {
        funAdd = funAddDef
    }

    //funModifyDef
    let funModifyDef = async(v) => {

        let fd = `${fdResult}/${v.id}`
        if (!fsIsFolder(fd)) {
            fsCreateFolder(fd)
        }
        fsCleanFolder(fd)

        let fpStorage = `${fdDwStorageTemp}/${v.id}` //fdDwStorageTemp為新下載檔案, 使用v.id為實際檔案名稱
        let fpResult = `${fd}/${v.id}`
        let r = fsCopyFile(fpStorage, fpResult)

        if (r.error) {
            throw new Error(r.error)
        }

    }
    if (!isfun(funModify)) {
        funModify = funModifyDef
    }

    //kpHashNew, kpHashCur, 本輪下載所得與funGetCurrent所得之檔案hash, 以id為鍵, 供結束前判斷哪些檔案為新增或變更
    let kpHashNew = null
    let kpHashCur = null
    let funDownloadOri = funDownload
    funDownload = async() => {
        let r = await funDownloadOri()
        kpHashNew = cvLtdtToKp(r)
        return r
    }
    let funGetCurrentOri = funGetCurrent
    funGetCurrent = async() => {
        let r = await funGetCurrentOri()
        kpHashCur = cvLtdtToKp(r)
        return r
    }

    //funBeforeEndNec, 依排程器交來之本輪結果res搬移fdDwStorageTemp內檔案至fdDwStorage
    let funBeforeEndNec = async(res) => {

        try {
            srLogInfo({ event: 'move-files-to-storage', msg: 'start...' })

            //check, 無檔案須報錯, 底層會中止與計算hash與計算檔案hash差異
            if (size(vfpsDw) === 0) {
                throw new Error(`no files`)
            }

            //check, 本輪取消(msgCancel有值, 例如取得既有數據或比對錯誤、'no difference')時不搬移, fdDwStorage維持前次內容(同w-dwdata-builder之fdDwCurrent)
            if (get(res, 'msgCancel') !== '') {
                fsCleanFolder(fdDwStorageTemp)
                srLogInfo({ event: 'move-files-to-storage', msg: 'round canceled, files are not moved' })
                return
            }

            //idsAddOk, idsRemoveOk, 本輪結果列為處理成功之新增/變更與刪除之檔案id, 未列於success者一律視為未處理成功(含函數成功而其後排程器任務狀態更新失敗者)
            let idsAddOk = new Set([...res.success.add, ...res.success.modify])
            let idsRemoveOk = new Set(res.success.remove)

            //idsAddFail, 本輪結果列為處理失敗之新增/變更檔案id, 自給funGetCurrent之項帶hash以外之欄位時, 排程器亦將hash相同者判為變更, 故不能僅以hash判斷
            let idsAddFail = new Set(res.failed.filter((v) => v.mode !== 'remove').map((v) => v.id))

            //idsPending, 新增或變更(與比對基準之hash不同, 或列於failed)而未處理成功之檔案id,
            //不得搬入fdDwStorage, 否則下輪比對為無差異而永遠不再處理
            let idsPending = new Set()
            each(kpHashNew, (hash, id) => {
                let isChanged = !hasId(kpHashCur, id) || kpHashCur[id] !== hash || idsAddFail.has(id)
                if (isChanged && !idsAddOk.has(id)) {
                    idsPending.add(id)
                }
            })

            //idsPendingRemove, 全量模式下比對基準有而本輪下載無(將被鏡像刪除)且刪除任務未處理成功之檔案id, 須保留於fdDwStorage使下輪再處理刪除
            let idsPendingRemove = new Set()
            if (!useExpandOnOldFiles) {
                each(kpHashCur, (hash, id) => {
                    if (!hasId(kpHashNew, id) && !idsRemoveOk.has(id)) {
                        idsPendingRemove.add(id)
                    }
                })
            }
            if (size(idsPending) > 0 || size(idsPendingRemove) > 0) {
                srLogInfo({ event: 'move-files-to-storage', num: size(idsPending), numRemove: size(idsPendingRemove), msg: 'unprocessed files are not moved' })
            }

            //useExpandOnOldFiles
            if (useExpandOnOldFiles) {
                //增量模式, 僅將新下載檔案儲存至fdDwStorage

                //複製fdDwStorageTemp內新下載檔案至合併儲存資料夾fdDwStorage, 未處理成功者不複製
                each(vfpsDw, (v) => {

                    //check
                    if (idsPending.has(v.name)) {
                        return
                    }

                    //fsCopyFile
                    let fpSrc = v.path
                    let fpTar = `${fdDwStorage}/${v.name}`
                    let r = fsCopyFile(fpSrc, fpTar)

                    //check
                    if (r.error) {
                        throw new Error(r.error)
                    }

                })

            }
            else {
                //全量模式, 將新下載檔案視為全部檔案並儲存至fdDwStorage

                //未處理成功之新增/變更檔, 於fdDwStorageTemp內還原為fdDwStorage內之前次檔案(無前次檔案者移除), 使其後之鏡像同步不變更之
                each([...idsPending], (id) => {
                    let fpPrev = `${fdDwStorage}/${id}`
                    let fpTemp = `${fdDwStorageTemp}/${id}`
                    let r = fsIsFile(fpPrev) ? fsCopyFile(fpPrev, fpTemp) : fsDeleteFile(fpTemp)
                    if (r.error) {
                        throw new Error(r.error)
                    }
                })

                //未處理成功之刪除檔, 自fdDwStorage補回fdDwStorageTemp, 使其後之鏡像同步不刪除之
                each([...idsPendingRemove], (id) => {
                    let fpPrev = `${fdDwStorage}/${id}`
                    if (fsIsFile(fpPrev)) {
                        let r = fsCopyFile(fpPrev, `${fdDwStorageTemp}/${id}`)
                        if (r.error) {
                            throw new Error(r.error)
                        }
                    }
                })

                //fsSyncFolder, 將fdDwStorageTemp完全同步至fdDwStorage
                await fsSyncFolder(fdDwStorageTemp, fdDwStorage)

            }

            //清空fdDwStorageTemp
            fsCleanFolder(fdDwStorageTemp)

            srLogInfo({ event: 'move-files-to-storage', msg: 'done' })
        }
        catch (err) {
            srLogError({ event: 'move-files-to-storage', msg: maskDiagText(getErrorMessage(err), secrets) })
        }

    }

    let funAfterStart = async() => {

        if (isfun(funAfterStartCall)) {
            let r = funAfterStartCall()
            if (ispm(r)) {
                r = await r
            }
        }

        //無funAfterStartNec

    }

    let funBeforeEnd = async(res) => {

        await funBeforeEndNec(res)

        if (isfun(funBeforeEndCall)) {
            let r = funBeforeEndCall(res) //res為w-dwdata-builder交來之本輪結果{ success, failed, msgCancel }, 原樣轉傳
            if (ispm(r)) {
                r = await r
            }
        }

    }

    let optBdr = {
        fdTagRemove,
        fdDwAttime,
        fdDwCurrent,
        fdTaskCpActualSrc,
        fdTaskCpSrc,
        srLog,
        useShowLog,
        funDownload,
        funGetCurrent,
        funRemove,
        funAdd,
        funModify,
        funAfterStart,
        funBeforeEnd,
        timeToleranceRemove,
    }
    let ev = await WDwdataBuilder(optBdr)

    return ev
}


export default WDwdataFtp
