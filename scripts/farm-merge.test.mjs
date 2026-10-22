#!/usr/bin/env node
/**
 * 让 `npm test`（glob 是 scripts/*.test.mjs）也能跑到 scripts/lib/ 下的 farm-merge 单测。
 * 真正的断言在 scripts/lib/farm-merge.test.mjs，这里只做一次 re-export（导入即注册测试）。
 * 不要在这里写断言：两处都写会导致同一批用例跑两遍。
 */
import './lib/farm-merge.test.mjs'
