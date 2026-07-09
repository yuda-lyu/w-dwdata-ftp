import fs from 'fs'
import w from 'wsemi'
import assert from 'assert'
import WDwdataFtp from '../src/WDwdataFtp.mjs'
import fakeSftpServer from './lib/fakeSftpServer.mjs'
import deleteLogFolder from './lib/deleteLogFolder.mjs'


describe('once', function() {

    let test = async() => {

        let pm = w.genPm()

        let ms = []

        //fdSrv, 假SFTP伺服器根目錄, 內含第1層2個檔案與第2層1個檔案
        let fdSrv = `./_once_srv`
        w.fsCleanFolder(fdSrv)
        fs.writeFileSync(`${fdSrv}/test1.txt`, 'test1-abc', 'utf8')
        fs.writeFileSync(`${fdSrv}/test2.txt`, 'test2-def', 'utf8')
        w.fsCreateFolder(`${fdSrv}/sub`)
        fs.writeFileSync(`${fdSrv}/sub/test3.txt`, 'test3-ghi', 'utf8')

        //srv, port給0由系統指派, 避免平行測試時衝突
        let srv = await fakeSftpServer({ fdRoot: fdSrv })

        //st, 連線至假SFTP伺服器
        let st = {
            transportation: 'SFTP',
            hostname: '127.0.0.1',
            port: srv.port,
            username: 'u1',
            password: 'p1',
            fdIni: '.',
        }

        //fdDwStorageTemp
        let fdDwStorageTemp = `./_once_dwStorageTemp`
        w.fsCleanFolder(fdDwStorageTemp)

        //fdTagRemove
        let fdTagRemove = `./_once_tagRemove`
        w.fsCleanFolder(fdTagRemove)

        //fdDwStorage
        let fdDwStorage = `./_once_dwStorage`
        w.fsCleanFolder(fdDwStorage)

        //fdDwAttime
        let fdDwAttime = `./_once_dwAttime`
        w.fsCleanFolder(fdDwAttime)

        //fdDwCurrent
        let fdDwCurrent = `./_once_dwCurrent`
        w.fsCleanFolder(fdDwCurrent)

        //fdResult
        let fdResult = `./_once_result`
        w.fsCleanFolder(fdResult)

        //fdTaskCpActualSrc
        let fdTaskCpActualSrc = `./_once_taskCpActualSrc`
        w.fsCleanFolder(fdTaskCpActualSrc)

        //fdTaskCpSrc
        let fdTaskCpSrc = `./_once_taskCpSrc`
        w.fsCleanFolder(fdTaskCpSrc)

        //fdLog
        let fdLog = `./_once_logs`
        w.fsCleanFolder(fdLog)

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
            // console.log('change', msg)
            ms.push(msg)
        })
        ev.on('end', async() => {

            //cts, 下載後所連動生成數據之實際內容
            let cts = {}
            w.fsTreeFolder(fdResult, 1).forEach((v) => {
                cts[v.name] = fs.readFileSync(`${v.path}/${v.name}`, 'utf8')
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
            pm.resolve({ ms, cts })
        })

        return pm
    }
    let ms = [
        { event: 'start', msg: 'running...' },
        { event: 'proc-callfun-afterStart', msg: 'start...' },
        { event: 'proc-callfun-afterStart', msg: 'done' },
        { event: 'proc-callfun-download', msg: 'start...' },
        { event: 'proc-callfun-download', num: 2, msg: 'done' },
        { event: 'proc-callfun-getCurrent', msg: 'start...' },
        { event: 'proc-callfun-getCurrent', num: 0, msg: 'done' },
        { event: 'proc-compare', msg: 'start...' },
        {
            event: 'proc-compare',
            numRemove: 0,
            numAdd: 2,
            numModify: 0,
            numSame: 0,
            msg: 'done'
        },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' },
        { event: 'proc-callfun-beforeEnd', msg: 'start...' },
        { event: 'proc-callfun-beforeEnd', msg: 'done' },
        { event: 'end', msg: 'done' }
    ]
    let cts = { //僅下載伺服器第1層檔案, sub/test3.txt不納入
        'test1.txt': 'test1-abc',
        'test2.txt': 'test2-def',
    }

    it('test once', async () => {
        let r = await test()
        let rr = { ms, cts }
        assert.strict.deepEqual(r, rr)
    })

})
