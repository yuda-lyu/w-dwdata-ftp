import fs from 'fs'
import net from 'net'
import path from 'path'


/**
 * 啟動測試用之假FTP伺服器，供測試連線、列舉、下載、上傳與停滯情境
 *
 * mode='normal'：實作jsftp所需之最小指令集（FEAT/SYST/USER/PASS/TYPE/STAT/MLST/SIZE/PASV/RETR/STOR/CWD/PWD/MKD/QUIT），以fdRoot為根目錄
 * mode='stall'：僅回應登入，其後所有指令停滯不回應，且收到FIN不回關（allowHalfOpen），重現測站FTP停滯致行程無法退出之情境
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} [opt.mode='normal'] 輸入模式字串，'normal'或'stall'，預設'normal'
 * @param {String} [opt.fdRoot='.'] 輸入伺服器根目錄字串，客戶端所見路徑皆相對於此資料夾，stall模式不使用
 * @param {String} [opt.username='u1'] 輸入允許登入之帳號字串，預設'u1'
 * @param {String} [opt.password='p1'] 輸入允許登入之密碼字串，預設'p1'
 * @param {Integer} [opt.port=0] 輸入監聽port正整數，預設0代表由系統指派可用port
 * @param {String} [opt.failRetr=null] 輸入下載時令其失敗之檔名字串，伺服器對該檔之RETR回覆425(無法開啟數據連線)，用以模擬連上後下載失敗，預設null代表不失敗
 * @param {Integer} [opt.failRetrTimes=Infinity] 輸入failRetr最多失敗之次數，用盡後該檔即正常提供，用以模擬重試成功，預設Infinity(每次皆失敗)
 * @param {String} [opt.failRetrText=''] 輸入failRetr回覆425時附加之文字字串，用以模擬伺服器於錯誤回覆內帶入帳密等外來文字，預設''
 * @param {String} [opt.truncateRetr=null] 輸入下載時資料連線中途中斷之檔名字串，伺服器對該檔之RETR只送出前一半資料即硬關閉資料連線，控制連線回覆426，重現jsftp於中途關閉時download仍resolve而留下較小檔案之情境，預設null代表不中斷
 * @param {Integer} [opt.truncateRetrTimes=Infinity] 輸入truncateRetr最多中斷之次數，用盡後該檔即正常提供，預設Infinity(每次皆中斷)
 * @param {Boolean} [opt.failLs=false] 輸入是否令列舉資料夾(STAT資料夾)失敗之布林值，用以模擬ls失敗，預設false
 * @param {String} [opt.failLsText=''] 輸入failLs回覆550時附加之文字字串，用以模擬伺服器於錯誤回覆內帶入帳密等外來文字，預設''
 * @returns {Promise} 回傳Promise，resolve回傳伺服器物件，內含實際監聽port正整數、關閉伺服器函數close與執行期變更故障設定之函數setFault(物件，鍵同failRetr、failRetrTimes、failLs，未給之鍵不變)
 */
