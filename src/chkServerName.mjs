//本模組為伺服器回報之檔名(列舉結果)用於本機路徑前之檢查(單一擁有者, 規則R-SN-01～R-SN-03、R-SN-05), 判準依w-ftp(1.0.82)之syncToLocal(w-ftp未對外提供該檢查, 故本套件自行實作), 唯反斜線於各平台皆拒:
//  名稱須為單一名稱(非空字串、非'.'與'..'、不含'/'、反斜線與NUL); Windows另拒冒號、尾端之點與空白、保留裝置名(含加副檔名者)、僅大小寫不同之兩檔;
//  組出之本機路徑另以path.relative核對須嚴格位於目標資料夾內(不比字串前綴); 拒絕訊息為固定詞彙, 不回顯名稱
//反斜線於非Windows亦拒: 下載後處理名稱之各層不保證把它當一般字元, 勿為與w-ftp一致而放寬
import path from 'path'


//reDevice, Windows之保留裝置名(Microsoft〈Naming Files〉); 加副檔名者亦同(舊版Windows之路徑正規化視為裝置)
let reDevice = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\xB9\xB2\xB3]|lpt[0-9\xB9\xB2\xB3])$/i


//msgName, 名稱無法原樣存為目標資料夾內之單一檔案時之固定訊息
let msgName = `invalid name from the server: must be a file name that can be saved inside fdDwStorageTemp`


//msgCase, 本機不分大小寫而兩個遠端檔案落在同一本機路徑時之固定訊息
let msgCase = `invalid names from the server: must not differ only in letter case`


//isEntry, 名稱是否為單一檔名或資料夾名(各平台): 非空字串、非'.'與'..'、不含'/'、反斜線與NUL
let isEntry = (name) => {
    return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && name.indexOf('/') < 0 && name.indexOf('\\') < 0 && name.indexOf('\0') < 0
}


//isSavable, 名稱能否原樣存為本機資料夾內之單一項目: 非Windows同isEntry; Windows另拒冒號(磁碟代號、NTFS資料流)、尾端之點或空白(一般Win32程式會修剪而指向另一檔)、保留裝置名
let isSavable = (name, platform = process.platform) => {
    if (!isEntry(name)) {
        return false
    }
    if (platform !== 'win32') {
        return true
    }
    if (name.indexOf(':') >= 0 || /[. ]$/.test(name)) {
        return false
    }
    let base = name.split('.')[0].replace(/ +$/, '')
    return !reDevice.test(base)
}


//isInside, fp是否嚴格位於資料夾fd之內(不含fd本身), 以相對路徑判斷(不以字串前綴), pm為路徑模組(path.win32或path.posix)
let isInside = (fd, fp, pm = path) => {
    let rel = pm.relative(fd, fp)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${pm.sep}`) && !pm.isAbsolute(rel)
}


//fold, 逐字元轉小寫(長度不變者)作為不分大小寫之比對鍵(依w-ftp以NTFS實測之作法: 轉大寫會漏判'ᾳ'類並誤併'ı'與'i'、'ſ'與's')
let fold = (s) => {
    return Array.from(s, (c) => {
        let u = c.toLowerCase()
        return u.length === c.length ? u : c
    }).join('')
}


//splitNames, 分類伺服器回報之檔名, 供下載前判定: items為可下載者{ name, fp }(fp為核對通過之本機絕對路徑, 下載與清除殘檔即使用此值),
//  invalid為無法原樣存於fd內之名稱, clash為Windows上僅大小寫不同而落在同一本機檔之各名稱(全部不下載, 完全相同之重複列舉不算); 各陣列保留原順序
let splitNames = (fd, names, platform = process.platform, pm = path) => {

    //fdBase
    let fdBase = pm.resolve(fd)

    //items, invalid
    let items = []
    let invalid = []
    for (let name of names) {
        if (!isSavable(name, platform)) {
            invalid.push(name)
            continue
        }
        let fp = pm.resolve(fdBase, name)
        if (!isInside(fdBase, fp, pm)) { //落點須在fd之內(名稱檢查之外再核對解析結果)
            invalid.push(name)
            continue
        }
        items.push({ name, fp })
    }

    //clash, 本機不分大小寫(win32)時, 同一比對鍵有兩個以上不同名稱者
    let clash = []
    if (platform === 'win32') {
        let first = new Map()
        let bad = new Set()
        for (let v of items) {
            let k = fold(v.name)
            if (!first.has(k)) {
                first.set(k, v.name)
            }
            else if (first.get(k) !== v.name) {
                bad.add(k)
            }
        }
        clash = items.filter((v) => bad.has(fold(v.name))).map((v) => v.name)
        items = items.filter((v) => !bad.has(fold(v.name)))
    }

    return { items, invalid, clash }
}


//namesKeep, 供沿用前次檔案: 自本機列舉之檔名namesLocal取出與任一被拒名稱namesRejected指向同一本機檔者(Windows不分大小寫, 其他平台須完全相同);
//  回傳值皆取自namesLocal; 含反斜線之本機檔名不取(同isEntry)
let namesKeep = (namesLocal, namesRejected, platform = process.platform) => {
    let key = (s) => (platform === 'win32' ? fold(s) : s)
    let kp = new Set(namesRejected.filter((s) => typeof s === 'string').map(key))
    return namesLocal.filter((s) => s.indexOf('\\') < 0 && kp.has(key(s)))
}


let chkServerName = {
    msgName,
    msgCase,
    isEntry,
    isSavable,
    isInside,
    fold,
    splitNames,
    namesKeep,
}


export default chkServerName
