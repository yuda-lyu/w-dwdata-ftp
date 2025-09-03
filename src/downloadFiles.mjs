import get from 'lodash-es/get.js'
import size from 'lodash-es/size.js'
import filter from 'lodash-es/filter.js'
import isbol from 'wsemi/src/isbol.mjs'
import fsCleanFolder from 'wsemi/src/fsCleanFolder.mjs'
import WFtp from 'w-ftp/src/WFtp.mjs'
import fsTreeFolder from 'wsemi/src/fsTreeFolder.mjs'


let downloadFiles = async(st, fdDwStorageTemp, fdDwStorage, opt = {}) => {
    let errTemp = null

    //useExpandOnOldFiles
    let useExpandOnOldFiles = get(opt, 'useExpandOnOldFiles')
    if (!isbol(useExpandOnOldFiles)) {
        useExpandOnOldFiles = false
    }

    //useSimulateFiles, 供測試用, 檔案得預先給予至fdDwStorageTemp
    let useSimulateFiles = get(opt, 'useSimulateFiles')
    if (!isbol(useSimulateFiles)) {
        useSimulateFiles = false
    }

    //core
    let core = async() => {

        //fsCleanFolder
        fsCleanFolder(fdDwStorageTemp)

        //ftp
        let ftp = WFtp({
            ...st,
            timeLimit: 100 * 1000, //100s
        })
        // console.log('ftp', ftp)

        //conn
        await ftp.conn()

        //syncFiles
        let syncFiles = async () => {

            //ls
            // let fps = await ftp.ls('.')
            let fps = await ftp.ls(st.fdIni)
            // console.log('ftp.ls', fps[0], fps.length)
            console.log('ftp.ls', fps.length)

            //syncToLocal
            let r = await ftp.syncToLocal(
                st.fdIni,
                fdDwStorageTemp,
                (p) => {
                    console.log('ftp.syncToLocal p', p.name, p.progress)
                },
                {
                    levelLimit: 1, //僅下載第1層內檔案
                    forceOverwriteWhenSync: true, //強制全下載進行複寫本機數據
                },
            )
            console.log('ftp.syncToLocal r', r)

        }
        await syncFiles()
            .catch((err) => { //須catch, 避免操作指令失敗造成程序中止
                console.log(err)
            })

        //quit
        let r = await ftp.quit()
        console.log('ftp.quit', r)

    }

    if (!useSimulateFiles) {

        //core
        await core()
            .catch((err) => { //須再catch, 避免無法連線SFTP時中止程序
                console.log(err)
                errTemp = err
            })

        //check
        if (errTemp !== null) {
            return Promise.reject(errTemp)
        }

    }

    //vfps
    let vfps = fsTreeFolder(fdDwStorageTemp, 1)
    vfps = filter(vfps, (v) => {
        return !v.isFolder //僅使用檔案
    })
    // console.log('vfps', vfps)

    //check
    if (size(vfps) === 0) {
        errTemp = 'no files'
        throw new Error(errTemp)
    }

    // //useExpandOnOldFiles
    // if (useExpandOnOldFiles) {

    //     //複製fdDwStorageTemp內所下載檔案至合併儲存資料夾fdDwStorage
    //     each(vfps, (v) => {

    //         //fsCopyFile
    //         let fpSrc = v.path
    //         let fpTar = `${fdDwStorage}/${v.name}`
    //         let r = fsCopyFile(fpSrc, fpTar)

    //         //check
    //         if (r.error) {
    //             console.log(r.error)
    //             errTemp = r.error
    //             return false //跳出
    //         }

    //     })

    // }
    // else {

    //     //清空合併儲存資料夾fdDwStorage
    //     fsCleanFolder(fdDwStorage)

    //     //複製fdDwStorageTemp內所有下載檔案至合併儲存資料夾fdDwStorage
    //     let r = fsCopyFolder(fdDwStorageTemp, fdDwStorage)

    //     //check
    //     if (r.error) {
    //         console.log(r.error)
    //         errTemp = r.error
    //     }

    // }

    //check
    if (errTemp !== null) {
        return Promise.reject(errTemp)
    }

    return vfps
}


export default downloadFiles
