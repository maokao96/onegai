// onegai — template.html の検証
//   node test/run.mjs
// playwright が要る（`npm i -D playwright && npx playwright install` か、グローバル導入）。
// WebKit（iPhone の Safari と同じエンジン）と Chromium の両方で走る。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = fs.readFileSync(path.join(HERE, '..', 'template.html'), 'utf8')

async function loadPW () {
  try { return await import('playwright') } catch {}
  const root = execSync('npm root -g').toString().trim()
  return await import(pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href)
}

// ---- 小さな検証ハーネス ----
let pass = 0, fail = 0
const fails = []
function ok (name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`) }
}
function group (n) { console.log(`\n\x1b[1m${n}\x1b[0m`) }

// ---- 雛形の DATA を差し替えたページを作る ----
function withData (data) {
  // インラインの <script> の中に生の </script> は置けない。雛形の決まりと同じく退避する
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  const body = TEMPLATE.replace(
    /const DATA = \{[\s\S]*?\n\};/,
    () => 'const DATA = ' + json + ';'
  )
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    body + '</head></html>'
}
function sampleData () {
  const m = TEMPLATE.match(/const DATA = (\{[\s\S]*?\n\});/)
  if (!m) throw new Error('雛形から DATA を取り出せない')
  return new Function('return ' + m[1])()
}

// ---- localhost で配る（localStorage と secure context のため）----
const pages = new Map()
const server = http.createServer((req, res) => {
  const key = req.url.split('?')[0]
  if (!pages.has(key)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(pages.get(key))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
function serve (name, data) { pages.set('/' + name, withData(data)); return `${BASE}/${name}` }

// クリップボードはブラウザの許可に左右されるので、書き込み先を差し替えて経路を検証する
const CLIP_STUB = `
window.__copied = null;
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: t => { window.__copied = t; return Promise.resolve() } }
});`

const { chromium, webkit, devices } = await loadPW()

/* =======================================================================
   0. 雛形をそのまま開く（DATA を差し替えない経路）
   ======================================================================= */
{
  group('0. 雛形をそのまま開く（Chromium）')
  const opens = (TEMPLATE.match(/<script[\s>]/g) || []).length
  const closes = (TEMPLATE.match(/<\/script>/g) || []).length
  ok(`script タグの開閉が合っている（開 ${opens} / 閉 ${closes}）`, opens === closes,
    '本文やコメントに生の閉じタグが混ざるとページが途中で切れる')

  const browser = await chromium.launch()
  const page = await browser.newPage()
  pages.set('/raw.html', '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' + TEMPLATE + '</head></html>')
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(`${BASE}/raw.html`)
  const data = sampleData()
  ok('雛形の例がそのまま描画される', await page.locator('.card').count() === data.steps.length, errs.join(' / '))
  ok('雛形の例の判断も描画される', await page.locator('.ch').count() === data.choices.items.length)
  ok('DATA の中身が画面に漏れていない',
    !(await page.evaluate(() => document.body.innerText)).includes('id:'),
    (await page.evaluate(() => document.body.innerText)).slice(0, 120))
  ok('雛形を開いてもエラーが出ない', errs.length === 0, errs.join(' / '))
  await browser.close()
}

/* =======================================================================
   A. 本文の記法とエスケープ
   ======================================================================= */
{
  group('A. 本文の記法とエスケープ（Chromium）')
  const browser = await chromium.launch()
  const page = await browser.newPage()

  const url = serve('parse.html', {
    title: '記法の確認',
    unblocks: 'ここが通れば表示は信用できます',
    steps: [
      { id: 'a1', label: '太字', body: '押すのは **『追加』** です' },
      { id: 'a2', label: '改行', body: '一行目\n二行目\n三行目' },
      { id: 'a3', label: '番号', body: 'こうします\n1. ひとつ\n2. ふたつ\n3. みっつ' },
      { id: 'a4', label: '箇条', body: '注意です\n・ひとつ目\n・ふたつ目' },
      { id: 'a5', label: '保険', body: '『ネームサーバーの設定』を開きます' },
      { id: 'a6', label: 'XSS本文', body: '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">危険' },
      { id: 'a7', label: 'XSSラベル', body: 'ふつうの本文' , copy: '<b>これはタグではない</b>' },
      { id: 'a8', label: '計測タグを貼る', body: '**『貼り付け』** を押す',
        copy: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>' }
    ]
  })
  await page.goto(url)

  ok('**…** が <b> になる',
    await page.locator('#c-a1 .body b').textContent() === '『追加』')
  ok('改行が段落に割れる',
    await page.locator('#c-a2 .body p').count() === 3)
  ok('行頭の 1. が番号付きリストになる',
    await page.locator('#c-a3 .body ol li').count() === 3)
  ok('番号の前の行は段落のまま',
    await page.locator('#c-a3 .body p').count() === 1)
  ok('行頭の ・ が箇条書きになる',
    await page.locator('#c-a4 .body ul li').count() === 2)
  ok('** が無い手順は 『…』 を自動で太字にする',
    await page.locator('#c-a5 .body b').textContent() === '『ネームサーバーの設定』')

  const pwned = await page.evaluate(() => window.__pwned)
  ok('body の <script> が実行されない', pwned === undefined, `__pwned=${pwned}`)
  ok('body の <img onerror> が要素にならない',
    await page.locator('#c-a6 img').count() === 0)
  ok('body のタグは文字として出る',
    (await page.locator('#c-a6 .body').textContent()).includes('<script>'))
  ok('copy のタグも文字として出る',
    (await page.locator('#c-a7 .copy-t').textContent()) === '<b>これはタグではない</b>')
  ok('copy に計測タグを丸ごと入れても壊れない',
    (await page.locator('#c-a8 .copy-t').textContent()).endsWith('</script>'))
  ok('計測タグが実行されない（copy 欄は文字のまま）',
    await page.locator('#c-a8 script').count() === 0)
  ok('雛形は innerHTML を使っていない',
    !/\.innerHTML\s*=/.test(TEMPLATE))

  await browser.close()
}

/* =======================================================================
   B. 保存（タップした時点で残る）
   ======================================================================= */
{
  group('B. 保存 — タップした時点で残る（WebKit / iPhone 13）')
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()

  const data = {
    title: '保存の確認',
    unblocks: '閉じても消えないこと',
    steps: [
      { id: 's1', label: 'ひとつ目', body: '**押す**' },
      { id: 's2', label: 'ふたつ目', body: '**押す**' },
      { id: 's3', label: 'みっつ目', body: '**押す**' }
    ],
    choices: { heading: '判断', items: [
      { id: 'p1', label: '残すもの', meta: 'メタ', why: '理由' },
      { id: 'p2', label: '落とすもの', meta: 'メタ', why: '理由' }
    ] }
  }
  const url = serve('save.html', data)
  const other = serve('other.html', { title: '別の用件', unblocks: 'x', steps: [{ id: 's1', label: 'べつ', body: '**べつ**' }] })

  await page.goto(url)
  await page.locator('#c-s1 .mk.ok').click()
  await page.locator('#c-s2 .mk.ng').click()
  await page.locator('#h-p2 .tg').click()

  await page.reload()
  ok('リロードしても「できた」が残る',
    await page.locator('#c-s1').getAttribute('class') === 'card done')
  ok('リロードしても「つまずいた」が残る',
    (await page.locator('#c-s2').getAttribute('class')).includes('stuck'))
  ok('リロードしても判断の ✕ が残る',
    (await page.locator('#h-p2').getAttribute('class')).includes('off'))
  ok('触っていない手順は白紙のまま',
    await page.locator('#c-s3').getAttribute('class') === 'card')

  // リンク先を見て戻る動き
  await page.goto(other)
  ok('別の用件のページに前のチェックが漏れない',
    await page.locator('#c-s1').getAttribute('class') === 'card')
  await page.goBack()
  ok('リンク先から戻ってもチェックが残る',
    await page.locator('#c-s1').getAttribute('class') === 'card done')

  // 別ブラウザ（新しいコンテキスト）＝別端末に相当
  const ctx2 = await browser.newContext({ ...devices['iPhone 13'] })
  const p2 = await ctx2.newPage()
  await p2.goto(url)
  ok('別の端末には持ち越されない（保存は端末の中だけ）',
    await p2.locator('#c-s1').getAttribute('class') === 'card')
  await ctx2.close()

  // localStorage が使えない環境でも落ちない
  const ctx3 = await browser.newContext({ ...devices['iPhone 13'] })
  await ctx3.addInitScript(`Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})`)
  const p3 = await ctx3.newPage()
  const errs = []
  p3.on('pageerror', e => errs.push(e.message))
  await p3.goto(url)
  await p3.locator('#c-s1 .mk.ok').click()
  ok('localStorage が塞がれていてもページは動く',
    errs.length === 0 && await p3.locator('#c-s1').getAttribute('class') === 'card done',
    errs.join(' / '))
  await ctx3.close()

  await browser.close()
}

/* =======================================================================
   C. 3状態と D. 結果の文字列
   ======================================================================= */
{
  group('C/D. できた・つまずいた・結果の文字列（Chromium）')
  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  await ctx.addInitScript(CLIP_STUB)
  const page = await ctx.newPage()

  const url = serve('result.html', {
    title: '結果の確認',
    unblocks: 'x',
    steps: [
      { id: 's1', label: '短いラベル', body: '**a**' },
      { id: 's2', label: 'これはとても長いラベルで二十四文字を超えるように書いてあります', body: '**b**' },
      { id: 's3', label: 'みっつ目', body: '**c**' },
      { id: 's4', label: 'よっつ目', body: '**d**' }
    ],
    choices: { heading: 'やること', items: [
      { id: 'p1', label: '残す', why: 'r' },
      { id: 'p2', label: '外す', why: 'r' }
    ] }
  })
  await page.goto(url)

  ok('初期の進捗は 0 / 4', await page.locator('#prog').textContent() === '0 / 4')

  await page.locator('#c-s1 .mk.ok').click()
  ok('できた → done', (await page.locator('#c-s1').getAttribute('class')).includes('done'))
  await page.locator('#c-s1 .mk.ng').click()
  ok('できた の上から つまずいた で入れ替わる',
    (await page.locator('#c-s1').getAttribute('class')).includes('stuck') &&
    !(await page.locator('#c-s1').getAttribute('class')).includes('done'))
  await page.locator('#c-s1 .mk.ng').click()
  ok('同じボタンをもう一度押すと白紙に戻る',
    await page.locator('#c-s1').getAttribute('class') === 'card')

  await page.locator('#c-s1 .mk.ok').click()
  await page.locator('#c-s2 .mk.ok').click()
  await page.locator('#c-s3 .mk.ng').click()
  await page.locator('#h-p2 .tg').click()
  ok('進捗が 2 / 4・詰まり1 になる',
    await page.locator('#prog').textContent() === '2 / 4・詰まり1',
    await page.locator('#prog').textContent())
  ok('詰まりがあるとボタンが「詰まりを知らせる」になる',
    await page.locator('#copy').textContent() === '詰まりを知らせる')

  await page.locator('#copy').click()
  const copied = await page.evaluate(() => window.__copied)
  const lines = copied.split('\n')
  ok('1行目が [onegai] タイトル', lines[0] === '[onegai] 結果の確認', lines[0])
  ok('できた行が id + ラベル', lines[1] === 'できた: s1 短いラベル / s2 これはとても長いラベルで二十四文字を超えるように…', lines[1])
  ok('ラベルは24字で切られる', /超えるように…$/.test(lines[1]) && !lines[1].includes('書いてあります'))
  ok('つまずいた行が出る', lines[2] === 'つまずいた: s3 みっつ目', lines[2])
  ok('まだ行が出る', lines[3] === 'まだ: s4 よっつ目', lines[3])
  ok('外した行が出る', lines[4] === '外した: p2 外す', lines[4])

  await page.locator('#c-s3 .mk.ok').click()
  await page.locator('#c-s4 .mk.ok').click()
  ok('全部できたら進捗が 4 / 4', await page.locator('#prog').textContent() === '4 / 4')
  ok('全部できたらボタンが「全部できました。コピー」',
    await page.locator('#copy').textContent() === '全部できました。コピー')
  await page.locator('#copy').click()
  const done2 = await page.evaluate(() => window.__copied)
  ok('全部できたら「まだ」行が出ない', !done2.includes('まだ:'), done2)

  // クリップボードが塞がれたときの逃げ道
  const ctx2 = await browser.newContext()
  await ctx2.addInitScript(`
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('no'))}});
    document.execCommand = () => false;`)
  const p2 = await ctx2.newPage()
  await p2.goto(url)
  await p2.locator('#copy').click()
  await p2.waitForSelector('#fb', { state: 'visible' })
  ok('コピーが効かない環境では選択用の欄が出る',
    (await p2.locator('#fbt').inputValue()).startsWith('[onegai] 結果の確認'))
  await ctx2.close()

  await browser.close()
}

/* =======================================================================
   E. スマホでの当たり判定とレイアウト
   ======================================================================= */
{
  group('E. スマホ — 当たり判定とレイアウト（WebKit / iPhone SE と 13）')
  const browser = await webkit.launch()
  const data = sampleData()

  for (const dev of ['iPhone SE', 'iPhone 13']) {
    const ctx = await browser.newContext({ ...devices[dev] })
    const page = await ctx.newPage()
    await page.goto(serve('sample.html', data))

    const small = await page.evaluate(() => {
      const sel = 'a.go, button.cp, button.mk, .ch .tg, #copy'
      return [...document.querySelectorAll(sel)]
        .map(el => { const r = el.getBoundingClientRect(); return { t: el.textContent.trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) } })
        .filter(x => x.w < 44 || x.h < 44)
    })
    ok(`${dev}: タップ対象がすべて 44px 以上`, small.length === 0, JSON.stringify(small))

    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    ok(`${dev}: 横スクロールが出ない`, over <= 0, `はみ出し ${over}px`)

    const hidden = await page.evaluate(() => {
      const bar = document.querySelector('.bar').getBoundingClientRect().height
      const last = document.querySelector('main').getBoundingClientRect().bottom + window.scrollY
      const docH = document.documentElement.scrollHeight
      return docH - last >= bar
    })
    ok(`${dev}: 下部バーが本文の末尾を隠さない`, hidden)

    await ctx.close()
  }
  await browser.close()
}

/* =======================================================================
   F. 明暗どちらでも読めるか
   ======================================================================= */
{
  group('F. 明暗のコントラスト（Chromium）')
  const browser = await chromium.launch()
  const data = sampleData()

  const lum = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  const rel = ([r, g, b]) => 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b)
  const ratio = (a, b) => { const [x, y] = [rel(a), rel(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const rgb = s => s.match(/\d+/g).slice(0, 3).map(Number)

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ colorScheme: scheme })
    const page = await ctx.newPage()
    await page.goto(serve('sample.html', data))

    const probes = await page.evaluate(() => {
      const at = (sel, bgSel) => {
        const el = document.querySelector(sel); if (!el) return null
        const bg = document.querySelector(bgSel)
        return { fg: getComputedStyle(el).color, bg: getComputedStyle(bg).backgroundColor }
      }
      return {
        '本文': at('.card .body p', '.card'),
        '手順の見出し': at('.card .label', '.card'),
        '補足（判断の理由）': at('.ch .cw', '.ch'),
        '進捗の数字': at('#prog', '.bar'),
        '前置き': at('.howto', 'body'),
        'リンクのボタン': (() => { const a = document.querySelector('a.go'); const s = getComputedStyle(a); return { fg: s.color, bg: s.backgroundColor } })(),
        '判断のボタン': (() => { const a = document.querySelector('.ch .tg'); const s = getComputedStyle(a); return { fg: s.color, bg: s.backgroundColor } })()
      }
    })
    for (const [name, p] of Object.entries(probes)) {
      const r = ratio(rgb(p.fg), rgb(p.bg))
      ok(`${scheme}: ${name} のコントラスト ${r.toFixed(2)} ≥ 4.5`, r >= 4.5, `${p.fg} / ${p.bg}`)
    }
    await ctx.close()
  }

  // 端末が暗くても、明るい指定が入っていれば明るく出る
  const ctx = await browser.newContext({ colorScheme: 'dark' })
  const page = await ctx.newPage()
  await page.goto(serve('sample.html', data))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ok('data-theme="light" が暗い端末でも効く', bg === 'rgb(247, 247, 245)', bg)
  await ctx.close()

  await browser.close()
}

/* =======================================================================
   G. 同梱の書き方の例が、自分のルールを守っているか
   ======================================================================= */
{
  group('G. 同梱の例が SKILL.md のルールを守っているか')
  const data = sampleData()
  const strip = s => s.replace(/\*\*/g, '')

  const titleTag = TEMPLATE.match(/<title>(.*?)<\/title>/)[1]
  ok('<title> と DATA.title が揃っている', titleTag === data.title, `${titleTag} / ${data.title}`)
  ok('unblocks が一行', !data.unblocks.includes('\n') && data.unblocks.length <= 60)

  for (const s of data.steps) {
    const lines = s.body.split('\n').filter(l => l.trim())
    const longest = Math.max(...lines.map(l => strip(l).length))
    ok(`${s.id}: 太字がある（拾い読みできる）`, /\*\*.+?\*\*/.test(s.body))
    const chars = strip(s.body).replace(/\n/g, '').length
    ok(`${s.id}: 1手順 200字以内（${chars}字）`, chars <= 200)
    ok(`${s.id}: 1行 40字以内（最長 ${longest}字）`, longest <= 40)
  }
  const ids = data.steps.map(s => s.id).concat((data.choices?.items || []).map(c => c.id))
  ok('id が重複していない', new Set(ids).size === ids.length)
  const inputs = TEMPLATE.match(/<input/gi) || []
  const tas = TEMPLATE.match(/<textarea[^>]*>/gi) || []
  ok('鍵を書ける入力欄が無い（結果を取り出す読み取り専用の欄だけ）',
    inputs.length === 0 && tas.length === 1 && /readonly/.test(tas[0]),
    `input=${inputs.length} textarea=${JSON.stringify(tas)}`)

  const skill = fs.readFileSync(path.join(HERE, '..', 'SKILL.md'), 'utf8')
  for (const k of ['できた:', 'つまずいた:', 'まだ:', '外した:']) {
    ok(`SKILL.md が結果の「${k}」を説明している`, skill.includes(k))
  }
  for (const f of ['choices', 'unblocks', 'copyLabel', 'urlLabel', 'why']) {
    ok(`SKILL.md が ${f} を説明している`, skill.includes(f))
  }
}

server.close()
console.log(`\n\x1b[1m${pass} 通過 / ${fail} 失敗\x1b[0m`)
if (fail) { console.log('失敗:\n  ' + fails.join('\n  ')); process.exit(1) }
