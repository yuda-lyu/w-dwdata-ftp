import w from 'wsemi'


/**
 * 刪除測試用之log資料夾，並回驗確實刪除
 *
 * w-syslog內部使用pino.transport於worker執行緒非同步寫檔，且未對外提供關閉或flush函數，
 * 故於程序結束後直接刪除資料夾，會因worker稍後才寫入而使資料夾被重建，須等待寫入完成再刪除並回驗
 *
 * @param {String} fdLog 輸入待刪除之log資料夾字串
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Integer} [opt.timeWait=200] 輸入每次刪除前之等待時長正整數，單位ms，預設200
 * @param {Integer} [opt.numTry=10] 輸入嘗試刪除次數正整數，預設10
 * @returns {Promise} 回傳Promise，resolve回傳是否確實刪除布林值
 */
let deleteLogFolder = async(fdLog, opt = {}) => {

    let timeWait = opt.timeWait || 200
    let numTry = opt.numTry || 10

    for (let i = 0; i < numTry; i++) {

        //等待worker將待寫入之log寫入完畢
        await w.delay(timeWait)

        w.fsDeleteFolder(fdLog)

        //回驗, 刪除不保證成功, 亦可能因worker寫入而被重建
        if (!w.fsIsFolder(fdLog)) {
            return true
        }

    }

    return false
}


export default deleteLogFolder
