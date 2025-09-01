import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import assert from 'assert'
import WDwdataFtp from '../src/WDwdataFtp.mjs'


describe('WDwdataFtp', function() {

    let test = async() => {

        let pm = w.genPm()

        let ms = []

        let st = {} //開啟useSimulateFiles=true直接模擬ftp下載數據

        //fdDwStorageTemp
        let fdDwStorageTemp = `./_dwStorageTemp`
        w.fsCleanFolder(fdDwStorageTemp)

        fs.writeFileSync(`${fdDwStorageTemp}/test1.txt`, 'test1-abc', 'utf8')
        fs.writeFileSync(`${fdDwStorageTemp}/test2.txt`, 'test2-def', 'utf8')

        //fdDwStorage
        let fdDwStorage = `./_dwStorage`
        w.fsCleanFolder(fdDwStorage)

        //fdDwAttime
        let fdDwAttime = `./_dwAttime`
        w.fsCleanFolder(fdDwAttime)

        //fdDwCurrent
        let fdDwCurrent = `./_dwCurrent`
        w.fsCleanFolder(fdDwCurrent)

        //fdResult
        let fdResult = './_result'
        w.fsCleanFolder(fdResult)

        let opt = {
            useSimulateFiles: true,
            useExpandOnOldFiles: false, //true, false
            fdDwStorageTemp,
            fdDwStorage,
            fdDwAttime,
            fdDwCurrent,
            fdResult,
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
            if (msg.event === 'end') {
                // console.log('ms', ms)
                pm.resolve(ms)
            }
        })
        // change { event: 'start', msg: 'running...' }
        // change { event: 'proc-callfun-download', msg: 'start...' }
        // change { event: 'proc-callfun-download', msg: 'done' }
        // change { event: 'proc-callfun-getCurrent', msg: 'start...' }
        // change { event: 'proc-callfun-getCurrent', msg: 'done' }
        // change { event: 'compare', msg: 'start...' }
        // change { event: 'compare', numRemove: 0, numAdd: 2, numModify: 0, numSame: 0, msg: 'done' }
        // change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' }
        // change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' }
        // change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' }
        // change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' }
        // ...

        return pm
    }
    let ms = [
        { event: 'start', msg: 'running...' },
        { event: 'proc-callfun-download', msg: 'start...' },
        { event: 'proc-callfun-download', num: 2, msg: 'done' },
        { event: 'proc-callfun-getCurrent', msg: 'start...' },
        { event: 'proc-callfun-getCurrent', num: 0, msg: 'done' },
        { event: 'compare', msg: 'start...' },
        { event: 'compare', numRemove: 0, numAdd: 2, numModify: 0, numSame: 0, msg: 'done' },
        {
            event: 'proc-add-callfun-add',
            id: 'test1.txt',
            msg: 'start...'
        },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' },
        {
            event: 'proc-add-callfun-add',
            id: 'test2.txt',
            msg: 'start...'
        },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' },
        { event: 'end', msg: 'done' }
    ]

    it('test in localhost', async () => {
        let r = await test()
        let rr = ms
        assert.strict.deepEqual(r, rr)
    })

})
