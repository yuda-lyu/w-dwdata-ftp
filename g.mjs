// import path from 'path'
// import fs from 'fs'
// import _ from 'lodash-es'
import w from 'wsemi'
import WDwdataFtp from './src/WDwdataFtp.mjs'


let st = {
    'hostname': '{hostname}',
    'port': 21,
    'username': '{username}',
    'password': '{password}',
    'fdIni': './'
}
// console.log('st', st)

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
    console.log('change', msg)
})
// change { event: 'start', msg: 'running...' }
// change { event: 'proc-callfun-afterStart', msg: 'start...' }
// change { event: 'proc-callfun-afterStart', msg: 'done' }
// change { event: 'proc-callfun-download', msg: 'start...' }
// change { event: 'proc-callfun-download', num: 2, msg: 'done' }
// change { event: 'proc-callfun-getCurrent', msg: 'start...' }
// change { event: 'proc-callfun-getCurrent', num: 0, msg: 'done' }
// change { event: 'proc-compare', msg: 'start...' }
// change { event: 'proc-compare', numRemove: 0, numAdd: 2, numModify: 0, numSame: 0, msg: 'done' }
// change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' }
// change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' }
// change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' }
// change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' }
// ...


//node g.mjs
