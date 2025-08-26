import fs from 'fs'
import get from 'lodash-es/get.js'
import each from 'lodash-es/each.js'
import cloneDeep from 'lodash-es/cloneDeep.js'
import isbol from 'wsemi/src/isbol.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import pmSeries from 'wsemi/src/pmSeries.mjs'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import fsCopyFile from 'wsemi/src/fsCopyFile.mjs'
import fsCleanFolder from 'wsemi/src/fsCleanFolder.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import fsDeleteFolder from 'wsemi/src/fsDeleteFolder.mjs'
import fsTreeFolder from 'wsemi/src/fsTreeFolder.mjs'
import fsGetFileXxHash from 'wsemi/src/fsGetFileXxHash.mjs'
import WDwdataBuilder from 'w-dwdata-builder/src/WDwdataBuilder.mjs'
import downloadFiles from './downloadFiles.mjs'


/**
 * 下載FTP資料
 *
 * @param {String} st 輸入設定FTP連線資訊物件
 * @param {String} [st.transportation='FTP'] 輸入傳輸協定字串，可選'FTP'、'SFTP'，預設'FTP'
 * @param {String} [st.hostname=''] 輸入hostname字串，預設''
 * @param {Integer} [st.port=21|22] 輸入port正整數，當transportation='FTP'預設21，當transportation='SFTP'預設22
 * @param {String} [st.username=''] 輸入帳號字串，預設''
 * @param {String} [st.password=''] 輸入密碼字串，預設''
 * @param {String} [st.fdIni='./'] 輸入同步資料夾字串，預設'./'
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Boolean} [opt.useExpandOnOldFiles=false] 輸入來源檔案是否僅為增量檔案布林值，預設false
 * @param {String} [opt.fdDwStorageTemp='./_dwStorageTemp'] 輸入單次下載檔案存放資料夾字串，預設'./_dwStorageTemp'
 * @param {String} [opt.fdDwStorage='./_dwStorage'] 輸入合併儲存檔案資料夾字串，預設'./_dwStorage'
 * @param {String} [opt.fdDwAttime='./_dwAttime'] 輸入當前下載供比對hash用之數據資料夾字串，預設'./_dwAttime'
 * @param {String} [opt.fdDwCurrent='./_dwCurrent'] 輸入已下載供比對hash用之數據資料夾字串，預設'./_dwCurrent'
 * @param {String} [opt.fdResult='./_result'] 輸入已下載數據所連動生成數據資料夾字串，預設'./_result'
 * @param {String} [opt.fdTaskCpSrc='./_taskCpSrc'] 輸入任務狀態之來源端資料夾字串，預設'./_taskCpSrc'
 * @param {String} [opt.fdLog='./_logs'] 輸入儲存log資料夾字串，預設'./_logs'
 * @param {Function} [opt.funDownload=null] 輸入自定義當前下載之hash數據處理函數，回傳資料陣列，預設null
 * @param {Function} [opt.funGetCurrent=null] 輸入自定義已下載之hash數據處理函數，回傳資料陣列，預設null
 * @param {Function} [opt.funAdd=null] 輸入當有新資料時，需要連動處理之函數，預設null
 * @param {Function} [opt.funModify=null] 輸入當有資料需更新時，需要連動處理之函數，預設null
 * @param {Function} [opt.funRemove=null] 輸入當有資料需刪除時，需要連動處理之函數，預設null
 * @returns {Object} 回傳事件物件，可呼叫函數on監聽change事件
 * @example
 *
 * import w from 'wsemi'
 * import WDwdataFtp from './src/WDwdataFtp.mjs'
 *
 * let st = {
 *     'hostname': '{hostname}',
 *     'port': 21,
 *     'username': '{username}',
 *     'password': '{password}',
 *     'fdIni': './'
 * }
 * // console.log('st', st)
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
 * let fdResult = './_result'
 * w.fsCleanFolder(fdResult)
 *
 * let opt = {
 *     useExpandOnOldFiles: false, //true, false
 *     fdDwStorageTemp,
 *     fdDwStorage,
 *     fdDwAttime,
 *     fdDwCurrent,
 *     fdResult,
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
 * // change { event: 'proc-callfun-download', msg: 'start...' }
 * // change { event: 'proc-callfun-download', msg: 'done' }
 * // change { event: 'proc-callfun-getCurrent', msg: 'start...' }
 * // change { event: 'proc-callfun-getCurrent', msg: 'done' }
 * // change { event: 'compare', msg: 'start...' }
 * // change { event: 'compare', msg: 'done' }
 * // change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' }
 * // change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' }
 * // change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' }
 * // change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' }
 * // ...
 *
 */
