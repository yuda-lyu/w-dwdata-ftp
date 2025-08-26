# w-dwdata-ftp
A download tool for earthquake ML and PGA data from Taiwan CWA.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-dwdata-ftp.svg?style=flat)](https://npmjs.org/package/w-dwdata-ftp) 
[![license](https://img.shields.io/npm/l/w-dwdata-ftp.svg?style=flat)](https://npmjs.org/package/w-dwdata-ftp) 
[![npm download](https://img.shields.io/npm/dt/w-dwdata-ftp.svg)](https://npmjs.org/package/w-dwdata-ftp) 
[![npm download](https://img.shields.io/npm/dm/w-dwdata-ftp.svg)](https://npmjs.org/package/w-dwdata-ftp) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-dwdata-ftp.svg)](https://www.jsdelivr.com/package/npm/w-dwdata-ftp)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-dwdata-ftp/global.html).

## Installation
### Using npm(ES6 module):
```alias
npm i w-dwdata-ftp
```

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-dwdata-ftp/blob/master/g.mjs)]
```alias
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
let fdResult = './_result'
w.fsCleanFolder(fdResult)

let opt = {
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
    console.log('change', msg)
})
// change { event: 'start', msg: 'running...' }
// change { event: 'proc-callfun-download', msg: 'start...' }
// change { event: 'proc-callfun-download', msg: 'done' }
// change { event: 'proc-callfun-getCurrent', msg: 'start...' }
// change { event: 'proc-callfun-getCurrent', msg: 'done' }
// change { event: 'compare', msg: 'start...' }
// change { event: 'compare', msg: 'done' }
// change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'start...' }
// change { event: 'proc-add-callfun-add', id: 'test1.txt', msg: 'done' }
// change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'start...' }
// change { event: 'proc-add-callfun-add', id: 'test2.txt', msg: 'done' }
// ...
```
