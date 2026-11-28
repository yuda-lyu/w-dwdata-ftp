import fs from 'fs'
import path from 'path'
import ssh2 from 'ssh2'


let { Server, utils } = ssh2
let { STATUS_CODE } = utils.sftp


/**
 * 啟動測試用之假SFTP伺服器，供測試連線與下載檔案
 *
 * 僅實作供w-ftp之CoreSFTP下載檔案所需指令，為唯讀伺服器，不支援上傳與刪除
 *
 * 主機金鑰於執行期即時生成，不需外部金鑰檔
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.fdRoot 輸入伺服器根目錄字串，客戶端所見路徑皆相對於此資料夾
 * @param {String} [opt.username='u1'] 輸入允許登入之帳號字串，預設'u1'
 * @param {String} [opt.password='p1'] 輸入允許登入之密碼字串，預設'p1'
 * @param {Integer} [opt.port=0] 輸入監聽port正整數，預設0代表由系統指派可用port
 * @param {String} [opt.breakOn=null] 輸入下載中途斷線之檔名字串，客戶端讀取該檔offset達breakAtBytes時伺服器即中斷該連線，用以模擬下載中途連線中斷，預設null代表不中斷
 * @param {Integer} [opt.breakAtBytes=65536] 輸入breakOn所指檔案開始中斷之offset位元組數，預設65536
 * @param {Integer} [opt.breakTimes=Infinity] 輸入breakOn最多中斷之連線次數，用盡後該檔即正常提供，用以模擬重連後重試成功，預設Infinity(每次皆中斷)
 * @param {Boolean} [opt.failLs=false] 輸入是否令列舉資料夾(OPENDIR)失敗之布林值，用以模擬ls失敗，預設false
 * @param {Boolean} [opt.denyAuth=false] 輸入是否拒絕所有認證之布林值，用以模擬(重新)連線失敗，預設false
 * @param {String} [opt.stallOn=null] 輸入下載停滯之檔名字串，客戶端讀取該檔之任何區塊時伺服器皆不回應(連線維持)，用以模擬下載逾時，預設null代表不停滯
 * @param {Array} [opt.virtual=[]] 輸入虛擬檔案陣列，各元素為{ name, content, fail }，列舉根目錄時附加於清單(name原樣回報，可為任意字串)，STAT、LSTAT、OPEN依名稱回應其內容，fail為true時OPEN回覆失敗；不讀寫實體檔案，預設[]
 * @returns {Promise} 回傳Promise，resolve回傳伺服器物件，內含實際監聽port正整數、關閉伺服器函數close與執行期變更故障設定之函數setFault(物件，鍵同breakOn、breakAtBytes、breakTimes、failLs、denyAuth、stallOn，未給之鍵不變)
 */
