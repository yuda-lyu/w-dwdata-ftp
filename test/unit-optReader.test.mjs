import fs from 'fs'
import assert from 'assert'
import getOptReader from 'wsemi/src/getOptReader.mjs'


//opt讀取之接線測試(規則R-DL-09): 本套件不自寫opt讀取器, WDwdataFtp與downloadFiles之opt取值、種類檢測、debug警告一律經wsemi公開之getOptReader(單一擁有者)
//opt之行為(讀取拋錯視為未給、非預期輸入改用預設、debug警告之出口與去重)由unit-downloadFail.test.mjs以行為驗證, 本檔釘住接線與不自寫
describe('optReader', function() {

    //findOwnReaders, 掃描原始碼中自寫之opt讀取器: 名為readKey/pickOpt/readOpt/optReader之函數或變數, 或「typeof x === 'object' && x !== null」之物件判斷寫法(自寫讀取器之慣用寫法)
    let findOwnReaders = (src) => {
        let hits = []
        let re1 = /(?:\bfunction\s+(?:readKey|pickOpt|readOpt|optReader)\b|\b(?:let|const|var)\s+(?:readKey|pickOpt|readOpt|optReader)\s*=)/g
        let re2 = /typeof\s+(\w+)\s*===\s*'object'\s*&&\s*\1\s*!==\s*null/g
        for (let re of [re1, re2]) {
            for (let m of src.matchAll(re)) {
                hits.push(m[0])
            }
        }
        return hits
    }

    it('掃描器之盲點自測: 抓得到自寫讀取器之各種寫法, 不誤抓一般判斷', function() {
        let positives = [
            'let readKey = (opt, key) => {\n    try {\n        if ((typeof opt === \'object\' && opt !== null) || typeof opt === \'function\') {',
            'function pickOpt(opt, key) {',
            'const readOpt = (opt, key) => opt[key]',
            'let optReader = (fn, opt) => {',
            'if (typeof o === \'object\' && o !== null) { return o[k] }',
        ]
        for (let s of positives) {
            assert.ok(findOwnReaders(s).length > 0, `掃描器須抓到自寫讀取器之寫法: ${s.slice(0, 30)}`)
        }
        let negatives = ['let a = typeof x === \'object\'', 'function readKeys() {}', 'let readKeyMap = 1', 'import getOptReader from \'wsemi/src/getOptReader.mjs\'']
        for (let s of negatives) {
            assert.ok(findOwnReaders(s).length === 0, `掃描器不得誤抓: ${s}`)
        }
    })

    it('規則R-DL-09: src不自寫opt讀取器(無_optReader.mjs, 無自寫之讀取寫法), 不引用wsemi內部模組', function() {
        assert.ok(!fs.existsSync('./src/_optReader.mjs'), '自寫之src/_optReader.mjs須已刪除')
        let files = fs.readdirSync('./src').filter((f) => f.endsWith('.mjs'))
        assert.ok(files.length >= 2, `掃描檔數須不少於2(實際${files.length})`)
        let hits = []
        for (let f of files) {
            let src = fs.readFileSync(`./src/${f}`, 'utf8')
            for (let h of findOwnReaders(src)) {
                hits.push(`${f}: ${h.slice(0, 40)}`)
            }
            for (let m of src.matchAll(/from\s+'(wsemi\/src\/_[^']*|\.\/_[^']*)'/g)) {
                hits.push(`${f}: 引用內部模組 ${m[1]}`)
            }
        }
        assert.ok(hits.length === 0, `src不得自寫opt讀取器或引用內部模組: ${hits.join(' | ')}`)
    })

    it('接線: WDwdataFtp與downloadFiles皆匯入wsemi getOptReader, 且以各自之tag(w-dwdata-ftp <函數名>)呼叫; opt之特殊讀取皆經rd.read', function() {
        let srcFtp = fs.readFileSync('./src/WDwdataFtp.mjs', 'utf8')
        let srcDw = fs.readFileSync('./src/downloadFiles.mjs', 'utf8')
        for (let [name, src] of [['WDwdataFtp', srcFtp], ['downloadFiles', srcDw]]) {
            assert.ok(/import getOptReader from 'wsemi\/src\/getOptReader\.mjs'/.test(src), `${name}須匯入wsemi getOptReader`)
            assert.ok(src.includes(`getOptReader('w-dwdata-ftp ${name}', opt)`), `${name}須以getOptReader('w-dwdata-ftp ${name}', opt)取讀取函數`)
            assert.ok(/\brd\.read\('srLog'\)/.test(src), `${name}之srLog須經rd.read讀取(讀取拋錯視為未給)`)
        }
        for (let k of ['retry', 'retryInterval', 'timeFile', 'timeRound', 'onTrace']) {
            assert.ok(srcFtp.includes(`rd.read('${k}')`), `WDwdataFtp轉傳給downloadFiles之${k}須經rd.read讀取`)
        }
        assert.ok(srcFtp.includes('debug: rd.debug') && srcFtp.includes('funLog: rd.funLog'), 'WDwdataFtp須以rd.debug與rd.funLog轉傳給downloadFiles(下游不再讀自己之opt以外之來源)')
    })

    it('wsemi getOptReader可用(版本須為1.9.82以上)且帶resetWarned', function() {
        assert.ok(typeof getOptReader === 'function', 'getOptReader須為函數')
        assert.ok(typeof getOptReader.resetWarned === 'function', 'getOptReader.resetWarned須為函數')
        let rd = getOptReader('w-dwdata-ftp test', { a: 1 })
        assert.ok(typeof rd === 'function' && typeof rd.read === 'function', 'rd與rd.read須為函數')
        assert.ok(rd.read('a') === 1 && rd.debug === false && rd.funLog === null, 'rd.read須讀原值, 未給debug時rd.debug為false、rd.funLog為null')
    })

})
