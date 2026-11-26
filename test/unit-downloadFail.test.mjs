import fs from 'fs'
import crypto from 'crypto'
import { mock } from 'node:test'
import _ from 'lodash-es'
import w from 'wsemi'
import assert from 'assert'
import downloadFiles from '../src/downloadFiles.mjs'
import WDwdataFtp from '../src/WDwdataFtp.mjs'
import optReader from '../src/_optReader.mjs'
import fakeSftpServer from './lib/fakeSftpServer.mjs'
import fakeFtpServer from './lib/fakeFtpServer.mjs'


//規格(downloadFiles與WDwdataFtp之JSDoc):
//1. 逐檔下載, 某檔失敗(含下載中途連線中斷)時, 先quit再重新連線後重試該檔, 最多重試opt.retry次
//2. 重試用盡仍失敗之檔不視為整輪失敗: 其餘檔案照常下載與回傳, files與fdDwStorageTemp內只有完整之檔案(失敗之檔不留殘檔), 失敗之檔列於failed與srLog.error; 回傳為物件{ files, failed }
//3. 連線建立失敗、ls失敗、重新連線失敗、有檔案須下載而全部失敗(不交出空清單當成功), 皆為整輪失敗: reject, 並清空fdDwStorageTemp
//4. 下載中途截斷(FTP資料連線中途關閉)由w-ftp(1.0.75以上)核對大小而reject, 本套件視為該次失敗並重試
//5. WDwdataFtp全量模式下, 失敗之檔須沿用fdDwStorage內前次檔案視為未變更, 不得被當成已刪除而連動刪除fdDwStorage與fdResult內之數據; 整輪失敗時須取消該輪
//6. WDwdataFtp主階段(funAdd、funModify、funRemove)處理失敗、被略過或被取消時, 未處理成功之檔不搬入fdDwStorage(刪除未處理成功者不自fdDwStorage移除), 下輪補處理; 已處理成功者照常搬入
//7. opt.onTrace(觀察回調)於各事件同步呼叫, 回調之拋錯與rejection不影響結果; opt.debug為true時非預期之opt輸入警告(固定詞彙、不含輸入值); 外來錯誤文字遮罩帳密
//8. 列舉資料夾之wsemi函數(fsTreeFolder、fsTreeFolderWithHash)第2參數為opt, 本套件之3處列舉(downloadFiles結束時收檔、WDwdataFtp沿用前次檔案後取檔、WDwdataFtp取fdDwStorage之hash清單)皆僅限第1層(opt.levelLimit為1), 子資料夾內之檔案不列入
describe('downloadFail', function() {

    //names, 假伺服器第1層3個檔案, 依檔名排序下載: a1.txt、a2.bin(故障檔, 下載中途失敗)、a3.txt(故障檔之後之檔案)
    let names = ['a1.txt', 'a2.bin', 'a3.txt']

    //nameFail, 故障檔
    let nameFail = 'a2.bin'

    //retryInterval, 測試用重試間隔(ms), 縮短以加快測試
    let retryInterval = 10

    //pwSecret, 外來錯誤文字遮罩測試用之密碼(長度須至少4字元才列入對外遮罩清單)
    let pwSecret = 'pw-secret-9'

    //mkContent, 各檔內容依檔名與列序逐筆相異, 大小不同; a2.bin約400KB(超過SFTP假伺服器之中斷位置131072位元組)
    let mkContent = (name, nLine, tag = '') => {
        let ss = []
        for (let i = 0; i < nLine; i++) {
            ss.push(`${name}${tag}|line-${String(i).padStart(6, '0')}|${(i * 7919 + name.length * 31) % 10007}`)
        }
        return ss.join('\n')
    }
    let contents = {
        'a1.txt': mkContent('a1.txt', 3),
        'a2.bin': mkContent('a2.bin', 12000),
        'a3.txt': mkContent('a3.txt', 5),
        'log': mkContent('log', 2), //檔名含點且另一檔名為其前綴('log'與'log.1'), 供驗證id不被當成路徑解析
        'log.1': mkContent('log.1', 3),
    }

    //md5, 以雜湊代表檔案內容, 使失敗訊息不致輸出大量內容
    let md5 = (buf) => {
        return crypto.createHash('md5').update(buf).digest('hex')
    }

    //digestStr, 內容字串之雜湊
    let digestStr = (s) => {
        return md5(Buffer.from(s, 'utf8'))
    }

    //digestFolder, 取得資料夾第1層檔案之名稱與內容雜湊
    let digestFolder = (fd) => {
        let kp = {}
        w.fsTreeFolder(fd, { levelLimit: 1 }).forEach((v) => {
            if (!v.isFolder) {
                kp[v.name] = md5(fs.readFileSync(v.path))
            }
        })
        return kp
    }

    //digestResult, fdResult內各檔(在{id}/{id}之內)之內容雜湊
    let digestResult = (fd) => {
        let kp = {}
        w.fsTreeFolder(fd, { levelLimit: 1 }).forEach((v) => {
            if (v.isFolder) {
                kp[v.name] = md5(fs.readFileSync(`${v.path}/${v.name}`))
            }
        })
        return kp
    }

    //digestsOf, 各檔內容之雜湊, names限制取用之檔案
    let digestsOf = (cts, ns = names) => {
        return _.mapValues(_.pick(cts, ns), digestStr)
    }

    //kpProt, 各傳輸協定之假伺服器與其故障設定
    //SFTP之下載中途失敗為伺服器於讀取a2.bin達131072位元組時中斷連線(本機留下非空殘檔, 重現線上fastGet: Unexpected end event);
    //FTP之下載失敗為伺服器對a2.bin之RETR回覆425(連上後下載失敗); FTP之連線不實際建立, 故重新連線失敗以ls失敗模擬
    let kpProt = {
        SFTP: {
            fakeServer: fakeSftpServer,
            faultAlways: { breakOn: nameFail, breakAtBytes: 131072, breakTimes: Infinity },
            faultOnce: { breakOn: nameFail, breakAtBytes: 131072, breakTimes: 1 },
            faultNone: { breakOn: null, breakTimes: Infinity },
            faultLs: { failLs: true },
            faultLsNone: { failLs: false },
            faultNoConn: { denyAuth: true }, //無法(重新)連線
        },
        FTP: {
            fakeServer: fakeFtpServer,
            faultAlways: { failRetr: nameFail, failRetrTimes: Infinity },
            faultOnce: { failRetr: nameFail, failRetrTimes: 1 },
            faultNone: { failRetr: null, failRetrTimes: Infinity },
            faultLs: { failLs: true },
            faultLsNone: { failLs: false },
            faultNoConn: { failLs: true }, //重新連線時以ls驗證連線可用, 故以ls失敗模擬
        },
    }

    //envs, 各案建立之環境, 供afterEach兜底清理(各案之finally已清理者為空操作), 使setup中途失敗或斷言失敗時亦不於cwd留下資料夾
    let envs = []
    afterEach(async() => {
        for (let env of envs.splice(0)) {
            await env.clean()
        }
    })

    //setup, 建立假伺服器與各資料夾, tag各案互異避免平行測試時互相干擾, 回傳環境物件與清理函數clean
    let setup = async(tag, transportation, o = {}) => {
        let prot = kpProt[transportation]
        let files = _.get(o, 'files', names) //假伺服器上之檔案
        let optSrv = _.get(o, 'optSrv', {})
        let password = _.get(o, 'password', 'p1')
        let username = _.get(o, 'username', 'u1')

        //fds
        let base = `./_dlFail_${tag}`
        let fds = {
            fdSrv: `${base}_srv`,
            fdDwStorageTemp: `${base}_dwStorageTemp`,
            fdTagRemove: `${base}_tagRemove`,
            fdDwStorage: `${base}_dwStorage`,
            fdDwAttime: `${base}_dwAttime`,
            fdDwCurrent: `${base}_dwCurrent`,
            fdResult: `${base}_result`,
            fdTaskCpActualSrc: `${base}_taskCpActualSrc`,
            fdTaskCpSrc: `${base}_taskCpSrc`,
            fdWtemp: `${base}_wftpTemp`, //w-ftp之下載暫存區(經st.fdDownloadTemp轉交), 不得位於fdDwStorageTemp內
        }

        //clean, 冪等
        let isCleaned = false
        let env = { prot, fds, srv: null, st: null }
        env.clean = async() => {
            if (isCleaned) {
                return
            }
            isCleaned = true
            if (env.srv !== null) {
                await env.srv.close()
            }
            _.each(fds, (fd) => {
                w.fsDeleteFolder(fd)
            })
            w.fsDeleteFolder(`${fds.fdDwStorageTemp}_x`)
        }
        envs.push(env)

        _.each(fds, (fd) => {
            w.fsCleanFolder(fd)
        })

        //假伺服器之檔案
        _.each(files, (name) => {
            fs.writeFileSync(`${fds.fdSrv}/${name}`, contents[name], 'utf8')
        })

        //srv, port給0由系統指派, 避免平行測試時衝突
        env.srv = await prot.fakeServer({ fdRoot: fds.fdSrv, username, password, ...optSrv })

        //st, 連線至假伺服器
        env.st = {
            transportation,
            hostname: '127.0.0.1',
            port: env.srv.port,
            username,
            password,
            fdIni: '.',
            fdDownloadTemp: fds.fdWtemp,
        }

        return env
    }

    //dw, 執行downloadFiles並蒐集srLog(濾除逐檔進度)與onTrace事件, 回傳結果與紀錄, onTrace為事件當下同步呼叫之回調(供以事件同步地變更假伺服器之故障設定)
    let dw = async(env, optDw = {}, onTrace = null) => {
        let seq = []
        let trace = []
        let srLog = {
            info: (v) => {
                if (v.msg === 'running...' && v.event === 'ftp.syncToLocal') {
                    return
                }
                seq.push({ type: 'info', ...v })
            },
            error: (v) => {
                seq.push({ type: 'error', ...v })
            },
        }
        let onTraceAll = (e) => {
            trace.push(e)
            if (_.isFunction(onTrace)) {
                onTrace(e)
            }
        }
        let r = {}
        await downloadFiles(env.st, env.fds.fdDwStorageTemp, { srLog, retryInterval, onTrace: onTraceAll, ...optDw })
            .then((res) => {
                r.settled = 'resolved'
                r.res = res
                r.files = res.files
                r.names = _.map(res.files, 'name')
                r.failed = _.cloneDeep(res.failed)
            })
            .catch((err) => {
                r.settled = 'rejected'
                r.err = err
                r.msg = w.getErrorMessage(err)
            })
        r.seq = seq
        r.trace = trace

        //folder, 結束後fdDwStorageTemp內所有層級之檔案與資料夾
        r.folder = w.fsTreeFolder(env.fds.fdDwStorageTemp, { levelLimit: 5 }).map((v) => v.name).sort()

        return r
    }

    //cnt, 統計紀錄內符合條件者之數量
    let cnt = (seq, cond) => {
        return _.filter(seq, cond).length
    }

    //typesOf, 觀察回調事件之type序列
    let typesOf = (trace) => {
        return trace.map((e) => e.type)
    }

    //checkRoundFail, 驗證整輪失敗: reject, 暫存資料夾不留任何檔, 且錯誤已紀錄於core
    let checkRoundFail = (r) => {
        assert.ok(r.settled === 'rejected', `須reject而非resolve, 但為${r.settled}${r.names ? ' [' + r.names.join(',') + ']' : ''}`) //spec 3: 整輪失敗須reject
        assert.ok(w.isestr(r.msg), 'reject之錯誤訊息須為有效字串')
        assert.strict.deepEqual(r.folder, []) //spec 3: 清空fdDwStorageTemp
        assert.ok(cnt(r.seq, { type: 'error', event: 'core', msg: r.msg }) === 1, 'core須以同一錯誤訊息紀錄1次') //spec 3: 原錯誤往上傳遞
    }

    _.each(['SFTP', 'FTP'], (transportation) => {

        let prot = kpProt[transportation]
        let key = transportation.toLowerCase()

        it(`downloadFiles(${transportation}): 某檔一直失敗(重試用盡), 其他檔照常交出, 失敗之檔不留殘檔並列於failed, 回傳為{ files, failed }`, async () => {
            let env = await setup(`one_${key}`, transportation, { optSrv: prot.faultAlways })
            try {
                let r = await dw(env, { retry: 2 })

                //spec 2: 不視為整輪失敗, 僅交出完整之檔案(a2.bin失敗, 其後之a3.txt照常下載)
                assert.strict.deepEqual({
                    settled: r.settled,
                    keys: Object.keys(r.res).sort(),
                    isArray: Array.isArray(r.res),
                    names: r.names,
                    folder: r.folder,
                    content: digestFolder(env.fds.fdDwStorageTemp),
                }, {
                    settled: 'resolved',
                    keys: ['failed', 'files'],
                    isArray: false,
                    names: ['a1.txt', 'a3.txt'],
                    folder: ['a1.txt', 'a3.txt'], //失敗之a2.bin不得留有殘檔
                    content: digestsOf(contents, ['a1.txt', 'a3.txt']),
                })

                //spec 2: failed列出失敗之檔案與原因, attempts為1+retry
                assert.strict.deepEqual(_.map(r.failed, (v) => _.omit(v, 'msg')), [{ name: 'a2.bin', rpath: './a2.bin', attempts: 3 }])
                assert.ok(w.isestr(r.failed[0].msg), 'failed之msg須為有效字串')
                assert.ok(cnt(r.seq, { type: 'error', event: 'ftp.download', name: 'a2.bin', msg: `give up: ${r.failed[0].msg}` }) === 1, 'srLog.error須紀錄放棄該檔及原因')

                //spec 1: 各次失敗皆紀錄(attempt 1~3), 重試2次, 每次失敗後皆重新連線(含最後一次失敗後為下載a3.txt而重連, 故共3次)且皆成功
                assert.strict.deepEqual({
                    errAttempts: r.seq.filter((v) => v.type === 'error' && v.event === 'ftp.download' && v.attempt !== undefined).map((v) => v.attempt),
                    retries: cnt(r.seq, { type: 'info', event: 'ftp.download', msg: 'retry...' }),
                    reconnectStart: cnt(r.seq, { type: 'info', event: 'ftp.reconnect', msg: 'start...' }),
                    reconnectDone: cnt(r.seq, { type: 'info', event: 'ftp.reconnect', msg: 'done' }),
                    reconnectErr: cnt(r.seq, { type: 'error', event: 'ftp.reconnect' }),
                    quitDone: cnt(r.seq, { type: 'info', event: 'ftp.quit', msg: 'done' }),
                    errCore: cnt(r.seq, { type: 'error', event: 'core' }),
                }, {
                    errAttempts: [1, 2, 3],
                    retries: 2,
                    reconnectStart: 3,
                    reconnectDone: 3,
                    reconnectErr: 0,
                    quitDone: 1,
                    errCore: 0,
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): 僅下載fdIni第1層之檔案, 第2層以下之資料夾與檔案不落入暫存資料夾`, async () => {
            let env = await setup(`lv_${key}`, transportation)
            try {
                w.fsCreateFolder(`${env.fds.fdSrv}/sub`)
                fs.writeFileSync(`${env.fds.fdSrv}/sub/s1.txt`, 'sub-s1', 'utf8')
                let r = await dw(env)
                assert.strict.deepEqual({ settled: r.settled, names: r.names, folder: r.folder, failed: r.failed }, { settled: 'resolved', names, folder: names, failed: [] })
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): 下載中途失敗後重新連線重試成功, 3個檔案皆完整交出, failed為空`, async () => {
            let env = await setup(`rec_${key}`, transportation, { optSrv: prot.faultOnce })
            try {
                let r = await dw(env, { retry: 2 })
                assert.strict.deepEqual({
                    settled: r.settled,
                    names: r.names,
                    failed: r.failed,
                    content: digestFolder(env.fds.fdDwStorageTemp), //重試成功之檔案須為完整內容, 不得為前次之殘檔
                }, {
                    settled: 'resolved',
                    names,
                    failed: [],
                    content: digestsOf(contents),
                })
                assert.strict.deepEqual({
                    errAttempts: r.seq.filter((v) => v.type === 'error' && v.event === 'ftp.download').map((v) => v.attempt),
                    retries: cnt(r.seq, { type: 'info', event: 'ftp.download', msg: 'retry...' }),
                    reconnectStart: cnt(r.seq, { type: 'info', event: 'ftp.reconnect', msg: 'start...' }),
                    reconnectDone: cnt(r.seq, { type: 'info', event: 'ftp.reconnect', msg: 'done' }),
                }, {
                    errAttempts: [1],
                    retries: 1,
                    reconnectStart: 1,
                    reconnectDone: 1,
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): retry為0不重試, retry為數字字串者轉換後使用, retry非預期之輸入改用預設2`, async () => {
            let env = await setup(`rt0_${key}`, transportation, { optSrv: prot.faultAlways })
            try {
                let r0 = await dw(env, { retry: 0 })
                assert.strict.deepEqual({
                    names: r0.names,
                    attempts: _.map(r0.failed, 'attempts'),
                    retries: cnt(r0.seq, { event: 'ftp.download', msg: 'retry...' }),
                }, {
                    names: ['a1.txt', 'a3.txt'],
                    attempts: [1],
                    retries: 0,
                })

                //數字字串, 檢測之值即使用之值(K4)
                let r1 = await dw(env, { retry: '1' })
                assert.strict.deepEqual(_.map(r1.failed, 'attempts'), [2])

                //非預期之輸入視為未給, 改用預設2
                for (let v of ['abc', -1, 1.5, true, NaN, {}, [], 1e12 * 1e12]) {
                    let r = await dw(env, { retry: v })
                    assert.strict.deepEqual(_.map(r.failed, 'attempts'), [3])
                }
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): 列舉檔案(ls)失敗為整輪失敗, reject原錯誤且暫存資料夾不留任何檔`, async () => {
            let env = await setup(`ls_${key}`, transportation, { optSrv: prot.faultLs })
            try {
                let r = await dw(env)
                checkRoundFail(r)
                assert.ok(cnt(r.seq, { type: 'error', event: 'syncFiles', msg: r.msg }) === 1, 'syncFiles須紀錄同一錯誤') //spec 3
                assert.ok(cnt(r.seq, { type: 'info', event: 'ftp.quit', msg: 'done' }) === 1, '失敗後仍須執行quit')
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): 有檔案須下載而全部皆失敗為整輪失敗, 不交出空清單當成功, 錯誤帶failed`, async () => {
            let env = await setup(`all_${key}`, transportation, { files: [nameFail], optSrv: prot.faultAlways })
            try {
                let r = await dw(env, { retry: 1 })
                checkRoundFail(r)
                assert.strict.deepEqual({
                    all: /^all 1 files failed to download/.test(r.msg),
                    failed: _.map(_.get(r.err, 'failed'), (v) => _.pick(v, ['name', 'attempts'])),
                }, {
                    all: true,
                    failed: [{ name: 'a2.bin', attempts: 2 }],
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): 失敗後無法重新連線為整輪失敗, 已下載之a1.txt亦不留存`, async () => {
            let env = await setup(`rc_${key}`, transportation, { optSrv: prot.faultAlways })
            try {

                //於第1次下載失敗之事件當下(早於重新連線)令伺服器之後皆無法連線, 以事件同步不以延時
                let r = await dw(env, { retry: 2 }, (e) => {
                    if (e.type === 'fail' && e.attempt === 1) {
                        env.srv.setFault(prot.faultNoConn)
                    }
                })
                checkRoundFail(r)
                assert.strict.deepEqual({
                    reconnectErr: r.seq.filter((v) => v.type === 'error' && v.event === 'ftp.reconnect' && v.attempt !== undefined).map((v) => v.attempt),
                    reconnectTrace: r.trace.filter((e) => e.type === 'reconnect').map((e) => [e.ok, e.attempt]),
                    syncFilesErr: cnt(r.seq, { type: 'error', event: 'syncFiles', msg: r.msg }),
                }, {
                    reconnectErr: [1, 2, 3], //連線本身最多嘗試1+retry次
                    reconnectTrace: [[false, 1], [false, 2], [false, 3]],
                    syncFilesErr: 1,
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): 失敗後確認目標不存在殘檔(以事件同步於失敗當下於目標寫入半截檔, 模擬下層未清除), 該檔不得留存或交出`, async () => {
            let env = await setup(`rs_${key}`, transportation, { optSrv: prot.faultAlways })
            try {
                let fpStray = `${env.fds.fdDwStorageTemp}/${nameFail}`
                let r = await dw(env, { retry: 1 }, (e) => {
                    if (e.type === 'fail' && e.name === nameFail) {
                        fs.writeFileSync(fpStray, 'half-written', 'utf8') //模擬下層(w-ftp)失敗時於目標留下殘檔
                    }
                })
                assert.strict.deepEqual({
                    names: r.names,
                    folder: r.folder,
                    failed: _.map(r.failed, 'name'),
                    exists: fs.existsSync(fpStray),
                }, {
                    names: ['a1.txt', 'a3.txt'],
                    folder: ['a1.txt', 'a3.txt'],
                    failed: ['a2.bin'],
                    exists: false,
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`downloadFiles(${transportation}): onTrace事件依序同步通知(ls、attempt、fail、retry、reconnect、giveup、done), 事件為凍結物件且type外之欄位不含type`, async () => {
            let env = await setup(`tr_${key}`, transportation, { optSrv: prot.faultAlways })
            try {
                let r = await dw(env, { retry: 1 })
                let ts = r.trace

                //事件序列: a1.txt直接完成; a2.bin失敗後quit、重試(等待後重新連線)再失敗而放棄, 為a3.txt重新連線; a3.txt完成
                assert.strict.deepEqual(ts.map((e) => `${e.type}:${e.name || ''}:${e.attempt || e.attempts || e.num || ''}`), [
                    'ls::3',
                    'attempt:a1.txt:1',
                    'done:a1.txt:1',
                    'attempt:a2.bin:1',
                    'fail:a2.bin:1',
                    'retry:a2.bin:2',
                    'reconnect::1',
                    'attempt:a2.bin:2',
                    'fail:a2.bin:2',
                    'giveup:a2.bin:2',
                    'reconnect::1',
                    'attempt:a3.txt:1',
                    'done:a3.txt:1',
                ])
                assert.ok(ts.every((e) => Object.isFrozen(e)), '事件須為凍結物件')
                assert.ok(ts.every((e) => !_.some(_.omit(e, 'type'), (v, k) => k === 'type')), 'type外之欄位名不得為type')
                assert.strict.deepEqual(ts.filter((e) => e.type === 'reconnect').map((e) => e.ok), [true, true])
                assert.ok(w.isestr(ts.find((e) => e.type === 'fail').msg), 'fail事件須帶錯誤訊息')
            }
            finally {
                await env.clean()
            }
        })

    })

    it('downloadFiles(SFTP): 伺服器無任何檔案時resolve空之{ files, failed }(不視為失敗, 由使用端依需求處理)', async () => {
        let env = await setup('nf_sftp', 'SFTP', { files: [] })
        try {
            let r = await dw(env)
            assert.strict.deepEqual({ settled: r.settled, names: r.names, failed: r.failed, trace: typesOf(r.trace) }, { settled: 'resolved', names: [], failed: [], trace: ['ls'] })
        }
        finally {
            await env.clean()
        }
    })

    //FTP資料連線中途關閉(伺服器只送一半並回426): w-ftp 1.0.75以上於傳輸後核對大小而reject, 本套件視為失敗並重試, 用盡後該檔不交出且不留殘檔
    it('downloadFiles(FTP): 資料連線中途關閉每次皆截斷時, 該檔視為失敗(由w-ftp核對大小而reject)而重試, 用盡後不交出且不留殘檔', async () => {
        let env = await setup('tc_ftp', 'FTP', { optSrv: { truncateRetr: nameFail, truncateRetrTimes: Infinity } })
        try {
            let r = await dw(env, { retry: 1 })
            assert.strict.deepEqual({
                names: r.names,
                folder: r.folder,
                failed: _.map(r.failed, (v) => _.pick(v, ['name', 'attempts'])),
                content: digestFolder(env.fds.fdDwStorageTemp),
                partsLeft: w.fsTreeFolder(env.fds.fdWtemp, { levelLimit: 1 }).length, //w-ftp之暫存區不得殘留暫存檔
            }, {
                names: ['a1.txt', 'a3.txt'],
                folder: ['a1.txt', 'a3.txt'],
                failed: [{ name: 'a2.bin', attempts: 2 }],
                content: digestsOf(contents, ['a1.txt', 'a3.txt']),
                partsLeft: 0,
            })
        }
        finally {
            await env.clean()
        }
    })

    it('downloadFiles(FTP): 資料連線中途關閉僅1次時, 重試後取得完整檔案', async () => {
        let env = await setup('tc2_ftp', 'FTP', { optSrv: { truncateRetr: nameFail, truncateRetrTimes: 1 } })
        try {
            let r = await dw(env, { retry: 2 })
            assert.strict.deepEqual({
                names: r.names,
                failed: r.failed,
                content: digestFolder(env.fds.fdDwStorageTemp),
                errAttempts: r.seq.filter((v) => v.type === 'error' && v.event === 'ftp.download').map((v) => v.attempt),
            }, {
                names,
                failed: [],
                content: digestsOf(contents),
                errAttempts: [1],
            })
        }
        finally {
            await env.clean()
        }
    })

    //st.fdDownloadTemp為w-ftp之下載暫存區, 不得為fdDwStorageTemp或其內(暫存檔會被當成下載成果)
    it('downloadFiles: st.fdDownloadTemp為fdDwStorageTemp或其內時reject(不下載、訊息不回顯值), 位於其外時正常', async () => {
        let env = await setup('dt_sftp', 'SFTP')
        try {
            let fdIn = `${env.fds.fdDwStorageTemp}/sub_part`
            let msgs = []
            for (let fd of [env.fds.fdDwStorageTemp, fdIn, `${env.fds.fdDwStorageTemp}/../${_.last(env.fds.fdDwStorageTemp.split('/'))}`]) {
                await downloadFiles({ ...env.st, fdDownloadTemp: fd }, env.fds.fdDwStorageTemp, { retryInterval })
                    .then(() => {
                        msgs.push('resolved')
                    })
                    .catch((err) => {
                        msgs.push(w.getErrorMessage(err))
                    })
            }
            assert.strict.deepEqual(msgs, _.times(3, () => 'invalid st.fdDownloadTemp: must be outside of fdDwStorageTemp'))
            assert.strict.deepEqual(w.fsTreeFolder(env.fds.fdDwStorageTemp, { levelLimit: 5 }).length, 0) //未下載

            //位於其外(兄弟資料夾名稱僅前綴相同者亦屬其外)
            let r = await dw(env, { }, null)
            assert.strict.deepEqual({ settled: r.settled, names: r.names, folder: r.folder }, { settled: 'resolved', names, folder: names })
            let stSibling = { ...env.st, fdDownloadTemp: `${env.fds.fdDwStorageTemp}_x` }
            let r2 = await downloadFiles(stSibling, env.fds.fdDwStorageTemp, { retryInterval })
            assert.strict.deepEqual(_.map(r2.files, 'name'), names)
            w.fsDeleteFolder(`${env.fds.fdDwStorageTemp}_x`)
        }
        finally {
            await env.clean()
        }
    })

    it('downloadFiles: 未給st.fdDownloadTemp時w-ftp之預設暫存區為./_wftpDownloadTemp, 其為fdDwStorageTemp時reject且不清空、不下載', async () => {
        let env = await setup('dtd_sftp', 'SFTP')
        let fdDef = './_wftpDownloadTemp'
        let isNew = !fs.existsSync(fdDef)
        let fpSentinel = `${fdDef}/_sentinel_dtd.txt`
        try {

            //預設暫存區內放置哨兵檔: 若未於清空與下載前拒絕, 哨兵檔會被清空且資料夾內出現下載之檔案
            w.fsCreateFolder(fdDef)
            fs.writeFileSync(fpSentinel, 'keep', 'utf8')
            let stNo = _.omit(env.st, 'fdDownloadTemp')
            let msg = ''
            await downloadFiles(stNo, fdDef, { retryInterval })
                .catch((err) => {
                    msg = w.getErrorMessage(err)
                })
            assert.strict.deepEqual({ msg, names: w.fsTreeFolder(fdDef, { levelLimit: 1 }).map((v) => v.name).sort() }, { msg: 'invalid st.fdDownloadTemp: must be outside of fdDwStorageTemp', names: ['_sentinel_dtd.txt'] })
        }
        finally {
            if (fs.existsSync(fpSentinel)) {
                fs.unlinkSync(fpSentinel)
            }
            if (isNew) {
                w.fsDeleteFolder(fdDef)
            }
            await env.clean()
        }
    })

    //重試間隔: 僅斷言下界(受負載影響只會更慢不會更快, 依dspec計時器相關函數之觀察回調與測試P5), 以事件之相鄰時間差而非整案牆鐘
    it('downloadFiles(SFTP): 每次重試前至少等待retryInterval(以fail至retry事件之時間差斷言下界)', async () => {
        let env = await setup('ri_sftp', 'SFTP', { optSrv: kpProt.SFTP.faultAlways })
        try {
            let ts = {}
            let r = await dw(env, { retry: 2, retryInterval: 300 }, (e) => {
                let t = performance.now()
                if (e.type === 'fail') {
                    ts[`fail${e.attempt}`] = t
                }
                if (e.type === 'retry') {
                    ts[`retry${e.attempt}`] = t
                }
            })
            assert.ok(_.isEqual(_.map(r.failed, 'attempts'), [3]), '須重試至用盡(attempts為3)')
            for (let i of [2, 3]) {
                let dt = ts[`retry${i}`] - ts[`fail${i - 1}`]
                assert.ok(dt >= 298, `第${i}次嘗試前須至少等待300ms(容許計時誤差2ms), 實際${Math.round(dt)}ms`)
            }
        }
        finally {
            await env.clean()
        }
    })

    //各檔單次下載時限(timeFile): 以真實計時器, 門檻3000ms遠大於本機正常檔案之下載耗時(a1.txt、a3.txt於負載下亦遠低於此)
    it('downloadFiles(SFTP): 某檔下載停滯逾timeFile時視為該次失敗, 其餘檔案照常交出, 停滯檔不留殘檔', async function() {
        this.timeout(60000)
        let env = await setup('tf_sftp', 'SFTP', { optSrv: { stallOn: nameFail } })
        try {
            let r = await dw(env, { retry: 0, timeFile: 3000 })
            assert.strict.deepEqual({
                names: r.names,
                folder: r.folder,
                failed: _.map(r.failed, (v) => _.pick(v, ['name', 'attempts'])),
                timeout: /timeout/.test(_.get(r.failed, [0, 'msg'], '')),
                partsLeft: w.fsTreeFolder(env.fds.fdWtemp, { levelLimit: 1 }).length,
            }, {
                names: ['a1.txt', 'a3.txt'],
                folder: ['a1.txt', 'a3.txt'],
                failed: [{ name: 'a2.bin', attempts: 1 }],
                timeout: true,
                partsLeft: 0,
            })
        }
        finally {
            await env.clean()
        }
    })

    //無法連線(SFTP之conn會實際連線)為整輪失敗
    it('downloadFiles(SFTP): 連線建立失敗為整輪失敗, reject原錯誤, 凡conn過即執行至quit', async () => {
        let env = await setup('conn_sftp', 'SFTP', { optSrv: kpProt.SFTP.faultNoConn })
        try {
            let r = await dw(env)
            checkRoundFail(r)
            assert.strict.deepEqual({
                quitDone: cnt(r.seq, { type: 'info', event: 'ftp.quit', msg: 'done' }),
                reconnect: cnt(r.seq, { event: 'ftp.reconnect' }),
                trace: typesOf(r.trace),
            }, {
                quitDone: 1,
                reconnect: 0, //初次連線失敗不重試
                trace: [],
            })
        }
        finally {
            await env.clean()
        }
    })

    //整輪逾時
    it('downloadFiles(SFTP): 整輪時限(timeRound)逾時後不再下載, 未完成之檔案列為失敗, 已完整之檔案照常交出', async () => {
        let env = await setup('tr_sftp', 'SFTP')
        let timeRound = 60 * 1000
        try {

            //以假時鐘(僅Date)令a1.txt下載完成之當下逾時, 以事件同步不以延時
            mock.timers.enable({ apis: ['Date'], now: 1000000 })
            let r = await dw(env, { timeRound }, (e) => {
                if (e.type === 'done' && e.name === 'a1.txt') {
                    mock.timers.tick(timeRound + 1)
                }
            })
            mock.timers.reset()

            assert.strict.deepEqual({
                settled: r.settled,
                names: r.names,
                folder: r.folder,
                failed: _.map(r.failed, (v) => _.pick(v, ['name', 'attempts'])),
                msgs: _.uniq(_.map(r.failed, 'msg')),
                errTimeRound: cnt(r.seq, { type: 'error', event: 'ftp.syncToLocal', msg: `timeRound exceeded` }),
                trace: typesOf(r.trace),
                expired: r.trace.filter((e) => e.type === 'expired').map((e) => e.num),
            }, {
                settled: 'resolved',
                names: ['a1.txt'],
                folder: ['a1.txt'],
                failed: [{ name: 'a2.bin', attempts: 0 }, { name: 'a3.txt', attempts: 0 }],
                msgs: [`timeRound exceeded`],
                errTimeRound: 1,
                trace: ['ls', 'attempt', 'done', 'expired'],
                expired: [2],
            })
        }
        finally {
            mock.timers.reset()
            await env.clean()
        }
    })

    it('downloadFiles(SFTP): 整輪時限(timeRound)逾時時若無任何完整檔案則為整輪失敗', async () => {
        let env = await setup('tr2_sftp', 'SFTP', { optSrv: kpProt.SFTP.faultAlways, files: [nameFail] })
        let timeRound = 60 * 1000
        try {

            //第1次下載失敗之事件當下令整輪逾時, 不再重試
            mock.timers.enable({ apis: ['Date'], now: 1000000 })
            let r = await dw(env, { timeRound, retry: 5 }, (e) => {
                if (e.type === 'fail') {
                    mock.timers.tick(timeRound + 1)
                }
            })
            mock.timers.reset()
            checkRoundFail(r)
            assert.strict.deepEqual({
                attempts: _.map(_.get(r.err, 'failed'), 'attempts'),
                msgTail: /timeRound exceeded$/.test(_.get(r.err, ['failed', 0, 'msg'], '')),
            }, {
                attempts: [1],
                msgTail: true,
            })
        }
        finally {
            mock.timers.reset()
            await env.clean()
        }
    })

    //onTrace: 五種回調(未傳、紀錄器、拋錯、回傳rejection、非函數)結果須相同, 回調不帶接收者
    it('downloadFiles: onTrace之五種回調(未傳、紀錄器、拋錯、回傳rejection、非函數)結果相同且無未處理之rejection, 回調之this為undefined', async () => {
        let env = await setup('t5_sftp', 'SFTP', { optSrv: kpProt.SFTP.faultAlways })
        try {
            let thisSeen = []
            let kinds = {
                none: undefined,
                recorder: function(e) {
                    thisSeen.push(this === undefined)
                },
                thrower: () => {
                    throw new Error('trace callback error')
                },
                rejecter: () => {
                    return Promise.reject(new Error('trace callback rejection'))
                },
                notFun: 'not-a-function',
            }
            let outs = {}
            for (let [kind, cb] of Object.entries(kinds)) {
                let seq = []
                let r = await downloadFiles(env.st, env.fds.fdDwStorageTemp, {
                    srLog: { info: (v) => seq.push(v.event), error: (v) => seq.push(v.event) },
                    retry: 1,
                    retryInterval,
                    onTrace: cb,
                })
                outs[kind] = {
                    names: _.map(r.files, 'name'),
                    failed: _.map(r.failed, (v) => _.pick(v, ['name', 'attempts'])),
                    seq: _.filter(seq, (v) => v !== 'ftp.syncToLocal'),
                }
            }
            await w.delay(20) //讓回調之rejection有機會被處理(僅為令未處理之rejection現形, 非同步點)
            _.each(_.omit(outs, 'none'), (v, kind) => {
                assert.strict.deepEqual(v, outs.none, `${kind}之結果須與未傳回調者相同`)
            })
            assert.ok(thisSeen.length > 0 && thisSeen.every((b) => b), '回調之this須為undefined')
        }
        finally {
            await env.clean()
        }
    })

    //opt之K3與debug警告
    it('downloadFiles: opt非預期之輸入視為未給改用預設, opt.debug為true時以funLog警告(固定詞彙、不含輸入值、同一鍵只警告一次), 未給debug時不警告', async () => {
        let env = await setup('dbg_sftp', 'SFTP')
        try {
            let bad = 'bad-value-xyz'
            let optBad = { retry: bad, retryInterval: bad, timeFile: 0, timeRound: bad, onTrace: bad }

            //未給debug: 無警告(funLog不被呼叫)
            optReader.resetWarned()
            let logs0 = []
            let r0 = await dw(env, { ...optBad, funLog: (msg) => logs0.push(msg) })
            assert.strict.deepEqual({ settled: r0.settled, names: r0.names, logs: logs0 }, { settled: 'resolved', names, logs: [] })

            //debug非布林(視為false): 無警告
            let logsNb = []
            await dw(env, { ...optBad, debug: 'true', funLog: (msg) => logsNb.push(msg) })
            assert.strict.deepEqual(logsNb, [])

            //debug為true: 每個非預期之鍵警告1次
            let logs = []
            let infos = []
            let funLog = (msg, info) => {
                logs.push(msg)
                infos.push(info)
            }
            let r1 = await dw(env, { ...optBad, debug: true, funLog })
            assert.strict.deepEqual({ settled: r1.settled, names: r1.names }, { settled: 'resolved', names })
            assert.strict.deepEqual(logs, [
                '[w-dwdata-ftp downloadFiles] invalid opt.retry: must be a non-negative integer, using default 2',
                '[w-dwdata-ftp downloadFiles] invalid opt.retryInterval: must be a non-negative integer of milliseconds, using default 2000',
                '[w-dwdata-ftp downloadFiles] invalid opt.timeFile: must be a positive integer of milliseconds, using default 100000',
                '[w-dwdata-ftp downloadFiles] invalid opt.timeRound: must be a non-negative integer of milliseconds, using default 0',
                '[w-dwdata-ftp downloadFiles] invalid opt.onTrace: must be a function, using default null',
            ])
            assert.strict.deepEqual(infos, ['retry', 'retryInterval', 'timeFile', 'timeRound', 'onTrace'].map((key) => ({ fn: 'downloadFiles', reason: 'invalid', key })))
            assert.ok(logs.every((s) => s.indexOf(bad) < 0), '警告不得含輸入值')

            //同一鍵同一行程只警告1次
            let logs2 = []
            await dw(env, { ...optBad, debug: true, funLog: (msg) => logs2.push(msg) })
            assert.strict.deepEqual(logs2, [])

            //有效之輸入不警告(數字字串與0視為有效)
            optReader.resetWarned()
            let logs3 = []
            await dw(env, { retry: '1', retryInterval: '5', timeFile: '100000', timeRound: 0, onTrace: () => {}, debug: true, funLog: (msg) => logs3.push(msg) })
            assert.strict.deepEqual(logs3, [])

            //未給funLog時以console.warn輸出
            optReader.resetWarned()
            let m = mock.method(console, 'warn', () => {})
            try {
                await dw(env, { retry: bad, debug: true })
                assert.strict.deepEqual(m.mock.calls.map((c) => c.arguments), [['[w-dwdata-ftp downloadFiles] invalid opt.retry: must be a non-negative integer, using default 2']])
            }
            finally {
                m.mock.restore()
            }
        }
        finally {
            optReader.resetWarned()
            await env.clean()
        }
    })

    //opt本身與各鍵之讀取: null、非物件、讀取拋錯(存取器)皆視為未給
    it('downloadFiles: opt為null或非物件、或opt之鍵讀取拋錯(存取器)時皆視為未給改用預設, 不拋錯', async () => {
        let env = await setup('rk_sftp', 'SFTP', { optSrv: kpProt.SFTP.faultAlways })
        try {
            let optGetter = {}
            Object.defineProperty(optGetter, 'retry', {
                enumerable: true,
                get: () => {
                    throw new Error('getter error')
                },
            })
            Object.defineProperty(optGetter, 'retryInterval', { value: retryInterval, enumerable: true })
            Object.defineProperty(optGetter, 'srLog', {
                enumerable: true,
                get: () => {
                    throw new Error('getter error')
                },
            })

            //retry之讀取拋錯視為未給, 用預設2(各檔最多嘗試3次); 其餘鍵不受影響(retryInterval=10縮短等待)
            let r = await downloadFiles(env.st, env.fds.fdDwStorageTemp, optGetter)
            assert.strict.deepEqual(_.map(r.failed, 'attempts'), [3])

            //opt為null或非物件: 全部視為未給(無故障時不須等待)
            env.srv.setFault(kpProt.SFTP.faultNone)
            for (let o of [null, 'text', 123]) {
                let r2 = await downloadFiles(env.st, env.fds.fdDwStorageTemp, o)
                assert.strict.deepEqual({ names: _.map(r2.files, 'name'), failed: r2.failed }, { names, failed: [] })
            }
        }
        finally {
            await env.clean()
        }
    })

    //外來錯誤文字遮罩
    it('downloadFiles(FTP): 外來錯誤文字(伺服器回覆內含密碼)於srLog、onTrace、failed與reject之訊息皆遮罩, 非帳密之文字原樣保留', async () => {
        let env = await setup('mk_ftp', 'FTP', { password: pwSecret, optSrv: { failRetr: nameFail, failRetrTimes: Infinity, failRetrText: ` ${pwSecret}` } })
        let envCtl = await setup('mkc_ftp', 'FTP', { password: pwSecret, optSrv: { failRetr: nameFail, failRetrTimes: Infinity, failRetrText: ` other-text-9` } })
        try {

            //對照組: 伺服器回覆內之非帳密文字原樣出現於failed之訊息(證明下列斷言非空泛: 外來文字確實被帶入)
            let rc = await dw(envCtl, { retry: 0 })
            assert.ok(/425 can not open data connection other-text-9/.test(rc.failed[0].msg), `對照組之failed須帶伺服器回覆文字, 實際[${rc.failed[0].msg}]`)

            //a2.bin失敗(部分失敗): srLog、onTrace與failed之訊息皆不含密碼
            let r = await dw(env, { retry: 1 })
            let dump = JSON.stringify({ seq: r.seq, trace: r.trace, failed: r.failed })
            assert.ok(dump.indexOf(pwSecret) < 0, '訊息不得含密碼')
            assert.ok(/425 can not open data connection/.test(r.failed[0].msg), '遮罩後仍須保留錯誤之其餘文字')
            assert.ok(r.failed[0].msg.indexOf('***') >= 0, '密碼須以***取代')

            //全部失敗(整輪失敗): reject之訊息與failed皆不含密碼
            let envAll = await setup('mka_ftp', 'FTP', { password: pwSecret, files: [nameFail], optSrv: { failRetr: nameFail, failRetrTimes: Infinity, failRetrText: ` ${pwSecret}` } })
            try {
                let ra = await dw(envAll, { retry: 0 })
                assert.ok(ra.settled === 'rejected')
                let dumpAll = JSON.stringify({ seq: ra.seq, msg: ra.msg, failed: ra.err.failed })
                assert.ok(dumpAll.indexOf(pwSecret) < 0, '整輪失敗之訊息不得含密碼')
                assert.ok(/^all 1 files failed to download: 425 can not open data connection/.test(ra.msg))
            }
            finally {
                await envAll.clean()
            }

            //ls失敗(外來錯誤物件原樣往上拋): reject之錯誤經遮罩
            let envLs = await setup('mkl_ftp', 'FTP', { password: pwSecret, optSrv: { failLs: true, failLsText: ` ${pwSecret}` } })
            try {
                let rl = await dw(envLs)
                assert.ok(rl.settled === 'rejected')
                let dumpLs = JSON.stringify({ seq: rl.seq, msg: rl.msg, err: String(rl.err), stack: String(rl.err.stack) })
                assert.ok(dumpLs.indexOf(pwSecret) < 0, 'ls失敗之訊息不得含密碼')
                assert.ok(/550 permission denied/.test(rl.msg), '遮罩後仍須保留錯誤之其餘文字')
            }
            finally {
                await envLs.clean()
            }
        }
        finally {
            await env.clean()
            await envCtl.clean()
        }
    })

    it('downloadFiles(FTP): 外來錯誤文字內之單獨帳號於診斷輸出(srLog、onTrace之fail與放棄該檔之紀錄)皆遮罩', async () => {
        let usr = 'user-secret-9'
        let env = await setup('mku_ftp', 'FTP', { username: usr, optSrv: { failRetr: nameFail, failRetrTimes: Infinity, failRetrText: ` ${usr}` } })
        try {
            let r = await dw(env, { retry: 1 })
            let giveSeq = r.seq.filter((v) => v.type === 'error' && v.event === 'ftp.download' && v.attempts !== undefined)
            let giveTrace = r.trace.filter((e) => e.type === 'giveup')
            assert.strict.deepEqual({
                nFail: cnt(r.seq, { type: 'error', event: 'ftp.download', name: nameFail }),
                nGiveSeq: giveSeq.length,
                nGiveTrace: giveTrace.length,
                leak: JSON.stringify({ seq: r.seq, trace: r.trace }).indexOf(usr) >= 0,
                kept: /give up: 425 can not open data connection/.test(giveSeq[0].msg) && /^425 can not open data connection/.test(giveTrace[0].msg),
            }, {
                nFail: 3, //嘗試2次之失敗紀錄與放棄紀錄各自1筆
                nGiveSeq: 1,
                nGiveTrace: 1,
                leak: false,
                kept: true,
            })
        }
        finally {
            await env.clean()
        }
    })

    //runRound, 以WDwdataFtp執行一輪, 回傳change事件(濾除執行時間欄位)與srLog收到之info與error紀錄
    //onInfo為srLog.info之同步回調(供以事件同步地於指定階段注入故障)
    let runRound = async(env, optExtra = {}, onInfo = null) => {
        let pm = w.genPm()
        let ms = []
        let msInfo = []
        let msError = []
        let opt = {
            useExpandOnOldFiles: false,
            fdTagRemove: env.fds.fdTagRemove,
            fdDwStorageTemp: env.fds.fdDwStorageTemp,
            fdDwStorage: env.fds.fdDwStorage,
            fdDwAttime: env.fds.fdDwAttime,
            fdDwCurrent: env.fds.fdDwCurrent,
            fdResult: env.fds.fdResult,
            fdTaskCpActualSrc: env.fds.fdTaskCpActualSrc,
            fdTaskCpSrc: env.fds.fdTaskCpSrc,
            useShowLog: false,
            retryInterval,
            srLog: {
                info: (v) => {
                    msInfo.push(v)
                    if (_.isFunction(onInfo)) {
                        onInfo(v)
                    }
                },
                error: (v) => {
                    msError.push(v)
                },
            },
            ...optExtra,
        }
        let ev = await WDwdataFtp(env.st, opt)
        ev.on('change', (msg) => {
            let r = { ...msg }
            delete r.timeRunStart
            delete r.timeRunEnd
            delete r.timeRunSpent
            ms.push(r)
        })
        ev.on('end', () => {
            pm.resolve()
        })
        await pm
        return { ms, msInfo, msError }
    }

    //getCmp, 比對階段之統計
    let getCmp = (ms) => {
        return _.pick(_.find(ms, (m) => m.event === 'proc-compare' && m.msg === 'done'), ['numRemove', 'numAdd', 'numModify', 'numSame'])
    }

    //isMutating, 對fdDwStorage與fdResult做新增、變更或刪除之事件
    let isMutating = (m) => {
        return /^proc-(add|diff|remove)-/.test(m.event)
    }

    //checkCancel, 驗證整輪失敗須取消該輪: 僅1筆下載階段之錯誤事件, 有cancel-stage-main, 無比對與任何新增/變更/刪除事件
    let checkCancel = (ms) => {
        assert.strict.deepEqual({
            errors: ms.filter((m) => m.type === 'error').map((m) => m.event),
            canceled: _.some(ms, { event: 'cancel-stage-main', msg: 'error at proc-callfun-download' }),
            compared: _.some(ms, { event: 'proc-compare' }),
            mutating: ms.filter(isMutating).map((m) => `${m.event}:${m.id}`),
        }, {
            errors: ['proc-callfun-download'],
            canceled: true,
            compared: false,
            mutating: [],
        })
    }

    _.each([
        ['SFTP', false],
        ['FTP', false],
        ['SFTP', true],
        ['FTP', true],
    ], ([transportation, useExpandOnOldFiles]) => {

        let prot = kpProt[transportation]
        let mode = useExpandOnOldFiles ? '增量模式' : '全量模式'
        let key = `${transportation.toLowerCase()}_${useExpandOnOldFiles ? 'exp' : 'full'}`

        it(`WDwdataFtp(${transportation}, ${mode}): a2.bin一直下載失敗時其餘檔案照常更新, a2.bin沿用上一輪不被刪除或變更, 排除故障後恢復`, async () => {
            let env = await setup(`wd_${key}`, transportation)
            try {
                let optExtra = { useExpandOnOldFiles }
                let a1v2 = mkContent('a1.txt', 4, '-v2') //第2輪伺服器上a1.txt已變更
                let a2v3 = mkContent('a2.bin', 12001, '-v3') //第3輪伺服器上a2.bin已變更

                //第1輪: 正常, 3個檔案皆新增
                let round1 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    cmp: getCmp(round1.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    cmp: { numRemove: 0, numAdd: 3, numModify: 0, numSame: 0 },
                    storage: digestsOf(contents),
                    result: digestsOf(contents),
                })

                //第2輪: a2.bin一直失敗, a1.txt已變更; 其餘照常, 不得有錯誤事件或刪除, a2.bin維持第1輪內容
                env.srv.setFault(prot.faultAlways)
                fs.writeFileSync(`${env.fds.fdSrv}/a1.txt`, a1v2, 'utf8')
                let round2 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    errors: round2.ms.filter((m) => m.type === 'error').length,
                    cmp: getCmp(round2.ms),
                    mutating: round2.ms.filter(isMutating).map((m) => `${m.event}:${m.id}:${m.msg}`).sort(),
                    storage: digestFolder(env.fds.fdDwStorage), //spec 5: fdDwStorage內a2.bin不得被刪除或換成殘檔
                    result: digestResult(env.fds.fdResult), //spec 5: fdResult內a2.bin數據不得被刪除
                }, {
                    errors: 0,
                    cmp: { numRemove: 0, numAdd: 0, numModify: 1, numSame: 2 }, //a1.txt變更, a2.bin沿用視為未變更, a3.txt未變
                    mutating: ['proc-diff-callfun-modify:a1.txt:done', 'proc-diff-callfun-modify:a1.txt:start...'],
                    storage: { ...digestsOf(contents, ['a2.bin', 'a3.txt']), 'a1.txt': digestStr(a1v2) },
                    result: { ...digestsOf(contents, ['a2.bin', 'a3.txt']), 'a1.txt': digestStr(a1v2) },
                })

                //全量模式須有沿用上一輪檔案之紀錄, 增量模式不需要
                assert.strict.deepEqual(
                    round2.msInfo.filter((v) => v.event === 'keep-previous-file').map((v) => v.name),
                    useExpandOnOldFiles ? [] : ['a2.bin']
                )

                //第3輪: 故障排除且a2.bin已變更, a2.bin正常更新
                env.srv.setFault(prot.faultNone)
                fs.writeFileSync(`${env.fds.fdSrv}/a2.bin`, a2v3, 'utf8')
                let round3 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    errors: round3.ms.filter((m) => m.type === 'error').length,
                    cmp: getCmp(round3.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    errors: 0,
                    cmp: { numRemove: 0, numAdd: 0, numModify: 1, numSame: 2 },
                    storage: { 'a1.txt': digestStr(a1v2), 'a2.bin': digestStr(a2v3), 'a3.txt': digestStr(contents['a3.txt']) },
                    result: { 'a1.txt': digestStr(a1v2), 'a2.bin': digestStr(a2v3), 'a3.txt': digestStr(contents['a3.txt']) },
                })

            }
            finally {
                await env.clean()
            }
        })

    })

    //mkProc, 模擬使用端自訂之主階段處理函數funAdd、funModify、funRemove(比照預設實作將檔案複製至fdResult/{id}/{id}), 可令指定id處理失敗
    let mkProc = (env) => {
        let ctl = { failAdd: [], failRemove: [] }
        let put = async(v) => {
            if (_.includes(ctl.failAdd, v.id)) {
                throw new Error(`fail to process ${v.id}`)
            }
            let fd = `${env.fds.fdResult}/${v.id}`
            w.fsCleanFolder(fd)
            fs.copyFileSync(`${env.fds.fdDwStorageTemp}/${v.id}`, `${fd}/${v.id}`)
        }
        let funRemove = async(v) => {
            if (_.includes(ctl.failRemove, v.id)) {
                throw new Error(`fail to remove ${v.id}`)
            }
            w.fsDeleteFolder(`${env.fds.fdResult}/${v.id}`)
        }
        return { ctl, opt: { funAdd: put, funModify: put, funRemove } }
    }

    //規格6: 主階段某檔處理失敗(其後之檔被略過)或主階段被取消時, 未處理成功之新增/變更檔不得搬入fdDwStorage、刪除失敗之檔不得自fdDwStorage移除, 使下輪仍比對出差異而再處理, 已處理成功者照常搬入
    _.each([
        ['SFTP', false],
        ['FTP', false],
        ['SFTP', true],
    ], ([transportation, useExpandOnOldFiles]) => {

        let key = `${transportation.toLowerCase()}_${useExpandOnOldFiles ? 'exp' : 'full'}`
        let mode = useExpandOnOldFiles ? '增量模式' : '全量模式'

        it(`WDwdataFtp(${transportation}, ${mode}): 新增檔處理失敗而其後被略過時, 未處理成功之檔不搬入fdDwStorage, 下輪全部補處理`, async () => {
            let env = await setup(`pa_${key}`, transportation)
            try {
                let proc = mkProc(env)
                let optExtra = { useExpandOnOldFiles, ...proc.opt }

                //第1輪: a2.bin處理失敗, 其後之檔被略過
                proc.ctl.failAdd = ['a2.bin']
                let round1 = await runRound(env, optExtra)
                let storage1 = digestFolder(env.fds.fdDwStorage)
                let result1 = digestResult(env.fds.fdResult)
                assert.strict.deepEqual({
                    errors: round1.ms.filter((m) => m.type === 'error').map((m) => m.event),
                    cmp: getCmp(round1.ms),
                    consistent: _.isEqual(storage1, result1), //spec 6: 搬入fdDwStorage者即為已處理成功(有結果)者
                    notAll: _.size(storage1) < 3, //spec 6: 失敗檔(及被略過者)不得搬入
                    hasFail: _.has(storage1, 'a2.bin'),
                }, {
                    errors: ['proc-add-callfun-add'],
                    cmp: { numRemove: 0, numAdd: 3, numModify: 0, numSame: 0 },
                    consistent: true,
                    notAll: true,
                    hasFail: false,
                })

                //第2輪: 故障排除, 下輪須把第1輪未處理成功者(失敗與被略過者)全部補處理, 已處理成功者視為未變
                proc.ctl.failAdd = []
                let round2 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    errors: round2.ms.filter((m) => m.type === 'error').length,
                    cmp: getCmp(round2.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    errors: 0,
                    cmp: { numRemove: 0, numAdd: 3 - _.size(storage1), numModify: 0, numSame: _.size(storage1) },
                    storage: digestsOf(contents),
                    result: digestsOf(contents),
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`WDwdataFtp(${transportation}, ${mode}): 變更檔處理失敗而其後被略過時, 未處理成功之檔維持前次版本於fdDwStorage, 下輪補處理`, async () => {
            let env = await setup(`pm_${key}`, transportation)
            try {
                let proc = mkProc(env)
                let optExtra = { useExpandOnOldFiles, ...proc.opt }
                let a1v2 = mkContent('a1.txt', 4, '-v2')
                let a2v2 = mkContent('a2.bin', 12001, '-v2')

                //第1輪: 正常
                await runRound(env, optExtra)

                //第2輪: a1.txt與a2.bin皆變更, 先處理者失敗, 其後被略過
                fs.writeFileSync(`${env.fds.fdSrv}/a1.txt`, a1v2, 'utf8')
                fs.writeFileSync(`${env.fds.fdSrv}/a2.bin`, a2v2, 'utf8')
                proc.ctl.failAdd = ['a1.txt', 'a2.bin']
                let round2 = await runRound(env, optExtra)
                let storage2 = digestFolder(env.fds.fdDwStorage)
                let result2 = digestResult(env.fds.fdResult)
                let numOld = _.filter(['a1.txt', 'a2.bin'], (id) => storage2[id] === digestStr(contents[id])).length
                assert.strict.deepEqual({
                    errors: round2.ms.filter((m) => m.type === 'error').map((m) => m.event),
                    consistent: _.isEqual(storage2, result2), //spec 6: fdDwStorage與fdResult一致(皆為前次版本)
                    numOld, //spec 6: 2個變更檔皆處理失敗或被略過, 故皆維持前次版本
                }, {
                    errors: ['proc-diff-callfun-modify'],
                    consistent: true,
                    numOld: 2,
                })

                //第3輪: 故障排除, 2個變更檔皆補處理
                proc.ctl.failAdd = []
                let round3 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    cmp: getCmp(round3.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    cmp: { numRemove: 0, numAdd: 0, numModify: 2, numSame: 1 },
                    storage: { 'a1.txt': digestStr(a1v2), 'a2.bin': digestStr(a2v2), 'a3.txt': digestStr(contents['a3.txt']) },
                    result: { 'a1.txt': digestStr(a1v2), 'a2.bin': digestStr(a2v2), 'a3.txt': digestStr(contents['a3.txt']) },
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`WDwdataFtp(${transportation}, ${mode}): 主階段於處理前被取消(取得既有數據失敗)時, 新下載之檔不搬入fdDwStorage, 下輪補處理`, async () => {
            let env = await setup(`pc_${key}`, transportation)
            try {
                let proc = mkProc(env)
                let optExtra = { useExpandOnOldFiles, ...proc.opt }
                let a1v2 = mkContent('a1.txt', 4, '-v2')

                //第1輪: 正常
                await runRound(env, optExtra)

                //第2輪: a1.txt變更, 但取得既有數據(funGetCurrent)失敗, 主階段於比對前即被取消
                fs.writeFileSync(`${env.fds.fdSrv}/a1.txt`, a1v2, 'utf8')
                let funGetCurrentErr = async() => {
                    throw new Error('fail to get current')
                }
                let round2 = await runRound(env, { ...optExtra, funGetCurrent: funGetCurrentErr })
                assert.strict.deepEqual({
                    errors: round2.ms.filter((m) => m.type === 'error').map((m) => m.event),
                    storage: digestFolder(env.fds.fdDwStorage), //spec 6: 未處理即不得搬入
                    result: digestResult(env.fds.fdResult),
                }, {
                    errors: ['proc-callfun-getCurrent'],
                    storage: digestsOf(contents),
                    result: digestsOf(contents),
                })

                //第3輪: 恢復, a1.txt補處理
                let round3 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    cmp: getCmp(round3.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    cmp: { numRemove: 0, numAdd: 0, numModify: 1, numSame: 2 },
                    storage: { ...digestsOf(contents), 'a1.txt': digestStr(a1v2) },
                    result: { ...digestsOf(contents), 'a1.txt': digestStr(a1v2) },
                })
            }
            finally {
                await env.clean()
            }
        })

    })

    //規格6: 下載已完成但其後(計算與儲存hash)失敗時, 該輪之新下載檔不得搬入fdDwStorage
    _.each([false, true], (useExpandOnOldFiles) => {

        let mode = useExpandOnOldFiles ? '增量模式' : '全量模式'
        let key = useExpandOnOldFiles ? 'exp' : 'full'

        it(`WDwdataFtp(SFTP, ${mode}): 下載完成後計算與儲存hash階段失敗(下載階段整體失敗)時, 新下載之檔不搬入fdDwStorage, 下輪補處理`, async () => {
            let env = await setup(`ph_${key}`, 'SFTP')
            try {
                let optExtra = { useExpandOnOldFiles }
                let a1v2 = mkContent('a1.txt', 4, '-v2')

                //第1輪: 正常
                await runRound(env, optExtra)

                //第2輪: a1.txt變更並新增a4.txt; 於下載完成之事件(getVfps done)當下刪除暫存夾內最後一個檔案a4.txt, 其後計算hash時失敗(下載階段整體失敗, 主階段不進行)
                fs.writeFileSync(`${env.fds.fdSrv}/a1.txt`, a1v2, 'utf8')
                fs.writeFileSync(`${env.fds.fdSrv}/a4.txt`, 'a4-new', 'utf8')
                let round2 = await runRound(env, optExtra, (v) => {
                    if (v.event === 'getVfps' && v.msg === 'done') {
                        fs.unlinkSync(`${env.fds.fdDwStorageTemp}/a4.txt`)
                    }
                })
                assert.strict.deepEqual({
                    downloadError: _.some(round2.ms, { type: 'error', event: 'proc-callfun-download' }),
                    mutating: round2.ms.filter(isMutating).map((m) => `${m.event}:${m.id}`),
                    storage: digestFolder(env.fds.fdDwStorage), //spec 6: 未處理即不得搬入(a1.txt仍為前次版本、a4.txt不存在)
                    result: digestResult(env.fds.fdResult),
                }, {
                    downloadError: true,
                    mutating: [],
                    storage: digestsOf(contents),
                    result: digestsOf(contents),
                })

                //第3輪: 恢復, a1.txt與a4.txt補處理
                let round3 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    cmp: getCmp(round3.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    cmp: { numRemove: 0, numAdd: 1, numModify: 1, numSame: 2 },
                    storage: { ...digestsOf(contents), 'a1.txt': digestStr(a1v2), 'a4.txt': digestStr('a4-new') },
                    result: { ...digestsOf(contents), 'a1.txt': digestStr(a1v2), 'a4.txt': digestStr('a4-new') },
                })
            }
            finally {
                await env.clean()
            }
        })

    })

    _.each(['SFTP', 'FTP'], (transportation) => {

        it(`WDwdataFtp(${transportation}, 全量模式): 刪除檔處理失敗時, 該檔不自fdDwStorage與fdResult移除, 下輪補處理刪除`, async () => {
            let env = await setup(`pr_${transportation.toLowerCase()}`, transportation)
            try {
                let proc = mkProc(env)
                let optExtra = { ...proc.opt }

                //第1輪: 正常
                await runRound(env, optExtra)

                //第2輪: 伺服器刪除a3.txt, 刪除處理失敗
                fs.unlinkSync(`${env.fds.fdSrv}/a3.txt`)
                proc.ctl.failRemove = ['a3.txt']
                let round2 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    errors: round2.ms.filter((m) => m.type === 'error').map((m) => m.event),
                    storage: digestFolder(env.fds.fdDwStorage), //spec 6: 刪除失敗之檔須保留, 使下輪再處理
                    result: digestResult(env.fds.fdResult),
                }, {
                    errors: ['proc-remove-callfun-remove'],
                    storage: digestsOf(contents),
                    result: digestsOf(contents),
                })

                //第3輪: 故障排除, 補處理刪除
                proc.ctl.failRemove = []
                let round3 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    cmp: getCmp(round3.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    cmp: { numRemove: 1, numAdd: 0, numModify: 0, numSame: 2 },
                    storage: digestsOf(contents, ['a1.txt', 'a2.bin']),
                    result: digestsOf(contents, ['a1.txt', 'a2.bin']),
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`WDwdataFtp(${transportation}, 全量模式): 伺服器刪除之檔遇主階段於比對前被取消時, 該檔不自fdDwStorage移除(刪除尚未處理), 下輪補處理刪除`, async () => {
            let env = await setup(`pq_${transportation.toLowerCase()}`, transportation)
            try {
                let proc = mkProc(env)
                let optExtra = { ...proc.opt }

                //第1輪: 正常
                await runRound(env, optExtra)

                //第2輪: 伺服器刪除a3.txt, 但取得既有數據(funGetCurrent)失敗, 主階段於比對前即被取消(刪除未處理)
                fs.unlinkSync(`${env.fds.fdSrv}/a3.txt`)
                let funGetCurrentErr = async() => {
                    throw new Error('fail to get current')
                }
                let round2 = await runRound(env, { ...optExtra, funGetCurrent: funGetCurrentErr })
                assert.strict.deepEqual({
                    errors: round2.ms.filter((m) => m.type === 'error').map((m) => m.event),
                    storage: digestFolder(env.fds.fdDwStorage), //spec 6: 刪除未處理, a3.txt須保留於fdDwStorage
                    result: digestResult(env.fds.fdResult),
                }, {
                    errors: ['proc-callfun-getCurrent'],
                    storage: digestsOf(contents),
                    result: digestsOf(contents),
                })

                //第3輪: 恢復, 補處理刪除
                let round3 = await runRound(env, optExtra)
                assert.strict.deepEqual({
                    cmp: getCmp(round3.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                }, {
                    cmp: { numRemove: 1, numAdd: 0, numModify: 0, numSame: 2 },
                    storage: digestsOf(contents, ['a1.txt', 'a2.bin']),
                    result: digestsOf(contents, ['a1.txt', 'a2.bin']),
                })
            }
            finally {
                await env.clean()
            }
        })

    })

    it('WDwdataFtp(SFTP, 全量模式): 檔名含點且另一檔名為其前綴(log與log.1)時, 刪除失敗之log.1仍保留於fdDwStorage, id不被當成路徑解析', async () => {
        let ns = ['a1.txt', 'log', 'log.1']
        let env = await setup('pl_sftp', 'SFTP', { files: ns })
        try {
            let proc = mkProc(env)
            let optExtra = { ...proc.opt }
            await runRound(env, optExtra)

            //伺服器刪除log.1, 刪除處理失敗
            fs.unlinkSync(`${env.fds.fdSrv}/log.1`)
            proc.ctl.failRemove = ['log.1']
            let round2 = await runRound(env, optExtra)
            assert.strict.deepEqual({
                errors: round2.ms.filter((m) => m.type === 'error').map((m) => m.event),
                storage: digestFolder(env.fds.fdDwStorage),
                result: digestResult(env.fds.fdResult),
            }, {
                errors: ['proc-remove-callfun-remove'],
                storage: digestsOf(contents, ns),
                result: digestsOf(contents, ns),
            })

            //補處理刪除
            proc.ctl.failRemove = []
            let round3 = await runRound(env, optExtra)
            assert.strict.deepEqual({
                cmp: getCmp(round3.ms),
                storage: digestFolder(env.fds.fdDwStorage),
            }, {
                cmp: { numRemove: 1, numAdd: 0, numModify: 0, numSame: 2 },
                storage: digestsOf(contents, ['a1.txt', 'log']),
            })
        }
        finally {
            await env.clean()
        }
    })

    it('WDwdataFtp(SFTP, 全量模式): 有給刪除防抖(timeToleranceRemove)時, 刪除檔仍照常處理並自fdDwStorage移除', async () => {
        let env = await setup('pt_sftp', 'SFTP')
        try {
            let proc = mkProc(env)
            let optExtra = { ...proc.opt, timeToleranceRemove: 60 * 1000 }
            await runRound(env, optExtra)

            //伺服器刪除a3.txt
            fs.unlinkSync(`${env.fds.fdSrv}/a3.txt`)
            let round2 = await runRound(env, optExtra)
            assert.strict.deepEqual({
                errors: round2.ms.filter((m) => m.type === 'error').length,
                cmp: getCmp(round2.ms),
                storage: digestFolder(env.fds.fdDwStorage),
                result: digestResult(env.fds.fdResult),
            }, {
                errors: 0,
                cmp: { numRemove: 1, numAdd: 0, numModify: 0, numSame: 2 },
                storage: digestsOf(contents, ['a1.txt', 'a2.bin']),
                result: digestsOf(contents, ['a1.txt', 'a2.bin']),
            })
        }
        finally {
            await env.clean()
        }
    })

    it('WDwdataFtp(SFTP): retry、onTrace等下載設定原樣傳給downloadFiles(retry為0時a2.bin僅嘗試1次、無重試; onTrace收到事件)', async () => {
        let env = await setup('wp_sftp', 'SFTP', { optSrv: kpProt.SFTP.faultAlways })
        try {
            let ts = []
            let round1 = await runRound(env, { retry: 0, onTrace: (e) => ts.push(e) })
            assert.strict.deepEqual({
                attempts: round1.msError.filter((v) => v.event === 'ftp.download' && v.attempt !== undefined).map((v) => v.attempt),
                retries: round1.msInfo.filter((v) => v.event === 'ftp.download' && v.msg === 'retry...').length,
                cmp: getCmp(round1.ms),
                traceTypes: _.uniq(ts.map((e) => e.type)).sort(),
            }, {
                attempts: [1],
                retries: 0,
                cmp: { numRemove: 0, numAdd: 2, numModify: 0, numSame: 0 },
                traceTypes: ['attempt', 'done', 'fail', 'giveup', 'ls', 'reconnect'],
            })
        }
        finally {
            await env.clean()
        }
    })

    it('WDwdataFtp(SFTP): timeFile原樣傳給downloadFiles(下載停滯逾時即視為失敗, 其餘檔案照常新增)', async function() {
        this.timeout(60000)
        let env = await setup('wf_sftp', 'SFTP', { optSrv: { stallOn: nameFail } })
        try {
            let round1 = await runRound(env, { retry: 0, timeFile: 3000 })
            assert.strict.deepEqual({
                errors: round1.ms.filter((m) => m.type === 'error').length,
                cmp: getCmp(round1.ms),
                storage: digestFolder(env.fds.fdDwStorage),
                giveup: round1.msError.filter((v) => v.event === 'ftp.download' && /give up: .*timeout/.test(v.msg)).length,
            }, {
                errors: 0,
                cmp: { numRemove: 0, numAdd: 2, numModify: 0, numSame: 0 },
                storage: digestsOf(contents, ['a1.txt', 'a3.txt']),
                giveup: 1,
            })
        }
        finally {
            await env.clean()
        }
    })

    it('WDwdataFtp: opt.debug為true時, 自身與轉交給downloadFiles之opt非預期之輸入皆警告(固定詞彙、不含輸入值), 且仍改用預設而照常運作', async () => {
        let env = await setup('wdbg_sftp', 'SFTP')
        try {
            let bad = 'bad-value-xyz'
            optReader.resetWarned()
            let logs = []
            let infos = []
            let round1 = await runRound(env, {
                useExpandOnOldFiles: bad,
                funRemove: bad,
                funAdd: bad,
                timeToleranceRemove: -1,
                useShowLog: bad,
                retry: bad,
                debug: true,
                funLog: (msg, info) => {
                    logs.push(msg)
                    infos.push(info)
                },
            })
            assert.strict.deepEqual({
                errors: round1.ms.filter((m) => m.type === 'error').length,
                cmp: getCmp(round1.ms),
            }, {
                errors: 0,
                cmp: { numRemove: 0, numAdd: 3, numModify: 0, numSame: 0 },
            })
            assert.strict.deepEqual(infos.map((v) => `${v.fn}.${v.key}`).sort(), [
                'WDwdataFtp.funAdd',
                'WDwdataFtp.funRemove',
                'WDwdataFtp.timeToleranceRemove',
                'WDwdataFtp.useExpandOnOldFiles',
                'WDwdataFtp.useShowLog',
                'downloadFiles.retry',
            ])
            assert.ok(logs.every((s) => s.indexOf(bad) < 0 && s.startsWith('[w-dwdata-ftp ')), '警告須為固定詞彙且不含輸入值')
            assert.ok(logs.some((s) => s === '[w-dwdata-ftp WDwdataFtp] invalid opt.useExpandOnOldFiles: must be a boolean, using default false'))
        }
        finally {
            optReader.resetWarned()
            await env.clean()
        }
    })

    _.each(['SFTP', 'FTP'], (transportation) => {

        let prot = kpProt[transportation]
        let key = transportation.toLowerCase()

        it(`WDwdataFtp(${transportation}, 全量模式): 從未下載成功過之a2.bin一直失敗時僅不納入, 其餘檔案正常新增`, async () => {
            let env = await setup(`wn_${key}`, transportation, { optSrv: prot.faultAlways })
            try {
                let round1 = await runRound(env)
                assert.strict.deepEqual({
                    errors: round1.ms.filter((m) => m.type === 'error').length,
                    cmp: getCmp(round1.ms),
                    storage: digestFolder(env.fds.fdDwStorage),
                    result: digestResult(env.fds.fdResult),
                    keep: round1.msInfo.filter((v) => v.event === 'keep-previous-file').length,
                }, {
                    errors: 0,
                    cmp: { numRemove: 0, numAdd: 2, numModify: 0, numSame: 0 },
                    storage: digestsOf(contents, ['a1.txt', 'a3.txt']),
                    result: digestsOf(contents, ['a1.txt', 'a3.txt']),
                    keep: 0, //無上一輪之檔案可沿用
                })
            }
            finally {
                await env.clean()
            }
        })

        it(`WDwdataFtp(${transportation}): 全部檔案皆失敗或ls失敗時取消該輪, fdDwStorage與fdResult維持第1輪結果`, async () => {
            let env = await setup(`wa_${key}`, transportation, { files: [nameFail] })
            try {

                //第1輪: 正常
                await runRound(env)
                let expect = { storage: digestsOf(contents, [nameFail]), result: digestsOf(contents, [nameFail]) }

                //第2輪: 唯一之檔案下載失敗(全部失敗)
                env.srv.setFault(prot.faultAlways)
                let round2 = await runRound(env)
                checkCancel(round2.ms)
                assert.strict.deepEqual({ storage: digestFolder(env.fds.fdDwStorage), result: digestResult(env.fds.fdResult) }, expect)

                //第3輪: ls失敗
                env.srv.setFault(prot.faultNone)
                env.srv.setFault(prot.faultLs)
                let round3 = await runRound(env)
                checkCancel(round3.ms)
                assert.strict.deepEqual({ storage: digestFolder(env.fds.fdDwStorage), result: digestResult(env.fds.fdResult) }, expect)

            }
            finally {
                await env.clean()
            }
        })

    })

    //規格8: 列舉僅限第1層(wsemi列舉函數opt.levelLimit為1, 未給則窮舉全部層級), 以下3案各對應src之一處列舉, 於列舉前一刻(事件同步, 不以延時)或比對前於資料夾內建立子資料夾與檔案(ghost.txt), 其不得被列入

    //injectStray, 於fd內建立子資料夾與其內檔案(第2層之檔案)
    let injectStray = (fd) => {
        w.fsCreateFolder(`${fd}/stray`)
        fs.writeFileSync(`${fd}/stray/ghost.txt`, 'ghost', 'utf8')
    }

    it('downloadFiles(SFTP): 結束時只收fdDwStorageTemp第1層之檔案, 其子資料夾內之檔案不列入files(downloadFiles列舉僅限第1層)', async () => {
        let env = await setup('lv_dl', 'SFTP')
        try {

            //於getVfps開始時(列舉前一刻)同步建立子資料夾與檔案
            let nInject = 0
            let srLog = {
                info: (v) => {
                    if (v.event === 'getVfps' && v.msg === 'start...') {
                        nInject++
                        injectStray(env.fds.fdDwStorageTemp)
                    }
                },
                error: () => {},
            }
            let r = await dw(env, { srLog })
            assert.strict.deepEqual({
                nInject,
                settled: r.settled,
                names: r.names, //spec 8: 僅第1層之檔案
                failed: r.failed,
                folder: r.folder, //全層級列舉, 證明注入之子資料夾與檔案確實存在於fdDwStorageTemp
            }, {
                nInject: 1,
                settled: 'resolved',
                names: ['a1.txt', 'a2.bin', 'a3.txt'],
                failed: [],
                folder: ['a1.txt', 'a2.bin', 'a3.txt', 'ghost.txt', 'stray'],
            })
        }
        finally {
            await env.clean()
        }
    })

    it('WDwdataFtp(SFTP, 全量模式): 失敗檔沿用前次檔案後, 僅以fdDwStorageTemp第1層之檔案計算hash, 其子資料夾內之檔案不被視為新增', async () => {
        let env = await setup('lv_keep', 'SFTP')
        try {
            let optExtra = { useExpandOnOldFiles: false }

            //第1輪: 正常, 3個檔案皆新增
            let round1 = await runRound(env, optExtra)
            assert.strict.deepEqual(getCmp(round1.ms), { numRemove: 0, numAdd: 3, numModify: 0, numSame: 0 })

            //第2輪: a2.bin一直失敗而沿用前次檔案, 於沿用完成當下(keep-previous-file, 早於取fdDwStorageTemp第1層之檔案)同步建立子資料夾與檔案
            env.srv.setFault(kpProt.SFTP.faultAlways)
            let nInject = 0
            let round2 = await runRound(env, optExtra, (v) => {
                if (v.event === 'keep-previous-file') {
                    nInject++
                    injectStray(env.fds.fdDwStorageTemp)
                }
            })
            assert.strict.deepEqual({
                nInject,
                errors: round2.ms.filter((m) => m.type === 'error').length,
                cmp: getCmp(round2.ms), //spec 8: 無新增(ghost.txt不得被列入)
                mutating: round2.ms.filter(isMutating).map((m) => `${m.event}:${m.id}:${m.msg}`).sort(),
                storage: digestFolder(env.fds.fdDwStorage),
            }, {
                nInject: 1,
                errors: 0,
                cmp: { numRemove: 0, numAdd: 0, numModify: 0, numSame: 3 },
                mutating: [],
                storage: digestsOf(contents),
            })
        }
        finally {
            await env.clean()
        }
    })

    _.each([false, true], (useExpandOnOldFiles) => {

        let mode = useExpandOnOldFiles ? '增量模式' : '全量模式'

        it(`WDwdataFtp(SFTP, ${mode}): 比對基準(fdDwStorage之hash清單)只含第1層之項目, fdDwStorage內子資料夾之檔案不被視為既有數據(與僅有空子資料夾之對照組比對結果相同)`, async () => {
            let optExtra = { useExpandOnOldFiles }
            let key = useExpandOnOldFiles ? 'exp' : 'full'

            //round2Of, 第1輪正常(3個檔案皆新增), 第2輪伺服器無變動但fdDwStorage內多了子資料夾stray(withGhost為true時其內另有檔案ghost.txt, 即第2層之檔案), 回傳第2輪之結果
            //對照組(withGhost為false, 僅空之子資料夾)與實驗組之比對結果須相同: 差別只在第2層之檔案, 不依賴第1層之子資料夾項目本身如何處理
            let round2Of = async(tag, withGhost) => {
                let env = await setup(`lv_hash_${key}_${tag}`, 'SFTP')
                try {
                    let round1 = await runRound(env, optExtra)
                    assert.strict.deepEqual(getCmp(round1.ms), { numRemove: 0, numAdd: 3, numModify: 0, numSame: 0 })
                    if (withGhost) {
                        injectStray(env.fds.fdDwStorage)
                    }
                    else {
                        w.fsCreateFolder(`${env.fds.fdDwStorage}/stray`)
                    }
                    assert.strict.deepEqual(fs.existsSync(`${env.fds.fdDwStorage}/stray/ghost.txt`), withGhost)
                    let round2 = await runRound(env, optExtra)
                    return {
                        errors: round2.ms.filter((m) => m.type === 'error').length,
                        cmp: getCmp(round2.ms),
                        mutating: round2.ms.filter(isMutating).map((m) => `${m.event}:${m.id}:${m.msg}`).sort(),
                        storage: digestFolder(env.fds.fdDwStorage),
                    }
                }
                finally {
                    await env.clean()
                }
            }
            let rCtl = await round2Of('ctl', false)
            let rGhost = await round2Of('ghost', true)

            //spec 8: ghost.txt(第2層)不得被列入比對基準(全量模式不得被當成已刪除而有移除事件, 增量模式不得被當成既有檔案而使same數增加)
            assert.strict.deepEqual(rGhost, rCtl)
            assert.strict.deepEqual({
                errors: rGhost.errors,
                noGhost: rGhost.mutating.filter((s) => /ghost\.txt/.test(s)),
                storage: rGhost.storage,
            }, {
                errors: 0,
                noGhost: [],
                storage: digestsOf(contents),
            })
        })

    })

})
