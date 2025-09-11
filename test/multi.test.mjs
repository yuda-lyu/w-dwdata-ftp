import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import assert from 'assert'
import WDwdataFtp from '../src/WDwdataFtp.mjs'


describe('multi', function() {

    let test = async() => {
        let ms = []

        let st = {} //開啟useSimulateFiles=true直接模擬ftp下載數據

        //fdDwStorageTemp
        let fdDwStorageTemp = `./_multi_dwStorageTemp`
        w.fsCleanFolder(fdDwStorageTemp)

        //fdDwStorage
        let fdDwStorage = `./_multi_dwStorage`
        w.fsCleanFolder(fdDwStorage)

        //fdDwAttime
        let fdDwAttime = `./_multi_dwAttime`
        w.fsCleanFolder(fdDwAttime)

        //fdDwCurrent
        let fdDwCurrent = `./_multi_dwCurrent`
        w.fsCleanFolder(fdDwCurrent)

        //fdResult
        let fdResult = './_multi_result'
        w.fsCleanFolder(fdResult)

        let kpOper = {
            1: () => {
                fs.writeFileSync(`${fdDwStorageTemp}/test1.txt`, 'test1-abc', 'utf8')
            },
            2: () => { //add test2.txt
                fs.writeFileSync(`${fdDwStorageTemp}/test1.txt`, 'test1-abc', 'utf8')
                fs.writeFileSync(`${fdDwStorageTemp}/test2.txt`, 'test2-def', 'utf8')
            },
            3: () => { //modify test2.txt
                fs.writeFileSync(`${fdDwStorageTemp}/test1.txt`, 'test1-abc', 'utf8')
                fs.writeFileSync(`${fdDwStorageTemp}/test2.txt`, 'test2-def-modify', 'utf8')
            },
        }

        let i = 0
        let run = async() => {
            i++

            let pm = w.genPm()

            //依照i模擬ftp下載數據
            kpOper[i]()

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
                if (w.arrHas(msg.event, [
                    'start',
                    'proc-callfun-download',
                    'proc-callfun-getCurrent',
                    'proc-callfun-afterStart',
                    'proc-callfun-beforeEnd',
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

        w.fsDeleteFolder(fdDwStorageTemp)
        w.fsDeleteFolder(fdDwStorage)
        w.fsDeleteFolder(fdDwAttime)
        w.fsDeleteFolder(fdDwCurrent)
        w.fsDeleteFolder(fdResult)

        // console.log('ms', ms)
        return ms
    }
    let ms = [
        { event: 'compare', msg: 'start...' },
        {
            event: 'compare',
            numRemove: 0,
            numAdd: 1,
            numModify: 0,
            numSame: 0,
            msg: 'done'
        },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' },
        { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' },
        { event: 'end', msg: 'done' },
        { event: 'compare', msg: 'start...' },
        {
            event: 'compare',
            numRemove: 0,
            numAdd: 1,
            numModify: 0,
            numSame: 1,
            msg: 'done'
        },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' },
        { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' },
        { event: 'end', msg: 'done' },
        { event: 'compare', msg: 'start...' },
        {
            event: 'compare',
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

    it('test multi', async () => {
        let r = await test()
        let rr = ms
        assert.strict.deepEqual(r, rr)
    })

})
