import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import assert from 'assert'
import WDwdataFtp from '../src/WDwdataFtp.mjs'


describe('once', function() {

    let test = async() => {

        let pm = w.genPm()

        let ms = []

        let st = {} //開啟useSimulateFiles=true直接模擬ftp下載數據

        //fdDwStorageTemp
        let fdDwStorageTemp = `./_dwStorageTemp`
        w.fsCleanFolder(fdDwStorageTemp)

        fs.writeFileSync(`${fdDwStorageTemp}/test1.txt`, 'test1-abc', 'utf8')
        fs.writeFileSync(`${fdDwStorageTemp}/test2.txt`, 'test2-def', 'utf8')

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

        let opt = {
            useSimulateFiles: true,
            useExpandOnOldFiles: false, //true, false
            fdTagRemove,
            fdDwStorageTemp,
            fdDwStorage,
            fdDwAttime,
            fdDwCurrent,
            fdResult,
            fdTaskCpActualSrc,
            fdTaskCpSrc,
            // fdLog,
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
        ev.on('end', () => {

            w.fsDeleteFolder(fdTagRemove)
            w.fsDeleteFolder(fdDwStorageTemp)
            w.fsDeleteFolder(fdDwStorage)
            w.fsDeleteFolder(fdDwAttime)
            w.fsDeleteFolder(fdDwCurrent)
            w.fsDeleteFolder(fdResult)
            w.fsDeleteFolder(fdTaskCpActualSrc)
            w.fsDeleteFolder(fdTaskCpSrc)

            // console.log('ms', ms)
            pm.resolve(ms)
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
        { event: 'move-files-to-storage', msg: 'start...' },
        { event: 'move-files-to-storage', msg: 'done' },
        { event: 'proc-callfun-beforeEnd', msg: 'done' },
        { event: 'end', msg: 'done' }
    ]

    it('test once', async () => {
        let r = await test()
        let rr = ms
        assert.strict.deepEqual(r, rr)
    })

})
