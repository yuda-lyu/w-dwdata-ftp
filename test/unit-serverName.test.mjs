import path from 'path'
import assert from 'assert'
import chkServerName from '../src/chkServerName.mjs'


//伺服器回報之名稱用於本機路徑前之檢查(src/chkServerName.mjs)之單元測試, 判準見sgud/rule/rulebook.md之R-SN-01～R-SN-03與downloadFiles之JSDoc
describe('serverName', function() {

    let { isEntry, isSavable, isInside, fold, splitNames } = chkServerName

    //notEntries, 各平台皆非單一名稱
    let notEntries = [
        undefined, null, 1, true, {}, ['a'], '', '.', '..', '/', 'a/b', '../x', '../../x', 'a/../../x', '/abs', 'C:/x', 'a/', 'a\0b', '\0',
        '\\', '..\\x', 'a\\b', '\\abs', 'x\\..\\..\\y', 'C:\\x', '\\\\host\\share\\x', //反斜線
    ]

    //winRejects, 單一名稱但Windows無法原樣儲存
    let winRejects = [
        'C:x', 'q:s', 'a.txt:s1', ':x', //冒號
        'a.', 'a ', 'a.txt.', 'a.txt ', '.. ', '...', 'a..', ' ', //尾端之點或空白
        'CON', 'con', 'Con', 'PRN', 'AUX', 'NUL', 'nul', 'nul.txt', 'aux.c', 'prn.tar.gz', 'COM0', 'COM1', 'com9', 'COM¹', 'com²', 'Com³',
        'LPT0', 'LPT9', 'lpt1.log', 'LPT¹', 'CONIN$', 'conin$', 'CONOUT$', 'conout$.txt', 'CON .txt', 'nul  .x', //保留裝置名
    ]

    //savables, 各平台皆可原樣儲存
    let savables = [
        'a', 'a.txt', '.hidden', '..a', 'a..b', ' a', 'a b.txt', '中文.csv', 'CONSOLE', 'CON1', 'COM', 'COM10', 'LPT', 'LPT10', 'nulx.txt', 'x.nul', 'a.con',
        'CONIN', 'conout', 'CONIN$x', 'x$', '~x', 'a\'b', 'a;b', 'a%2e%2e', '…', 'a\u00a0', 'a_', 'a-', ' .a',
    ]

    it('規則R-SN-01: 非字串、空字串、.、..、含/、反斜線或NUL之名稱於各平台皆拒', function() {
        for (let name of notEntries) {
            let label = JSON.stringify(name) || String(name)
            assert.ok(isEntry(name) === false, `isEntry須拒: ${label}`)
            assert.ok(isSavable(name, 'win32') === false, `isSavable(win32)須拒: ${label}`)
            assert.ok(isSavable(name, 'linux') === false, `isSavable(linux)須拒: ${label}`)
        }
    })

    it('規則R-SN-02: Windows另拒冒號、尾端之點或空白、保留裝置名(含加副檔名); 非Windows收之', function() {
        for (let name of winRejects) {
            let label = JSON.stringify(name)
            assert.ok(isEntry(name) === true, `isEntry須收: ${label}`)
            assert.ok(isSavable(name, 'win32') === false, `isSavable(win32)須拒: ${label}`)
            assert.ok(isSavable(name, 'linux') === true, `isSavable(linux)須收: ${label}`)
            assert.ok(isSavable(name, 'darwin') === true, `isSavable(darwin)須收: ${label}`)
        }
    })

    it('規則R-SN-02: 一般名稱(含前導空白、開頭之點、近似但非保留名者)於各平台皆收, 未給platform時依本機平台', function() {
        for (let name of savables) {
            let label = JSON.stringify(name)
            assert.ok(isSavable(name, 'win32') === true, `isSavable(win32)須收: ${label}`)
            assert.ok(isSavable(name, 'linux') === true, `isSavable(linux)須收: ${label}`)
        }
        assert.ok(isSavable('a:b') === (process.platform !== 'win32'), '未給platform時依process.platform')
    })

    it('規則R-SN-03: 落點以path.relative判定嚴格位於資料夾內(不含資料夾本身), 不比字串前綴', function() {
        let w = path.win32
        let fdW = 'C:\\a\\out'
        for (let [fp, exp] of [
            ['C:\\a\\out\\x', true], ['C:\\a\\out\\..x', true], ['C:\\a\\out\\s\\x', true], ['c:\\A\\OUT\\x', true],
            ['C:\\a\\out', false], ['C:\\a', false], ['C:\\a\\x', false], ['C:\\a\\out-evil\\x', false], ['C:\\a\\out\\..\\x', false], ['D:\\x', false], ['\\\\host\\share\\x', false],
        ]) {
            assert.ok(isInside(fdW, fp, w) === exp, `win32 isInside(${fp})須為${exp}`)
        }
        let p = path.posix
        for (let [fp, exp] of [['/a/out/x', true], ['/a/out/..x', true], ['/a/out', false], ['/a', false], ['/a/out-evil/x', false], ['/a/out/../x', false], ['/etc/x', false]]) {
            assert.ok(isInside('/a/out', fp, p) === exp, `posix isInside(${fp})須為${exp}`)
        }
    })

    it('splitNames: 可下載者回傳核對通過之絕對路徑, 不可存者列入invalid, 皆保留原順序', function() {
        let r = splitNames('C:\\a\\out', ['a.txt', '../x', 'nul.txt', 'b.txt', '', undefined, 'C:x'], 'win32', path.win32)
        assert.deepStrictEqual(r, {
            items: [{ name: 'a.txt', fp: 'C:\\a\\out\\a.txt' }, { name: 'b.txt', fp: 'C:\\a\\out\\b.txt' }],
            invalid: ['../x', 'nul.txt', '', undefined, 'C:x'],
            clash: [],
        })
        let r2 = splitNames('./rel/dir', ['a'])
        assert.deepStrictEqual(r2.items, [{ name: 'a', fp: path.resolve('./rel/dir', 'a') }])
    })

    it('splitNames: 落點層擋下名稱層放行但解析到資料夾外者(以非Windows之名稱規則配Windows路徑模組)', function() {
        let r = splitNames('C:\\a\\out', ['C:..', 'D:y', 'C:.', 'ok'], 'linux', path.win32) //解析為上層、他磁碟、資料夾本身
        assert.deepStrictEqual(r.items.map((v) => v.name), ['ok'])
        assert.deepStrictEqual(r.invalid, ['C:..', 'D:y', 'C:.'])
    })

    it('規則R-SN-05: namesKeep取指向同一本機檔之本機檔名(Windows不分大小寫, 其他平台完全相同), 回傳值取自本機清單, 不取含反斜線者', function() {
        let local = ['aux.c', 'Kept.txt', 'other', 'ı', 'a\\b', 'x']
        let rejected = ['AUX.C', 'kept.TXT', 'KEPT.TXT', 'I', 'a\\b', '../x', undefined, null]
        assert.deepStrictEqual(chkServerName.namesKeep(local, rejected, 'win32'), ['aux.c', 'Kept.txt'])
        assert.deepStrictEqual(chkServerName.namesKeep(local, rejected, 'linux'), [])
        assert.deepStrictEqual(chkServerName.namesKeep(local, ['aux.c', 'Kept.txt', 'a\\b', 'x'], 'linux'), ['aux.c', 'Kept.txt', 'x'])
        assert.deepStrictEqual(chkServerName.namesKeep(local, [], 'win32'), [])
    })

    it('splitNames: Windows上僅大小寫不同之各名稱全部列入clash, 完全相同之重複與無效名稱不計; 非Windows不查', function() {
        let names = ['Data.csv', 'ok.txt', 'DATA.CSV', 'data.csv', 'dup', 'dup', 'x.', 'X', 'ᾼ.x', 'ᾳ.x', 'ı', 'i', 'ſ', 's', 'Two', 'tWo']
        let r = splitNames('C:\\a\\out', names, 'win32', path.win32)
        assert.deepStrictEqual(r.items.map((v) => v.name), ['ok.txt', 'dup', 'dup', 'X', 'ı', 'i', 'ſ', 's'])
        assert.deepStrictEqual(r.invalid, ['x.'])
        assert.deepStrictEqual(r.clash, ['Data.csv', 'DATA.CSV', 'data.csv', 'ᾼ.x', 'ᾳ.x', 'Two', 'tWo'])
        let r2 = splitNames('/a/out', names, 'linux', path.posix)
        assert.deepStrictEqual({ items: r2.items.map((v) => v.name), invalid: r2.invalid, clash: r2.clash }, { items: names, invalid: [], clash: [] })
    })

    it('fold: 以逐字元轉小寫(長度不變者)為比對鍵, 不誤併ı與i、ſ與s、µ與μ, 併ᾼ與ᾳ', function() {
        assert.ok(fold('AbC.TXT') === fold('abc.txt'), '英文字母不分大小寫')
        assert.ok(fold('ı') !== fold('i'), 'ı與i不併')
        assert.ok(fold('ſ') !== fold('s'), 'ſ與s不併')
        assert.ok(fold('µ') !== fold('μ'), 'µ與μ不併')
        assert.ok(fold('ᾼ') === fold('ᾳ'), 'ᾼ與ᾳ併(轉大寫會漏判)')
        assert.ok(fold('İ') === 'İ', '轉小寫後長度改變者保留原字元')
    })

})