let fakeFtpServer = async (opt = {}) => {

    //mode
    let mode = opt.mode || 'normal'

    //fdRoot
    let fdRoot = path.resolve(opt.fdRoot || '.')

    //username
    let username = opt.username || 'u1'

    //password
    let password = opt.password || 'p1'

    //port, 0代表由系統指派可用port, 供mocha平行測試時避免衝突
    let port = opt.port || 0

    //fault, 故障注入設定, 預設全不啟用, 可由setFault於執行期變更, 供模擬連上後下載失敗與ls失敗
    let fault = {
        failRetr: opt.failRetr || null,
        failRetrTimes: Number.isInteger(opt.failRetrTimes) ? opt.failRetrTimes : Infinity,
        failRetrText: typeof opt.failRetrText === 'string' ? opt.failRetrText : '',
        truncateRetr: opt.truncateRetr || null,
        truncateRetrTimes: Number.isInteger(opt.truncateRetrTimes) ? opt.truncateRetrTimes : Infinity,
        failLs: opt.failLs === true,
        failLsText: typeof opt.failLsText === 'string' ? opt.failLsText : '',
    }

    //sockets, 記錄所有控制與數據socket, 供close時強制銷毀
    let sockets = new Set()

    //dsrvs, 記錄PASV數據伺服器, 供close時關閉
    let dsrvs = new Set()

    //resolveP, 將客戶端路徑依當前工作目錄轉為根目錄內實體路徑, 並限制不可逃逸至根目錄外
    let resolveP = (cwd, p) => {
        return path.resolve(fdRoot, '.' + path.posix.resolve(cwd, p || '.'))
    }

    //lsLines, 產生unix格式列表行, 供STAT回應, 行首空格為FTP多行回應之延續行格式
    let lsLines = (rp) => {
        return fs.readdirSync(rp).map((name) => {
            let st = fs.statSync(path.join(rp, name))
            let mark = st.isDirectory() ? 'd' : '-'
            return ` ${mark}rw-r--r-- 1 ftp ftp ${st.size} Jan 01 00:00 ${name}`
        })
    }

    //waitDs, 等待PASV數據連線建立
    let waitDs = (state) => {
        return new Promise((resolve) => {
            if (state.ds !== null) {
                resolve(state.ds)
                return
            }
            state.onDs = resolve
        })
    }

    //closeDsrv, 傳輸完成後關閉數據伺服器
    let closeDsrv = (state) => {
        if (state.dsrv !== null) {
            state.dsrv.close()
            dsrvs.delete(state.dsrv)
            state.dsrv = null
        }
        state.ds = null
    }

    //handleCmdStall, 停滯模式: 僅回應登入, 其後指令(含quit)一律不回應
    let handleCmdStall = (socket, state, line) => {
        let cmd = line.split(' ')[0].toUpperCase()
        if (cmd === 'USER') {
            socket.write('331 password required\r\n')
        }
        else if (cmd === 'PASS') {
            socket.write('230 logged in\r\n')
        }
    }

    //handleCmdNormal
    let handleCmdNormal = async (socket, state, line) => {
        let cmd = line.split(' ')[0].toUpperCase()
        let arg = line.slice(cmd.length + 1)
        if (cmd === 'FEAT') {
            socket.write('211-Features:\r\n MLST\r\n SIZE\r\n211 End\r\n')
        }
        else if (cmd === 'SYST') {
            socket.write('215 UNIX Type: L8\r\n')
        }
        else if (cmd === 'USER') {
            state.user = arg
            socket.write('331 password required\r\n')
        }
        else if (cmd === 'PASS') {
            if (state.user === username && arg === password) {
                state.authed = true
                socket.write('230 logged in\r\n')
            }
            else {
                socket.write('530 login incorrect\r\n')
            }
        }
        else if (cmd === 'TYPE') {
            socket.write('200 ok\r\n')
        }
        else if (!state.authed) {
            //未登入不得執行後續指令, 比照真實伺服器行為
            socket.write('530 not logged in\r\n')
        }
        else if (cmd === 'PWD') {
            socket.write('257 "/" is current directory\r\n')
        }
        else if (cmd === 'CWD') {
            state.cwd = path.posix.resolve(state.cwd, arg)
            socket.write('250 ok\r\n')
        }
        else if (cmd === 'MKD') {
            fs.mkdirSync(resolveP(state.cwd, arg), { recursive: true })
            socket.write(`257 "${arg}" created\r\n`)
        }
        else if (cmd === 'STAT') {
            let rp = resolveP(state.cwd, arg)
            if (!fs.existsSync(rp)) {
                socket.write('450 no such file or directory\r\n')
                return
            }
            let st = fs.statSync(rp)
            let lines
            if (st.isDirectory()) {
                if (fault.failLs) {
                    socket.write(`550 permission denied${fault.failLsText}\r\n`) //模擬ls失敗
                    return
                }
                lines = lsLines(rp)
            }
            else {
                let name = path.posix.basename(path.posix.resolve('/', arg))
                lines = [` -rw-r--r-- 1 ftp ftp ${st.size} Jan 01 00:00 ${name}`]
            }
            socket.write(`211-Status of ${arg}\r\n${lines.map((l) => l + '\r\n').join('')}211 End\r\n`)
        }
        else if (cmd === 'MLST') {
            let rp = resolveP(state.cwd, arg)
            if (!fs.existsSync(rp)) {
                socket.write('550 no such file or directory\r\n')
                return
            }
            let type = fs.statSync(rp).isDirectory() ? 'dir' : 'file'
            socket.write(`250-Listing ${arg}\r\n type=${type};modify=20240101000000.000; ${arg}\r\n250 End\r\n`)
        }
        else if (cmd === 'SIZE') {
            let rp = resolveP(state.cwd, arg)
            if (!fs.existsSync(rp) || fs.statSync(rp).isDirectory()) {
                socket.write('550 not a regular file\r\n')
                return
            }
            socket.write(`213 ${fs.statSync(rp).size}\r\n`)
        }
        else if (cmd === 'PASV') {
            state.ds = null
            let dsrv = net.createServer((ds) => {
                sockets.add(ds)
                ds.on('error', () => {})
                ds.on('close', () => {
                    sockets.delete(ds)
                })
                state.ds = ds
                if (state.onDs !== null) {
                    let f = state.onDs
                    state.onDs = null
                    f(ds)
                }
            })
            dsrvs.add(dsrv)
            state.dsrv = dsrv
            await new Promise((resolve) => {
                dsrv.listen(0, '127.0.0.1', resolve)
            })
            let p = dsrv.address().port
            socket.write(`227 Entering Passive Mode (127,0,0,1,${Math.floor(p / 256)},${p % 256})\r\n`)
        }
        else if (cmd === 'RETR') {
            let rp = resolveP(state.cwd, arg)
            if (!fs.existsSync(rp) || fs.statSync(rp).isDirectory()) {
                socket.write('550 no such file\r\n')
                return
            }
            if (fault.failRetr !== null && path.basename(rp) === fault.failRetr && fault.failRetrTimes > 0) {
                fault.failRetrTimes -= 1
                closeDsrv(state)
                socket.write(`425 can not open data connection${fault.failRetrText}\r\n`) //模擬連上後下載失敗
                return
            }
            socket.write('150 opening data connection\r\n')
            let ds = await waitDs(state)
            if (fault.truncateRetr !== null && path.basename(rp) === fault.truncateRetr && fault.truncateRetrTimes > 0) {
                //模擬資料連線中途中斷: 只送前一半後硬關閉資料連線, 控制連線回426
                fault.truncateRetrTimes -= 1
                ds.once('close', () => {
                    socket.write('426 connection closed; transfer aborted\r\n')
                    closeDsrv(state)
                })
                let buf = fs.readFileSync(rp)
                ds.write(buf.subarray(0, Math.floor(buf.length / 2)), () => {
                    setTimeout(() => {
                        ds.destroy()
                    }, 20)
                })
                return
            }
            ds.once('close', () => {
                socket.write('226 transfer complete\r\n') //數據socket關閉後須回最終回應, 完成jsftp之指令佇列
                closeDsrv(state)
            })
            ds.end(fs.readFileSync(rp))
        }
        else if (cmd === 'STOR') {
            let rp = resolveP(state.cwd, arg)
            socket.write('150 ok to send data\r\n')
            let ds = await waitDs(state)
            let chunks = []
            ds.on('data', (d) => {
                chunks.push(d)
            })
            ds.once('close', () => {
                fs.writeFileSync(rp, Buffer.concat(chunks))
                socket.write('226 transfer complete\r\n') //數據socket關閉後須回最終回應, 完成jsftp之指令佇列
                closeDsrv(state)
            })
        }
        else if (cmd === 'QUIT') {
            socket.write('221 goodbye\r\n')
            socket.end()
        }
        else {
            socket.write('502 command not implemented\r\n')
        }
    }

    //srv, stall模式使用allowHalfOpen, 收到客戶端FIN時socket維持半開不自動回關
    let srv = net.createServer({ allowHalfOpen: mode === 'stall' }, (socket) => {
        sockets.add(socket)
        socket.on('error', () => {}) //須catch, 避免客戶端斷線時拋出例外造成程序中止
        socket.on('close', () => {
            sockets.delete(socket)
        })
        let state = { cwd: '/', user: '', authed: false, ds: null, dsrv: null, onDs: null, buf: '' }
        socket.on('data', (d) => {
            state.buf += d.toString()
            let i
            while ((i = state.buf.indexOf('\r\n')) >= 0) {
                let line = state.buf.slice(0, i)
                state.buf = state.buf.slice(i + 2)
                if (mode === 'stall') {
                    handleCmdStall(socket, state, line)
                }
                else {
                    handleCmdNormal(socket, state, line)
                        .catch(() => {})
                }
            }
        })
        socket.write('220 fake ftp server ready\r\n')
    })

    //listen
    await new Promise((resolve) => {
        srv.listen(port, '127.0.0.1', resolve)
    })

    //close, 強制銷毀殘留socket(stall模式之半開socket不銷毀會使mocha無法結束)
    let close = async () => {
        for (let s of sockets) {
            s.destroy()
        }
        for (let d of dsrvs) {
            d.close()
        }
        return new Promise((resolve) => {
            srv.close(resolve)
        })
    }

    //setFault, 執行期變更故障注入設定, 未給之鍵不變
    let setFault = (o = {}) => {
        if ('failRetr' in o) {
            fault.failRetr = o.failRetr || null
        }
        if ('failRetrTimes' in o) {
            fault.failRetrTimes = Number.isInteger(o.failRetrTimes) ? o.failRetrTimes : Infinity
        }
        if ('truncateRetr' in o) {
            fault.truncateRetr = o.truncateRetr || null
        }
        if ('truncateRetrTimes' in o) {
            fault.truncateRetrTimes = Number.isInteger(o.truncateRetrTimes) ? o.truncateRetrTimes : Infinity
        }
        if ('failLs' in o) {
            fault.failLs = o.failLs === true
        }
    }

    return {
        port: srv.address().port,
        close,
        setFault,
    }
}


export default fakeFtpServer
