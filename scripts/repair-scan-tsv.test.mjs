import test from 'node:test'
import assert from 'node:assert/strict'
import { repairScanTsv } from './repair-scan-tsv.mjs'

const HEADER = 'platform\tid\tslug\tbytes\tformat\tnewEn\tnewZh\toldCh\tcdKB\tscannedAt'
const tsv = (...rows) => [HEADER, ...rows].join('\n')

const row = (slug, format, newEn, oldCh) =>
  `cf\t1\t${slug}\t100\t${format}\t${newEn}\t0\t${oldCh}\t5\t2026-10-19`

test('repairScanTsv：内嵌包 newEn 从 oldCh 补齐', () => {
  const { text, repaired } = repairScanTsv(tsv(
    row('a', 'embedded', 0, 31),
    row('b', 'embedded', 0, 28),
  ))
  assert.equal(repaired, 2)
  const lines = text.split('\n')
  assert.match(lines[1], /\tembedded\t31\t0\t31\t/)   // newEn 31, oldCh 31
  assert.match(lines[2], /\tembedded\t28\t0\t28\t/)
})

test('repairScanTsv：非内嵌布局不动', () => {
  const { text, repaired } = repairScanTsv(tsv(
    row('a', 'separate-dir', 73, 67),
    row('b', 'none', 0, 0),
  ))
  assert.equal(repaired, 0)
  assert.equal(text, tsv(row('a', 'separate-dir', 73, 67), row('b', 'none', 0, 0)))
})

test('repairScanTsv：幂等——已修过的行不再改', () => {
  const once = repairScanTsv(tsv(row('a', 'embedded', 0, 31))).text
  const twice = repairScanTsv(once)
  assert.equal(twice.repaired, 0)
  assert.equal(twice.text, once)
})

test('repairScanTsv：oldCh 非正整数时跳过，不猜', () => {
  const { repaired, skipped } = repairScanTsv(tsv(
    row('a', 'embedded', 0, 0),
    row('b', 'embedded', 0, 'abc'),
  ))
  assert.equal(repaired, 0)
  assert.equal(skipped, 2)
})

test('repairScanTsv：缺列明确报错', () => {
  assert.throws(() => repairScanTsv('platform\tslug\ncf\ta'), /缺列/)
})
