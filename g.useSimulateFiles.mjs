// import path from 'path'
import fs from 'fs'
// import _ from 'lodash-es'
import w from 'wsemi'
import WDwdataFtp from './src/WDwdataFtp.mjs'


let st = {} //開啟useSimulateFiles=true直接模擬ftp下載數據

//fdTagRemove
let fdTagRemove = `./_tagRemove`
w.fsCleanFolder(fdTagRemove)

//fdDwStorageTemp
let fdDwStorageTemp = `./_dwStorageTemp`
w.fsCleanFolder(fdDwStorageTemp)

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
let fdResult = `./_result`
w.fsCleanFolder(fdResult)

//fdTaskCpActualSrc
let fdTaskCpActualSrc = `./_taskCpActualSrc`
w.fsCleanFolder(fdTaskCpActualSrc)

//fdTaskCpSrc
let fdTaskCpSrc = `./_taskCpSrc`
w.fsCleanFolder(fdTaskCpSrc)

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
        console.log('change', msg)
    })
    ev.on('end', () => {
        pm.resolve()
    })

    return pm
}
await w.pmSeries(kpOper, async() => {
    await run()
})
// change { event: 'compare', msg: 'start...' }
// change {
//   event: 'compare',
//   numRemove: 0,
//   numAdd: 1,
//   numModify: 0,
//   numSame: 0,
//   msg: 'done'
// }
// change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' }
// change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' }
// change { event: 'end', msg: 'done' }
// change { event: 'compare', msg: 'start...' }
// change {
//   event: 'compare',
//   numRemove: 0,
//   numAdd: 1,
//   numModify: 0,
//   numSame: 1,
//   msg: 'done'
// }
// change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' }
// change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' }
// change { event: 'end', msg: 'done' }
// change { event: 'compare', msg: 'start...' }
// change {
//   event: 'compare',
//   numRemove: 0,
//   numAdd: 0,
//   numModify: 1,
//   numSame: 1,
//   msg: 'done'
// }
// change { event: 'proc-diff-callfun-modify', id: 'test2.txt', msg: 'start...' }
// change { event: 'proc-diff-callfun-modify', id: 'test2.txt', msg: 'done' }
// change { event: 'end', msg: 'done' }


//node g.useSimulateFiles.mjs
