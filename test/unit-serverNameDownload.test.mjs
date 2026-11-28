import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { mock } from 'node:test'
import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import downloadFiles from '../src/downloadFiles.mjs'
import WDwdataFtp from '../src/WDwdataFtp.mjs'
import fakeSftpServer from './lib/fakeSftpServer.mjs'
import fakeFtpServer from './lib/fakeFtpServer.mjs'


//規格(downloadFiles與WDwdataFtp之JSDoc, 規則R-SN-01～R-SN-05):
//1. 伺服器回報之名稱用於本機路徑前逐一檢查, 不合者不下載、不寫入(亦不刪除)任何檔, 其餘照常下載
//2. 不合者列入failed({ name: '', rpath: '', attempts: 0, msg: 固定訊息 }, 排於下載失敗者之後), 名稱不回顯於failed、srLog、onTrace與錯誤訊息
//3. 有名稱被拒之檔時onTrace於ls之後通知reject({ num }), ls之num不含名稱被拒者; srLog.error紀錄數量與固定訊息
//4. 名稱皆被拒或其餘皆下載失敗時為整輪失敗(reject), 不交出空清單
//5. WDwdataFtp全量模式: 名稱被拒者僅沿用fdDwStorage第1層內指向同一本機檔之前次檔案(Windows檔名不分大小寫)
//各案沙盒建於test/_tmp/serverName/<案名>/, 敵意名稱之目標皆在沙盒內, 以沙盒全樹比對驗「目標資料夾外無任何寫入與刪除」
describe('serverNameDownload', function() {

    let isWin = process.platform === 'win32'
    let msgName = 'invalid name from the server: must be a file name that can be saved inside fdDwStorageTemp'
    let msgCase = 'invalid names from the server: must not differ only in letter case'
    let fdRootCase = './test/_tmp/serverName'

    let md5 = (buf) => {
        return crypto.createHash('md5').update(buf).digest('hex')
    }

    //kpProt
    let kpProt = {
        SFTP: { fakeServer: fakeSftpServer },
        FTP: { fakeServer: fakeFtpServer },
    }

    //envs, 各案之環境, 於afterEach清理(含Windows保留名之字面檔案, 不得殘留)
    let envs = []
    afterEach(async() => {
        for (let env of envs.splice(0)) {
            await env.clean()
        }
    })
    after(() => {
        w.fsDeleteFolder(fdRootCase)
    })

    //snapshot, 沙盒內(不含伺服器根目錄srv)全部項目: 相對路徑 -> 檔案雜湊或'dir'
    let snapshot = (fdSbx) => {
        let kp = {}
        let walk = (rel) => {
            for (let e of fs.readdirSync(path.join(fdSbx, rel), { withFileTypes: true })) {
                let r = rel === '' ? e.name : `${rel}/${e.name}`
                if (r === 'srv') {
                    continue
                }
                if (e.isDirectory()) {
                    kp[r] = 'dir'
                    walk(r)
                }
                else {
                    kp[r] = md5(fs.readFileSync(path.join(fdSbx, r)))
                }
            }
        }
        walk('')
        return kp
    }

    //setup, 建立沙盒<tag>/{ srv, l1/l2/{ out, wftp, ... } }, sentinels為沙盒內既有之檔(相對路徑 -> 內容)
    let setup = async(tag, transportation, o = {}) => {
        let fdSbx = `${fdRootCase}/${tag}_${transportation.toLowerCase()}`
        let fdL2 = `${fdSbx}/l1/l2`
        let fds = {
            fdDwStorageTemp: `${fdL2}/out`,
            fdWtemp: `${fdL2}/wftp`,
        }
        let env = { fdSbx, fdL2, fds, srv: null, st: null }
        env.clean = async() => {
            if (env.srv !== null) {
                await env.srv.close()
                env.srv = null
            }
            w.fsDeleteFolder(fdSbx)
        }
        envs.push(env)
        w.fsDeleteFolder(fdSbx)
        w.fsCreateFolder(`${fdSbx}/srv`)
        w.fsCreateFolder(fds.fdDwStorageTemp)
        w.fsCreateFolder(fds.fdWtemp)
        _.each(_.get(o, 'files', { 'a1.txt': 'real-a1', 'a3.txt': 'real-a3-content' }), (c, name) => {
            fs.writeFileSync(`${fdSbx}/srv/${name}`, c, 'utf8')
        })
        _.each(_.get(o, 'sentinels', {}), (c, rel) => {
            w.fsCreateFolder(path.dirname(`${fdSbx}/${rel}`))
            fs.writeFileSync(`${fdSbx}/${rel}`, c, 'utf8')
        })
        env.srv = await kpProt[transportation].fakeServer({ fdRoot: `${fdSbx}/srv`, virtual: [] })
        env.st = { transportation, hostname: '127.0.0.1', port: env.srv.port, username: 'u1', password: 'p1', fdIni: '.', fdDownloadTemp: fds.fdWtemp }
        return env
    }

    //virtualOf, 虛擬檔案, 內容依名稱相異
    let virtualOf = (name, o = {}) => {
        return { name, content: `virtual|${Buffer.from(name, 'utf8').toString('base64')}`, ...o }
    }

    //dw, 執行downloadFiles並蒐集srLog與onTrace
    let dw = async(env, optDw = {}) => {
        let logs = []
        let trace = []
        let r = { logs, trace }
        await downloadFiles(env.st, env.fds.fdDwStorageTemp, {
            retry: 0,
            retryInterval: 10,
            srLog: {
                info: (v) => logs.push({ type: 'info', ...v }),
                error: (v) => logs.push({ type: 'error', ...v }),
            },
            onTrace: (e) => trace.push(e),
            ...optDw,
        })
            .then((res) => {
                r.settled = 'resolved'
                r.res = res
            })
            .catch((err) => {
                r.settled = 'rejected'
                r.msg = w.getErrorMessage(err)
                r.errFailed = _.get(err, 'failed')
            })
        return r
    }

    //stringsOf, 取出值內所有字串
    let stringsOf = (v, out = []) => {
        if (typeof v === 'string') {
            out.push(v)
        }
        else if (v !== null && typeof v === 'object') {
            Object.values(v).forEach((u) => stringsOf(u, out))
        }
        return out
    }

    //checkNoEcho, 被拒名稱(長度4以上者, 較短者如'...'與事件訊息重疊)與標記'ESC'不得出現於任何輸出
    let checkNoEcho = (outputs, rejected) => {
        let ss = stringsOf(outputs)
        let hits = []
        for (let name of rejected) {
            if (name.length >= 4 && ss.some((s) => s.includes(name))) {
                hits.push(name)
            }
        }
        assert.ok(hits.length === 0, `被拒名稱不得回顯: ${hits.join(' | ')}`)
    }

    //hostileCases, 依傳輸協定列出伺服器回報之名稱, everywhere於各平台皆拒, winOnly僅Windows拒(其他平台為合法檔名), accepted各平台皆收
    let hostileCases = (env, transportation) => {
        let abs = path.resolve(env.fdSbx, 'ESCabs.txt') //沙盒內之絕對路徑(Windows含磁碟代號與反斜線)
        let absSlash = path.resolve(env.fdSbx, 'ESCfs.txt').split(path.sep).join('/')
        let everywhere = ['../ESC1.txt', 'a/../../ESC3.txt', '../../ESC5.txt', '/ESCroot.txt', 'sub/ESCsub.txt', absSlash, abs, '..\\ESC2.txt', 'x\\..\\..\\ESC4.txt']
        let winOnly = ['C:ESCrel.txt', 'q:ESCq.txt', 'ESCads.txt:s1', 'ESCdot.txt.', 'ESCdots...', '...', 'CON', 'nul.txt', 'aux.c', 'COM1', 'LPT9.log', 'CONIN$']
        if (transportation === 'SFTP') {
            //FTP之列表解析修剪首尾空白、非ASCII之名稱經FTP傳遞會變形, 故僅SFTP測尾端空白、空字串與上標數字
            everywhere = [...everywhere, '']
            winOnly = [...winOnly, 'ESCsp.txt ', 'com².dat']
        }
        let accepted = ['ESCCONSOLE.txt', 'ESC.nulx', '.ESChidden', 'ESC..mid']
        return { everywhere, winOnly, accepted }
    }

    let sentinels = {
        'l1/l2/ESC1.txt': 'sentinel-1',
        'l1/l2/ESC2.txt': 'sentinel-2',
        'l1/l2/ESC3.txt': 'sentinel-3',
        'l1/l2/ESC4.txt': 'sentinel-4',
        'l1/ESC5.txt': 'sentinel-5',
        'ESCabs.txt': 'sentinel-abs',
        'ESCfs.txt': 'sentinel-fs',
    }

    _.each(['SFTP', 'FTP'], (transportation) => {

        it(`downloadFiles(${transportation}): 伺服器回報之不合名稱不下載、目標資料夾外無任何寫入, 列入failed而不回顯名稱, 其餘照常下載`, async function() {
            let env = await setup('mix', transportation, { sentinels })
            let { everywhere, winOnly, accepted } = hostileCases(env, transportation)
            let names = [...everywhere, ...winOnly, 'ESCcase.txt', ...accepted, 'ESCCASE.TXT']
            env.srv.setFault({ virtual: names.map((n) => virtualOf(n)) })
            let rejected = isWin ? [...everywhere, ...winOnly] : everywhere
            let clash = isWin ? ['ESCcase.txt', 'ESCCASE.TXT'] : []
            let kept = names.filter((n) => !rejected.includes(n) && !clash.includes(n))
            let before = snapshot(env.fdSbx)

            let r = await dw(env)

            assert.ok(r.settled === 'resolved', `須resolve, 但為${r.settled}: ${r.msg}`)
            //spec 1: 只下載合格者, 沙盒內除fdDwStorageTemp內之合格檔外一切不變(含哨兵檔)
            let exp = { ...before }
            exp['l1/l2/out/a1.txt'] = md5(Buffer.from('real-a1'))
            exp['l1/l2/out/a3.txt'] = md5(Buffer.from('real-a3-content'))
            kept.forEach((n) => {
                exp[`l1/l2/out/${n}`] = md5(Buffer.from(virtualOf(n).content))
            })
            assert.deepStrictEqual(snapshot(env.fdSbx), exp)
            assert.deepStrictEqual(_.map(r.res.files, 'name').sort(), ['a1.txt', 'a3.txt', ...kept].sort())
            assert.deepStrictEqual(r.trace.filter((e) => e.type === 'attempt').map((e) => e.name), ['a1.txt', 'a3.txt', ...kept])
            //spec 2: failed
            assert.deepStrictEqual(r.res.failed, [
                ...rejected.map(() => ({ name: '', rpath: '', attempts: 0, msg: msgName })),
                ...clash.map(() => ({ name: '', rpath: '', attempts: 0, msg: msgCase })),
            ])
            assert.deepStrictEqual(Object.keys(r.res).sort(), ['failed', 'files'])
            //spec 3: ls與reject事件, srLog.error
            let tr = r.trace.filter((e) => e.type === 'ls' || e.type === 'reject').map((e) => ({ ...e }))
            assert.deepStrictEqual(tr, [{ type: 'ls', num: 2 + kept.length }, { type: 'reject', num: rejected.length + clash.length }])
            let errs = r.logs.filter((v) => v.type === 'error')
            assert.deepStrictEqual(errs, [
                { type: 'error', event: 'ftp.syncToLocal', length: rejected.length, msg: msgName },
                ...(isWin ? [{ type: 'error', event: 'ftp.syncToLocal', length: clash.length, msg: msgCase }] : []),
            ])
            checkNoEcho([r.res.failed, r.logs, r.trace], [...rejected, ...clash])
        })

        it(`downloadFiles(${transportation}): 不合名稱之遠端檔下載會失敗時亦不嘗試下載, 目標資料夾外之既有檔不被刪除`, async function() {
            let env = await setup('del', transportation, { sentinels })
            env.srv.setFault({ virtual: [virtualOf('../ESC1.txt', { fail: true })] })
            let before = snapshot(env.fdSbx)
            let r = await dw(env)
            assert.ok(r.settled === 'resolved', `須resolve, 但為${r.settled}: ${r.msg}`)
            let exp = { ...before, 'l1/l2/out/a1.txt': md5(Buffer.from('real-a1')), 'l1/l2/out/a3.txt': md5(Buffer.from('real-a3-content')) }
            assert.deepStrictEqual(snapshot(env.fdSbx), exp)
            assert.deepStrictEqual(r.res.failed, [{ name: '', rpath: '', attempts: 0, msg: msgName }])
        })

        it(`downloadFiles(${transportation}): 名稱皆被拒時整輪失敗(reject固定訊息, failed不回顯名稱), 不寫入任何檔`, async function() {
            let env = await setup('all', transportation, { files: {}, sentinels })
            let names = ['../ESC1.txt', 'sub/ESCsub.txt']
            env.srv.setFault({ virtual: names.map((n) => virtualOf(n)) })
            let before = snapshot(env.fdSbx)
            let r = await dw(env)
            assert.ok(r.settled === 'rejected', `須reject, 但為${r.settled}`)
            assert.ok(r.msg === `all 2 files failed to download: ${msgName}`, `reject訊息: ${r.msg}`)
            assert.deepStrictEqual(r.errFailed, [{ name: '', rpath: '', attempts: 0, msg: msgName }, { name: '', rpath: '', attempts: 0, msg: msgName }])
            assert.deepStrictEqual(snapshot(env.fdSbx), before)
            checkNoEcho([r.msg, r.errFailed, r.logs, r.trace], names)
        })

        it(`downloadFiles(${transportation}): 名稱被拒者與下載失敗者並存且無成功者時整輪失敗, failed以下載失敗者在前`, async function() {
            let env = await setup('allmix', transportation, { files: {}, sentinels })
            env.srv.setFault({ virtual: [virtualOf('../ESC1.txt'), virtualOf('ESCfail.txt', { fail: true })] })
            let r = await dw(env)
            assert.ok(r.settled === 'rejected', `須reject, 但為${r.settled}`)
            assert.deepStrictEqual(r.errFailed.map((v) => [v.name, v.attempts]), [['ESCfail.txt', 1], ['', 0]])
            assert.ok(r.msg === `all 2 files failed to download: ${r.errFailed[0].msg}` && r.errFailed[0].msg !== msgName, `reject訊息須取下載失敗之原因: ${r.msg}`)
        })

    })

    //runRound, 執行一輪WDwdataFtp至end事件, 回傳本輪各函數處理之id、紀錄與結果
    let runRound = async(env, fdsW, optExtra = {}) => {
        let ids = { add: [], modify: [], remove: [] }
        let logs = []
        let pm = w.genPm()
        let ev = await WDwdataFtp(env.st, {
            ...fdsW,
            useShowLog: false,
            retry: 0,
            retryInterval: 10,
            funAdd: async(v) => ids.add.push(v.id),
            funModify: async(v) => ids.modify.push(v.id),
            funRemove: async(v) => ids.remove.push(v.id),
            srLog: {
                info: (v) => logs.push({ type: 'info', ...v }),
                warn: (v) => logs.push({ type: 'warn', ...v }),
                error: (v) => logs.push({ type: 'error', ...v }),
            },
            ...optExtra,
        })
        ev.on('end', (res) => pm.resolve(res))
        let res = await pm
        return { ids, logs, res }
    }

    //fdsOfW, WDwdataFtp之各資料夾, 皆在沙盒l1/l2內
    let fdsOfW = (env) => {
        let d = env.fdL2
        return {
            fdDwStorageTemp: env.fds.fdDwStorageTemp,
            fdDwStorage: `${d}/storage`,
            fdTagRemove: `${d}/tagRemove`,
            fdDwAttime: `${d}/dwAttime`,
            fdDwCurrent: `${d}/dwCurrent`,
            fdResult: `${d}/result`,
            fdTaskCpActualSrc: `${d}/taskCpActualSrc`,
            fdTaskCpSrc: `${d}/taskCpSrc`,
        }
    }

    //outsideOf, 沙盒內不屬WDwdataFtp工作資料夾之項目
    let outsideOf = (snap) => {
        return _.pickBy(snap, (v, k) => !/^l1\/l2\/(out|storage|tagRemove|dwAttime|dwCurrent|result|taskCpActualSrc|taskCpSrc)(\/|$)/.test(k))
    }

    //digestFirst, 資料夾第1層檔案之名稱與內容雜湊
    let digestFirst = (fd) => {
        let kp = {}
        for (let e of fs.readdirSync(fd, { withFileTypes: true })) {
            if (!e.isDirectory()) {
                kp[e.name] = md5(fs.readFileSync(`${fd}/${e.name}`))
            }
        }
        return kp
    }

    _.each([false, true], (useExpandOnOldFiles) => {

        it(`WDwdataFtp(SFTP, ${useExpandOnOldFiles ? '增量' : '全量'}模式): 第2輪伺服器加列敵意名稱時, 工作資料夾外無任何寫入, 既有檔照舊且不被移除`, async function() {
            let env = await setup(`wd_${useExpandOnOldFiles ? 'inc' : 'full'}`, 'SFTP', { sentinels })
            let fdsW = fdsOfW(env)
            let r1 = await runRound(env, fdsW, { useExpandOnOldFiles })
            assert.deepStrictEqual(r1.ids.add.sort(), ['a1.txt', 'a3.txt'])
            let before = snapshot(env.fdSbx)
            let names = ['../ESC1.txt', '../../ESC5.txt', 'a/../../ESC3.txt', '..\\ESC2.txt']
            env.srv.setFault({ virtual: names.map((n) => virtualOf(n)) })
            fs.writeFileSync(`${env.fdSbx}/srv/a3.txt`, 'real-a3-changed', 'utf8') //使本輪有變更而執行搬移

            let r2 = await runRound(env, fdsW, { useExpandOnOldFiles })

            assert.deepStrictEqual(outsideOf(snapshot(env.fdSbx)), outsideOf(before))
            assert.deepStrictEqual(r2.ids, { add: [], modify: ['a3.txt'], remove: [] })
            assert.deepStrictEqual(digestFirst(fdsW.fdDwStorage), { 'a1.txt': md5(Buffer.from('real-a1')), 'a3.txt': md5(Buffer.from('real-a3-changed')) })
            checkNoEcho([r2.logs, r2.res], names)
        })

    })

    _.each([
        { tag: 'wd_case', title: '同名加僅大小寫不同之檔', real: true, virtual: ['KEPT.TXT'] },
        { tag: 'wd_case2', title: '伺服器改列兩個僅大小寫不同之新名', real: false, virtual: ['Kept.TXT', 'KEPT.TXT'] },
    ], (c) => {

        it(`WDwdataFtp(SFTP, 全量模式): ${c.title}皆被拒時沿用fdDwStorage內同一本機檔之前次檔案, 不視為刪除(Windows)`, async function() {
            if (!isWin) {
                this.skip() //非Windows不拒僅大小寫不同之檔
            }
            let env = await setup(c.tag, 'SFTP', { files: { 'a1.txt': 'real-a1', 'kept.txt': 'real-kept-v1' } })
            let fdsW = fdsOfW(env)
            await runRound(env, fdsW)
            if (c.real) {
                fs.writeFileSync(`${env.fdSbx}/srv/kept.txt`, 'real-kept-v2', 'utf8')
            }
            else {
                fs.unlinkSync(`${env.fdSbx}/srv/kept.txt`)
            }
            fs.writeFileSync(`${env.fdSbx}/srv/a1.txt`, 'real-a1-changed', 'utf8')
            env.srv.setFault({ virtual: c.virtual.map((n) => virtualOf(n)) })

            let r = await runRound(env, fdsW)

            assert.deepStrictEqual(r.ids, { add: [], modify: ['a1.txt'], remove: [] })
            assert.deepStrictEqual(digestFirst(fdsW.fdDwStorage), { 'a1.txt': md5(Buffer.from('real-a1-changed')), 'kept.txt': md5(Buffer.from('real-kept-v1')) })
            let keep = r.logs.filter((v) => v.event === 'keep-previous-file')
            assert.deepStrictEqual(keep, [{ type: 'info', event: 'keep-previous-file', num: 1, msg: 'done' }])
            checkNoEcho([r.logs.filter((v) => v.event === 'ftp.syncToLocal' && v.type === 'error'), r.res], c.virtual)
        })

    })

    it('WDwdataFtp(SFTP, 全量模式): 本輪名稱皆被拒時取消該輪, fdDwStorage與fdResult不變且不呼叫刪除', async function() {
        let env = await setup('wd_all', 'SFTP', { files: { 'a1.txt': 'real-a1' } })
        let fdsW = fdsOfW(env)
        await runRound(env, fdsW)
        let before = snapshot(env.fdSbx)
        fs.unlinkSync(`${env.fdSbx}/srv/a1.txt`)
        env.srv.setFault({ virtual: [virtualOf('../ESC1.txt')] })
        let r = await runRound(env, fdsW)
        assert.deepStrictEqual(r.ids, { add: [], modify: [], remove: [] })
        assert.ok(r.res.msgCancel !== '', '本輪須取消')
        let after = snapshot(env.fdSbx)
        let pick = (snap) => _.pickBy(snap, (v, k) => /^l1\/l2\/(storage|result)(\/|$)/.test(k))
        assert.deepStrictEqual(pick(after), pick(before))
        assert.deepStrictEqual(outsideOf(after), outsideOf(before))
    })

    it('downloadFiles(SFTP): 整輪逾時與名稱被拒並存時, 未下載者以原名列入failed, 名稱被拒者列於其後', async function() {
        let env = await setup('expired', 'SFTP')
        env.srv.setFault({ virtual: [virtualOf('../ESC1.txt')] })
        mock.timers.enable({ apis: ['Date'], now: 1000000 })
        let r = null
        try {
            let trace = []
            r = await dw(env, {
                timeRound: 1000,
                onTrace: (e) => {
                    trace.push(e)
                    if (e.type === 'done' && e.name === 'a1.txt') {
                        mock.timers.tick(2000)
                    }
                },
            })
            assert.deepStrictEqual(trace.filter((e) => e.type === 'expired').map((e) => e.num), [1])
        }
        finally {
            mock.timers.reset()
        }
        assert.ok(r.settled === 'resolved', `須resolve, 但為${r.settled}: ${r.msg}`)
        assert.deepStrictEqual(r.res.failed, [
            { name: 'a3.txt', rpath: './a3.txt', attempts: 0, msg: 'timeRound exceeded' },
            { name: '', rpath: '', attempts: 0, msg: msgName },
        ])
        assert.deepStrictEqual(r.logs.filter((v) => v.msg === 'timeRound exceeded').map((v) => v.length), [1])
    })

    it('WDwdataFtp(SFTP, 全量模式): 名稱被拒者只沿用fdDwStorage第1層內同一本機檔; 未列於伺服器或僅同名檔存於子資料夾者不沿用(Windows)', async function() {
        if (!isWin) {
            this.skip() //非Windows收保留名
        }
        let env = await setup('wd_exact', 'SFTP', { files: { 'a1.txt': 'real-a1' } })
        let fdsW = fdsOfW(env)
        //fdDwStorage之前次檔案(含舊版寫入之Windows保留名字面檔案)
        w.fsCreateFolder(`${fdsW.fdDwStorage}/sub`)
        fs.writeFileSync(path.resolve(`${fdsW.fdDwStorage}/a1.txt`), 'real-a1', 'utf8')
        fs.writeFileSync(path.resolve(`${fdsW.fdDwStorage}/aux.c`), 'prev-aux', 'utf8')
        fs.writeFileSync(path.resolve(`${fdsW.fdDwStorage}/prn.log`), 'prev-prn', 'utf8')
        fs.writeFileSync(path.resolve(`${fdsW.fdDwStorage}/gone.txt`), 'prev-gone', 'utf8')
        fs.writeFileSync(path.resolve(`${fdsW.fdDwStorage}/sub/nul.txt`), 'prev-nested-nul', 'utf8')
        env.srv.setFault({ virtual: ['aux.c', 'PRN.LOG', 'nul.txt'].map((n) => virtualOf(n)) })
        fs.writeFileSync(`${env.fdSbx}/srv/a1.txt`, 'real-a1-changed', 'utf8')

        let r = await runRound(env, fdsW)

        assert.deepStrictEqual(r.ids.modify, ['a1.txt'])
        assert.deepStrictEqual(r.ids.add, [])
        assert.deepStrictEqual(_.without(r.ids.remove, 'sub'), ['gone.txt']) //伺服器未列gone.txt, 照刪除處理
        assert.deepStrictEqual(digestFirst(fdsW.fdDwStorage), { 'a1.txt': md5(Buffer.from('real-a1-changed')), 'aux.c': md5(Buffer.from('prev-aux')), 'prn.log': md5(Buffer.from('prev-prn')) })
        assert.deepStrictEqual(r.logs.filter((v) => v.event === 'keep-previous-file'), [{ type: 'info', event: 'keep-previous-file', num: 2, msg: 'done' }])
    })

    it('WDwdataFtp(SFTP, 增量模式): 名稱被拒之檔不沿用亦不影響累積之既有檔', async function() {
        let env = await setup('wd_inc_keep', 'SFTP', { files: { 'a1.txt': 'real-a1', 'kept.txt': 'real-kept-v1' } })
        let fdsW = fdsOfW(env)
        await runRound(env, fdsW, { useExpandOnOldFiles: true })
        env.srv.setFault({ virtual: [virtualOf('KEPT.TXT'), virtualOf('../ESC1.txt')] })
        fs.writeFileSync(`${env.fdSbx}/srv/a1.txt`, 'real-a1-changed', 'utf8')
        let r = await runRound(env, fdsW, { useExpandOnOldFiles: true })
        assert.deepStrictEqual(r.ids.remove, [])
        let st = digestFirst(fdsW.fdDwStorage)
        assert.deepStrictEqual(st['a1.txt'], md5(Buffer.from('real-a1-changed')))
        assert.ok(Object.keys(st).some((k) => st[k] === md5(Buffer.from('real-kept-v1'))), 'kept.txt之前次內容仍在')
        assert.ok(r.logs.every((v) => v.event !== 'keep-previous-file'), '增量模式不沿用')
    })

})
