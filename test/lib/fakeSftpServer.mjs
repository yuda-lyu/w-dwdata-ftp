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
 * @returns {Promise} 回傳Promise，resolve回傳伺服器物件，內含實際監聽port正整數與關閉伺服器函數close
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

    //hostKeys, 執行期即時生成
    let kp = utils.generateKeyPairSync('ed25519')

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
    let bindSftp = (sftp) => {

        //handles, 記錄已開啟之資料夾與檔案
        let handles = {}
        let nHandle = 0

        //onStat, STAT與LSTAT行為相同, 因不支援連結檔
        let onStat = (id, p) => {
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
            if (!hd || hd.type !== 'file') {
                return sftp.status(id, STATUS_CODE.FAILURE)
            }
            sftp.attrs(id, toAttrs(fs.fstatSync(hd.fd)))
        })

        sftp.on('OPENDIR', (id, p) => {
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
            let names = fs.readdirSync(hd.rp).map((name) => {
                let stat = fs.statSync(path.join(hd.rp, name))
                let mark = stat.isDirectory() ? 'd' : '-'
                return {
                    filename: name,
                    longname: `${mark}rw-r--r-- 1 user user ${stat.size} Jan 1 00:00 ${name}`,
                    attrs: toAttrs(stat),
                }
            })
            sftp.name(id, names)
        })

        sftp.on('OPEN', (id, p) => {
            try {
                let fd = fs.openSync(toReal(p), 'r') //唯讀
                let key = `f${nHandle}`
                nHandle += 1
                handles[key] = { type: 'file', fd }
                sftp.handle(id, Buffer.from(key))
            }
            catch (err) {
                sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
            }
        })

        sftp.on('READ', (id, h, offset, len) => {
            let hd = handles[h.toString()]
            if (!hd || hd.type !== 'file') {
                return sftp.status(id, STATUS_CODE.FAILURE)
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
            if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
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
                    bindSftp(accept())
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

    return {
        port: srv.address().port,
        close,
    }
}


export default fakeSftpServer