let WDwdataFtp = async(st, opt = {}) => {

    //useExpandOnOldFiles
    let useExpandOnOldFiles = get(opt, 'useExpandOnOldFiles')
    if (!isbol(useExpandOnOldFiles)) {
        useExpandOnOldFiles = false
    }

    //useSimulateFiles, 供測試用, 檔案得預先給予至fdDwStorageTemp
    let useSimulateFiles = get(opt, 'useSimulateFiles')
    if (!isbol(useSimulateFiles)) {
        useSimulateFiles = false
    }

    //fdDwStorageTemp, 單次下載檔案存放資料夾
    let fdDwStorageTemp = get(opt, 'fdDwStorageTemp')
    if (!isestr(fdDwStorageTemp)) {
        fdDwStorageTemp = `./_dwStorageTemp`
    }
    if (!fsIsFolder(fdDwStorageTemp)) {
        fsCreateFolder(fdDwStorageTemp)
    }

    //fdDwStorage, 合併儲存檔案資料夾
    let fdDwStorage = get(opt, 'fdDwStorage')
    if (!isestr(fdDwStorage)) {
        fdDwStorage = `./_dwStorage`
    }
    if (!fsIsFolder(fdDwStorage)) {
        fsCreateFolder(fdDwStorage)
    }

    //fdDwAttime
    let fdDwAttime = get(opt, 'fdDwAttime')
    if (!isestr(fdDwAttime)) {
        fdDwAttime = `./_dwAttime`
    }
    if (!fsIsFolder(fdDwAttime)) {
        fsCreateFolder(fdDwAttime)
    }

    //fdDwCurrent
    let fdDwCurrent = get(opt, 'fdDwCurrent')
    if (!isestr(fdDwCurrent)) {
        fdDwCurrent = `./_dwCurrent`
    }
    if (!fsIsFolder(fdDwCurrent)) {
        fsCreateFolder(fdDwCurrent)
    }

    //fdResult
    let fdResult = get(opt, 'fdResult')
    if (!isestr(fdResult)) {
        fdResult = './_result'
    }
    if (!fsIsFolder(fdResult)) {
        fsCreateFolder(fdResult)
    }

    //fdTaskCpSrc
    let fdTaskCpSrc = get(opt, 'fdTaskCpSrc')
    if (!isestr(fdTaskCpSrc)) {
        fdTaskCpSrc = './_taskCpSrc'
    }
    if (!fsIsFolder(fdTaskCpSrc)) {
        fsCreateFolder(fdTaskCpSrc)
    }

    //fdLog
    let fdLog = get(opt, 'fdLog')
    if (!isestr(fdLog)) {
        fdLog = './_logs'
    }
    if (!fsIsFolder(fdLog)) {
        fsCreateFolder(fdLog)
    }

    //funDownload
    let funDownload = get(opt, 'funDownload')

    //funGetCurrent
    let funGetCurrent = get(opt, 'funGetCurrent')

    //funAdd
    let funAdd = get(opt, 'funAdd')

    //funModify
    let funModify = get(opt, 'funModify')

    //funRemove
    let funRemove = get(opt, 'funRemove')

    //treeFilesAndGetHashs
    let treeFilesAndGetHashs = (fd) => {

        //vfps
        let vfps = fsTreeFolder(fd, 1)
        // console.log('vfps', vfps)

        //ltdtHash
        let ltdtHash = []
        each(vfps, (v) => {
            let j = fs.readFileSync(v.path, 'utf8')
            let o = JSON.parse(j)
            ltdtHash.push(o)
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

    //funDownloadDef
    let funDownloadDef = async() => {

        //vfps, 為新增檔案清單, 其內path是指向fdDwStorageTemp內檔案, 執行完downloadFiles後檔案亦已有另外儲存至fdDwStorage
        let vfps = await downloadFiles(st, fdDwStorageTemp, fdDwStorage, {
            useExpandOnOldFiles,
            useSimulateFiles,
        })
        // console.log('vfps', vfps[0], size(vfps))

        //ltdtHashNewTemp, 計算檔案hash值, 為新hash
        let ltdtHashNewTemp = await pmSeries(vfps, async(v) => {
            let id = v.name //用檔名做id
            let hash = await fsGetFileXxHash(v.path) //檔案來源是位於fdDwStorageTemp
            return {
                id,
                hash,
            }
        })

        //ltdtHashNew
        let ltdtHashNew = []
        if (useExpandOnOldFiles) {

            //ltdtHashOld, 數據來源為fdDwCurrent, 為舊hash清單
            let ltdtHashOld = treeFilesAndGetHashs(fdDwCurrent)

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

        return ltdtHashNew
    }
    if (!isfun(funDownload)) {
        funDownload = funDownloadDef
    }

    //funGetCurrentDef
    let funGetCurrentDef = async() => {

        //ltdtHashOld, 數據來源為fdDwCurrent, 為舊hash清單
        let ltdtHashOld = treeFilesAndGetHashs(fdDwCurrent)
        // console.log('ltdtHashOld', ltdtHashOld)

        return ltdtHashOld
    }
    if (!isfun(funGetCurrent)) {
        funGetCurrent = funGetCurrentDef
    }

    //funRemoveDef
    let funRemoveDef = async(v) => {

        let fd = `${fdResult}/${v.id}`
        if (fsIsFolder(fd)) {
            fsDeleteFolder(fd)
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

        let fpStorage = `${fdDwStorage}/${v.id}` //fdDwStorage內v.id為實際檔案, fpStorage為指向實際檔案路徑
        let fpResult = `${fd}/${v.id}`
        fsCopyFile(fpStorage, fpResult)

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

        let fpStorage = `${fdDwStorage}/${v.id}` //fdDwStorage內v.id為實際檔案, fpStorage為指向實際檔案路徑
        let fpResult = `${fd}/${v.id}`
        fsCopyFile(fpStorage, fpResult)

    }
    if (!isfun(funModify)) {
        funModify = funModifyDef
    }

    //WDwdataBuilder
    let optBdr = {
        fdDwAttime,
        fdDwCurrent,
        fdResult,
        fdTaskCpSrc,
        fdLog,
        funDownload,
        funGetCurrent,
        funRemove,
        funAdd,
        funModify,
    }
    let ev = await WDwdataBuilder(optBdr)

    return ev
}


export default WDwdataFtp