let fakeSftpServer = async(opt = {}) => {

    //fdRoot
    let fdRoot = path.resolve(opt.fdRoot)

    //username
    let username = opt.username || 'u1'

    //password
    let password = opt.password || 'p1'

    //port, 0代表由系統指派可用port, 供mocha平行測試時避免衝突
    let port = opt.port || 0

    //fault, 故障注入設定, 預設全不啟用, 可由setFault於執行期變更, 供模擬下載中途斷線與ls失敗
    let fault = {
        breakOn: opt.breakOn || null,
        breakAtBytes: Number.isInteger(opt.breakAtBytes) ? opt.breakAtBytes : 65536,
        breakTimes: Number.isInteger(opt.breakTimes) ? opt.breakTimes : Infinity,
        failLs: opt.failLs === true,
        denyAuth: opt.denyAuth === true,
        stallOn: opt.stallOn || null,
        virtual: Array.isArray(opt.virtual) ? opt.virtual : [],
    }

    //findVirtual, 依指令之路徑找虛擬檔案: 先比原樣('./name'或'name'), 再比解析後之路徑(解析為根目錄者不比)
    let findVirtual = (p) => {
        let v = fault.virtual.find((o) => p === `./${o.name}` || p === o.name)
        if (v) {
            return v
        }
        let rp = path.posix.resolve('/', p)
        if (rp === '/') {
            return null
        }
        return fault.virtual.find((o) => path.posix.resolve('/', `./${o.name}`) === rp) || null
    }

    //attrsVirtual, 虛擬檔案之屬性(一般檔案)
    let attrsVirtual = (v) => {
        return { mode: 0o100644, uid: 0, gid: 0, size: Buffer.byteLength(v.content), atime: 1700000000, mtime: 1700000000 }
    }

    //brokenClients, 已被中斷之連線, 每條連線至多計1次中斷
    let brokenClients = new WeakSet()

    //hostKeys, 執行期即時生成
    //ssh2(1.17.0)之generateKeyPairSync有1/256機率產生無法解析之金鑰, 故生成後須以parseKey回驗, 失敗則重生, 否則Server會拋出'Cannot parse privateKey: Malformed OpenSSH private key'
    //根因於ssh2/lib/keygen.js之parseDERs的ed25519分支: SPKI之BIT STRING內容為[unused-bits位元組0x00]+[32位元組公鑰], 應只跳過1個位元組,
    //但其以「移除所有開頭0x00」之迴圈處理, 當公鑰本身首位元組恰為0x00時(機率1/256)會被多剝一個位元組, 產出31位元組公鑰而不合法
    let kp = null
    for (let i = 0; i < 20; i++) {
        let kpTemp = utils.generateKeyPairSync('ed25519')
        if (!(utils.parseKey(kpTemp.private) instanceof Error)) {
            kp = kpTemp
            break
        }
    }
    if (kp === null) {
        throw new Error(`can not generate valid host key`)
    }

    //toReal, 將客戶端路徑轉為根目錄內實體路徑, 並限制不可逃逸至根目錄外
    let toReal = (p) => {
        return path.resolve(fdRoot, '.' + path.posix.resolve('/', p))
    }

    //toAttrs
    let toAttrs = (stat) => {
        return {
            mode: stat.mode,
            uid: 0,
            gid: 0,
            size: stat.size,
            atime: Math.floor(stat.atimeMs / 1000),
            mtime: Math.floor(stat.mtimeMs / 1000),
        }
    }

    //bindSftp
    let bindSftp = (sftp, client) => {

        //handles, 記錄已開啟之資料夾與檔案
        let handles = {}
        let nHandle = 0

        //onStat, STAT與LSTAT行為相同, 因不支援連結檔
        let onStat = (id, p) => {
            let v = findVirtual(p)
            if (v) {
                return sftp.attrs(id, attrsVirtual(v))
            }
            try {
                sftp.attrs(id, toAttrs(fs.statSync(toReal(p))))
            }
            catch (err) {
                sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
            }
        }

        sftp.on('REALPATH', (id, p) => {
            let rp = path.posix.resolve('/', p === '.' ? '/' : p)
            sftp.name(id, [{ filename: rp, longname: rp, attrs: {} }])
        })

        sftp.on('STAT', onStat)

        sftp.on('LSTAT', onStat)

        sftp.on('FSTAT', (id, h) => {
            let hd = handles[h.toString()]
            if (hd && hd.type === 'virtual') {
                return sftp.attrs(id, attrsVirtual(hd.v))
            }
            if (!hd || hd.type !== 'file') {
                return sftp.status(id, STATUS_CODE.FAILURE)
            }
            sftp.attrs(id, toAttrs(fs.fstatSync(hd.fd)))
        })

        sftp.on('OPENDIR', (id, p) => {
            if (fault.failLs) {
                return sftp.status(id, STATUS_CODE.FAILURE) //模擬ls失敗
            }
            let rp = toReal(p)
            if (!fs.existsSync(rp) || !fs.statSync(rp).isDirectory()) {
                return sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
            }
            let key = `d${nHandle}`
            nHandle += 1
            handles[key] = { type: 'dir', rp, hasRead: false }
            sftp.handle(id, Buffer.from(key))
        })

        sftp.on('READDIR', (id, h) => {
            let hd = handles[h.toString()]
            if (!hd || hd.type !== 'dir' || hd.hasRead) {
                return sftp.status(id, STATUS_CODE.EOF) //需回傳EOF告知客戶端已列舉完畢
            }
            hd.hasRead = true
            let names = fs.readdirSync(hd.rp).sort().map((name) => { //明確排序, 使各平台之列舉與下載順序一致
                let stat = fs.statSync(path.join(hd.rp, name))
                let mark = stat.isDirectory() ? 'd' : '-'
                return {
                    filename: name,
                    longname: `${mark}rw-r--r-- 1 user user ${stat.size} Jan 1 00:00 ${name}`,
                    attrs: toAttrs(stat),
                }
            })
            if (hd.rp === fdRoot) {
                names.push(...fault.virtual.map((v) => ({
                    filename: v.name,
                    longname: `-rw-r--r-- 1 user user ${Buffer.byteLength(v.content)} Jan 1 00:00 ${v.name}`,
                    attrs: attrsVirtual(v),
                })))
            }
            sftp.name(id, names)
        })

        sftp.on('OPEN', (id, p) => {
            let v = findVirtual(p)
            if (v) {
                if (v.fail === true) {
                    return sftp.status(id, STATUS_CODE.FAILURE)
                }
                let key = `v${nHandle}`
                nHandle += 1
                handles[key] = { type: 'virtual', v }
                return sftp.handle(id, Buffer.from(key))
            }
            try {
                let fd = fs.openSync(toReal(p), 'r') //唯讀
                let key = `f${nHandle}`
                nHandle += 1
                handles[key] = { type: 'file', fd, name: path.posix.basename(p) }
                sftp.handle(id, Buffer.from(key))
            }
            catch (err) {
                sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
            }
        })

        sftp.on('READ', (id, h, offset, len) => {
            let hd = handles[h.toString()]
            if (hd && hd.type === 'virtual') {
                let buf = Buffer.from(hd.v.content).subarray(offset, offset + len)
                if (buf.length === 0) {
                    return sftp.status(id, STATUS_CODE.EOF)
                }
                return sftp.data(id, buf)
            }
            if (!hd || hd.type !== 'file') {
                return sftp.status(id, STATUS_CODE.FAILURE)
            }
            if (fault.stallOn !== null && hd.name === fault.stallOn) {
                return //模擬下載停滯: 不回應此次讀取, 連線維持
            }
            if (fault.breakOn !== null && hd.name === fault.breakOn && offset >= fault.breakAtBytes && (fault.breakTimes > 0 || brokenClients.has(client))) {
                //模擬下載中途連線中斷, 不回應此次讀取; 稍待使已回應之區塊先送達客戶端, 令本機留下非空之殘檔
                if (!brokenClients.has(client)) {
                    brokenClients.add(client)
                    fault.breakTimes -= 1
                    setTimeout(() => {
                        client.end()
                    }, 30)
                }
                return
            }
            let buf = Buffer.alloc(len)
            let nRead = fs.readSync(hd.fd, buf, 0, len, offset)
            if (nRead === 0) {
                return sftp.status(id, STATUS_CODE.EOF)
            }
            sftp.data(id, buf.subarray(0, nRead))
        })

        sftp.on('CLOSE', (id, h) => {
            let key = h.toString()
            let hd = handles[key]
            if (hd && hd.type === 'file') {
                fs.closeSync(hd.fd)
            }
            delete handles[key]
            sftp.status(id, STATUS_CODE.OK)
        })

    }

    //srv
    let srv = new Server({ hostKeys: [kp.private] }, (client) => {
        client.on('authentication', (ctx) => {
            if (fault.denyAuth) {
                ctx.reject() //模擬連線失敗
            }
            else if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
                ctx.accept()
            }
            else if (ctx.method === 'none') {
                ctx.reject(['password']) //告知客戶端須使用password認證
            }
            else {
                ctx.reject()
            }
        })
        client.on('ready', () => {
            client.on('session', (accept) => {
                let session = accept()
                session.on('sftp', (accept) => {
                    bindSftp(accept(), client)
                })
            })
        })
        client.on('error', () => {}) //須catch, 避免客戶端斷線時拋出例外造成程序中止
    })

    //listen
    await new Promise((resolve) => {
        srv.listen(port, '127.0.0.1', resolve)
    })

    //close
    let close = async() => {
        return new Promise((resolve) => {
            srv.close(resolve)
        })
    }

    //setFault, 執行期變更故障注入設定, 未給之鍵不變
    let setFault = (o = {}) => {
        if ('breakOn' in o) {
            fault.breakOn = o.breakOn || null
        }
        if (Number.isInteger(o.breakAtBytes)) {
            fault.breakAtBytes = o.breakAtBytes
        }
        if ('breakTimes' in o) {
            fault.breakTimes = Number.isInteger(o.breakTimes) ? o.breakTimes : Infinity
        }
        if ('failLs' in o) {
            fault.failLs = o.failLs === true
        }
        if ('denyAuth' in o) {
            fault.denyAuth = o.denyAuth === true
        }
        if ('stallOn' in o) {
            fault.stallOn = o.stallOn || null
        }
        if ('virtual' in o) {
            fault.virtual = Array.isArray(o.virtual) ? o.virtual : []
        }
    }

    return {
        port: srv.address().port,
        close,
        setFault,
    }
}


export default fakeSftpServer
