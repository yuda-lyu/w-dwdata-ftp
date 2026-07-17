import fs from 'fs'
import w from 'wsemi'
import assert from 'assert'
import WDwdataFtp from '../src/WDwdataFtp.mjs'
import fakeSftpServer from './lib/fakeSftpServer.mjs'
import fakeFtpServer from './lib/fakeFtpServer.mjs'
import deleteLogFolder from './lib/deleteLogFolder.mjs'


describe('multi', function() {

    //test, transportation可選'SFTP'或'FTP', fakeServer給予對應之假伺服器
    let test = async(transportation, fakeServer) => {
        let ms = []

        //tag, 各協定使用獨立資料夾避免互相干擾
        let tag = `_multi_${transportation.toLowerCase()}`

        //fdSrv, 假伺服器根目錄
        let fdSrv = `./${tag}_srv`
        w.fsCleanFolder(fdSrv)

        //srv, port給0由系統指派, 避免平行測試時衝突
        let srv = await fakeServer({ fdRoot: fdSrv })

        //st, 連線至假伺服器
        let st = {
            transportation,
            hostname: '127.0.0.1',
            port: srv.port,
            username: 'u1',
            password: 'p1',
            fdIni: '.',
        }

        //fdTagRemove
        let fdTagRemove = `./${tag}_tagRemove`
        w.fsCleanFolder(fdTagRemove)

        //fdDwStorageTemp
        let fdDwStorageTemp = `./${tag}_dwStorageTemp`
        w.fsCleanFolder(fdDwStorageTemp)

        //fdDwStorage
        let fdDwStorage = `./${tag}_dwStorage`
        w.fsCleanFolder(fdDwStorage)

        //fdDwAttime
        let fdDwAttime = `./${tag}_dwAttime`
        w.fsCleanFolder(fdDwAttime)

        //fdDwCurrent
        let fdDwCurrent = `./${tag}_dwCurrent`
        w.fsCleanFolder(fdDwCurrent)

        //fdResult
        let fdResult = `./${tag}_result`
        w.fsCleanFolder(fdResult)

        //fdTaskCpActualSrc
        let fdTaskCpActualSrc = `./${tag}_taskCpActualSrc`
        w.fsCleanFolder(fdTaskCpActualSrc)

        //fdTaskCpSrc
        let fdTaskCpSrc = `./${tag}_taskCpSrc`
        w.fsCleanFolder(fdTaskCpSrc)

        //fdLog
        let fdLog = `./${tag}_logs`
        w.fsCleanFolder(fdLog)

        let kpOper = {
            1: () => {
                fs.writeFileSync(`${fdSrv}/test1.txt`, 'test1-abc', 'utf8')
            },
            2: () => { //add test2.txt
                fs.writeFileSync(`${fdSrv}/test1.txt`, 'test1-abc', 'utf8')
                fs.writeFileSync(`${fdSrv}/test2.txt`, 'test2-def', 'utf8')
            },
            3: () => { //modify test2.txt
                fs.writeFileSync(`${fdSrv}/test1.txt`, 'test1-abc', 'utf8')
                fs.writeFileSync(`${fdSrv}/test2.txt`, 'test2-def-modify', 'utf8')
            },
        }

        let i = 0
        let run = async() => {
            i++

            let pm = w.genPm()

            //依照i更新假伺服器內待下載檔案
            kpOper[i]()

            let opt = {
                useExpandOnOldFiles: false, //true, false
                fdTagRemove,
                fdDwStorageTemp,
                fdDwStorage,
                fdDwAttime,
                fdDwCurrent,
                fdResult,
                fdTaskCpActualSrc,
                fdTaskCpSrc,
                fdLog,
                // funDownload,
                // funGetCurrent,
                // funRemove,
                // funAdd,
                // funModify,
            }
            let ev = await WDwdataFtp(st, opt)
                .catch((err) => {
                    console.log(err)
                })
            ev.on('change', (msg) => {
                delete msg.type
                delete msg.timeRunStart
                delete msg.timeRunEnd
                delete msg.timeRunSpent
                if (w.arrHas(msg.event, [
                    'start',
                    'proc-callfun-download',
                    'proc-callfun-getCurrent',
                    'proc-callfun-afterStart',
                    'proc-callfun-beforeEnd',
                    'move-files-to-storage',
                ])) {
                    return
                }
                // console.log('change', msg)
                ms.push(msg)
            })
            ev.on('end', () => {
                pm.resolve()
            })

            return pm
        }
        await w.pmSeries(kpOper, async() => {
            await run()
        })

        await srv.close()

        w.fsDeleteFolder(fdSrv)
        w.fsDeleteFolder(fdTagRemove)
        w.fsDeleteFolder(fdDwStorageTemp)
        w.fsDeleteFolder(fdDwStorage)
        w.fsDeleteFolder(fdDwAttime)
        w.fsDeleteFolder(fdDwCurrent)
        w.fsDeleteFolder(fdResult)
        w.fsDeleteFolder(fdTaskCpActualSrc)
        w.fsDeleteFolder(fdTaskCpSrc)
        await deleteLogFolder(fdLog)

        // console.log('ms', ms)
        return ms
    }
    let ms = [
        { event: 'proc-compare', msg: 'start...' },
        {
            event: 'proc-compare',
            numRemove: 0,
            numAdd: 1,
            numModify: 0,
            numSame: 0,
            msg: 'done'
        },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' },
        { event: 'end', msg: 'done' },
        { event: 'proc-compare', msg: 'start...' },
        {
            event: 'proc-compare',
            numRemove: 0,
            numAdd: 1,
            numModify: 0,
            numSame: 1,
            msg: 'done'
        },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' },
        { event: 'end', msg: 'done' },
        { event: 'proc-compare', msg: 'start...' },
        {
            event: 'proc-compare',
            numRemove: 0,
            numAdd: 0,
            numModify: 1,
            numSame: 1,
            msg: 'done'
        },
        {
            event: 'proc-diff-callfun-modify',
            id: 'test2.txt',
            msg: 'start...'
        },
        { event: 'proc-diff-callfun-modify', id: 'test2.txt', msg: 'done' },
        { event: 'end', msg: 'done' }
    ]

    it('test multi (SFTP)', async () => {
        let r = await test('SFTP', fakeSftpServer)
        let rr = ms
        assert.strict.deepEqual(r, rr)
    })

    it('test multi (FTP)', async () => {
        let r = await test('FTP', fakeFtpServer)
        let rr = ms
        assert.strict.deepEqual(r, rr)
    })

})
