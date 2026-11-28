# w-dwdata-ftp
A downloader for ftp data.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-dwdata-ftp.svg?style=flat)](https://npmjs.org/package/w-dwdata-ftp) 
[![license](https://img.shields.io/npm/l/w-dwdata-ftp.svg?style=flat)](https://npmjs.org/package/w-dwdata-ftp) 
[![npm download](https://img.shields.io/npm/dt/w-dwdata-ftp.svg)](https://npmjs.org/package/w-dwdata-ftp) 
[![npm download](https://img.shields.io/npm/dm/w-dwdata-ftp.svg)](https://npmjs.org/package/w-dwdata-ftp) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-dwdata-ftp.svg)](https://www.jsdelivr.com/package/npm/w-dwdata-ftp)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-dwdata-ftp/global.html).

## Download behavior
Requires `w-ftp` 1.0.75 or later. `downloadFiles` and `WDwdataFtp` never hand an incomplete file to the next stage:

* **Per-file download with retry.** Only the files in the first level of `st.fdIni` are downloaded, one by one. When a file fails (connection lost, timeout, size mismatch reported by `w-ftp`), the connection is closed, re-established (verified with `ls`) and the file is retried, at most `opt.retry` times (default `2`), waiting `opt.retryInterval` (default `2000` ms) before each retry.
* **A file that keeps failing does not fail the round.** It is listed in `failed` (`{ name, rpath, attempts, msg }`), is not in `files`, and leaves no residue in the target folder; the other files are still downloaded.
* **The whole round fails (the promise rejects and the target folder is emptied)** when the connection cannot be established, `ls` fails, the re-connection fails, or every file that has to be downloaded fails. An empty list is never handed over as a success.
* **Names reported by the server are checked before they are used as local file names.** A file whose name does not pass is not downloaded and nothing is written for it; it is listed in `failed` as `{ name: '', rpath: '', attempts: 0, msg }` (the name is not echoed in `failed`, the logs, the events or the error messages), after the files that failed to download, and the other files are still downloaded (if no file succeeds, the round fails as above). A name must be a single file name (not empty, not `.` or `..`, without `/`, `\` or `NUL`, on every platform) and the local path built from it must be inside the target folder. On Windows these are also rejected: `:`, a trailing dot or space, the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`, `CONIN$`, `CONOUT$`, also with an extension such as `nul.txt`), and files that differ only in letter case (all of them). The message is `invalid name from the server: must be a file name that can be saved inside fdDwStorageTemp`, or `invalid names from the server: must not differ only in letter case`. The FTP listing parser of `w-ftp` trims leading and trailing whitespace of names, so for FTP the trimmed name is downloaded. The criteria are those of `syncToLocal` of `w-ftp`, except that `\` is rejected on every platform. Not covered: names that only differ by Unicode normalization or letter case on macOS, and Windows 8.3 short names.
* **`opt.timeFile`** (default `100000` ms) is the time limit of one download attempt of one file and is passed to `w-ftp` as `timeLimit`; since `w-ftp` 1.0.75 it also limits SFTP, so large files need a larger value. **`opt.timeRound`** (default `0`, no limit) limits the whole round: after it expires no more files are downloaded or retried, and the remaining files are listed in `failed` (`attempts` is `0` for the files that were not started).
* **`st.fdDownloadTemp`** (the temp folder of `w-ftp`, default `./_wftpDownloadTemp`) must not be `fdDwStorageTemp` or inside it.
* **`WDwdataFtp`, full mode:** a file that failed to download keeps its previous version in `fdDwStorage` (it is not treated as deleted). A file rejected because of its name keeps the previous version too, when the first level of `fdDwStorage` holds the same local file (on Windows the name is compared ignoring letter case, elsewhere it must be identical).
* **`WDwdataFtp`, processing:** a file that `funAdd`, `funModify` or `funRemove` fails on (throws or rejects) does not stop the round: the other files are still processed (`w-data-scheduler` 1.0.77 or later). A changed or new file is moved into `fdDwStorage`, and a deleted file is removed from it, only when it is listed in `success` of the round result (the same rule `w-dwdata-builder` uses for `fdDwCurrent`). A file that failed, including one whose function succeeded but whose task-state update in `w-data-scheduler` failed afterwards (listed in `failed`), stays unprocessed and is processed again in the next round, so these functions must be safe to run more than once for the same file (at-least-once). A cancelled round (`msgCancel` is set, for example an error while reading the current data or comparing, or `no difference`) moves nothing. The retry behavior holds for the default comparison base (the files in `fdDwStorage`); a custom `funGetCurrent` that reads another store is outside of it, and with a custom `funDownload` no downloaded file is moved into `fdDwStorage` at all.
* **`WDwdataFtp`, round result:** `opt.funBeforeEnd` (called after the files have been moved, in a cancelled round without moving any; not called when `w-dwdata-builder` fails to update `fdDwCurrent`) and the listener of the `end` event receive `{ success: { add, modify, remove }, failed, msgCancel }`: the ids (file names) processed successfully, the failed items (`{ id, mode, event, msg }`) and the cancel message of the round (an empty string when it was not cancelled). `srLog.warn` receives a summary of the failed items.
* **Diagnostics:** `opt.onTrace` receives frozen events `{ type, ... }` (`ls`, `reject`, `attempt`, `done`, `fail`, `retry`, `reconnect`, `giveup`, `expired`; see the JSDoc of `downloadFiles`), errors it throws are ignored. With `opt.debug` set to `true`, an unexpected option value (which falls back to its default) is reported through `opt.funLog(msg, { fn, reason, key })` or `console.warn`, without the value (the options are read through the public `getOptReader` of wsemi; `fn` is its tag, `'w-dwdata-ftp WDwdataFtp'` or `'w-dwdata-ftp downloadFiles'`). Credentials are masked in the error texts of the server.

## Breaking changes
* Names reported by the server are checked (see *Download behavior*). Files with a rejected name are no longer downloaded: they appear in `failed` with an empty `name` and `rpath`, so code that reads `failed[].name` has to accept an empty string. This includes entries with an empty name, which used to be skipped silently, and on Windows every file of a group that differs only in letter case. If every file is rejected, the round fails. A caller that mirrors the result cannot tell which files these entries stand for, so it should not delete anything in a round that contains one. `onTrace` has a new event `reject` (`{ num }`), and `num` of the event `ls` does not count the rejected files.
* On Linux and macOS, names containing `\` are rejected as well. If `fdDwStorage` or `fdDwCurrent` already holds files with `\` in their names, remove them before upgrading.
* `downloadFiles` now resolves `{ files, failed }` instead of an array of files (no compatibility form is kept). A caller that mirrors the result (a file that is not in `files` is treated as deleted) has to handle `failed` itself, for example by reusing the previous version of the files in `failed`.
* The completeness of every file is verified by `w-ftp` (1.0.75 or later: the local size must equal the remote size), not by this package. An FTP server that does not support `SIZE` cannot be verified, so downloads from it are rejected and every file fails.
* As documented, only the files in the first level of `st.fdIni` are downloaded. Earlier `w-ftp` versions ignored this limit for SFTP and also put files of sub-folders into the temp folder; they are no longer downloaded.
* `st.fdDownloadTemp` is checked (see above), and the default time limit of one file (`100000` ms) now also applies to SFTP.
* With `w-dwdata-builder` 1.1.46 and `w-data-scheduler` 1.0.77 (or later), a file that `funAdd`, `funModify` or `funRemove` fails on no longer cancels the processing of the other files. The round does not emit `cancel-stage-main` and `cancel-stage-beforeEnd` for it; the failure is reported by its own `error` event, followed after the other files by a `warn` event `fail-items-stage-main`. `opt.funBeforeEnd` now receives the round result (see above), and `srLog.warn` is now called.
* `WDwdataFtp` now moves files into `fdDwStorage` according to the round result: a file whose function succeeded but whose task-state update failed is no longer moved (it is processed again in the next round), and a cancelled round moves nothing. Earlier a `no difference` round still synchronized `fdDwStorage`; this is visible only with a custom `funGetCurrent` whose data differs from `fdDwStorage`. Earlier a round cancelled because a custom `funGetCurrent` returned a non-array could also remove files whose deletion had not been processed.

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
    'transportation': 'FTP',
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
```
