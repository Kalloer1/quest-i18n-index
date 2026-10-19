#!/bin/sh
# 全量扫描主控：等 4 路并行扫完，合并 TSV，入库。
#
# 与 scan-full.sh 配对：那边只负责「扫」，这边只负责「收 + 入库」。
# 分开的原因：扫描进程崩溃不该让已扫完的结果丢掉；
# 而合并/入库是幂等的，随时可以重跑。
#
# 关于「每 5000 条入库一次」：4 路各自增量写自己的 TSV（appendFileSync），
# 所以「已扫到」这件事**永远不丢**；本脚本额外在扫描中途每攒够 5000 条
# 就合并 + 入库一次，让仓库里能陆续看到进展（而不是 11 小时后才有第一个结果）。
#
# 用法（在 serv00 的 ~/quest 下）：
#   sh scripts/scan-monitor.sh          # 前台等待 + 合并 + 入库
#   nohup sh scripts/scan-monitor.sh > ~/scan-full/monitor.log 2>&1 &
set -u
cd "$HOME/quest" || exit 1
OUTDIR="$HOME/scan-full"
MERGED="$OUTDIR/merged.tsv"
PUSH_EVERY=${PUSH_EVERY:-5000}

# 合并 4 路 + 去重，输出到 $MERGED，回显条数
merge_all() {
  first=1
  : > "$MERGED.raw"
  for f in "$OUTDIR"/cf-0.tsv "$OUTDIR"/cf-1.tsv "$OUTDIR"/mr-0.tsv "$OUTDIR"/mr-1.tsv; do
    [ -f "$f" ] || continue
    if [ "$first" = 1 ]; then
      cat "$f" > "$MERGED.raw"
      first=0
    else
      tail -n +2 "$f" >> "$MERGED.raw"
    fi
  done
  # 去重：同一 platform|slug 只留第一条（区间边界可能重叠）
  awk -F'\t' 'NR==1{print; next} !seen[$1"|"$3]++' "$MERGED.raw" > "$MERGED"
  rm -f "$MERGED.raw"
  echo $(( $(wc -l < "$MERGED") - 1 ))
}

# 入库：拷进仓库、修补内嵌 newEn、重建索引、commit+push
commit_all() {
  n=$1
  cp "$MERGED" research/scan-full.tsv
  node scripts/repair-scan-tsv.mjs --file research/scan-full.tsv > /dev/null 2>&1 || true
  node scripts/build-index.mjs research/scan-full.tsv > /dev/null 2>&1 || echo "（重建索引失败，TSV 已入库）"
  git add -A
  git commit -q -m "data(scan): 全量扫描进度 $n 条（CF+MD，serv00 4 路）" || return 0
  git push -q origin main || echo "（push 失败，下次一并提交）"
  echo "  已入库 $n 条 $(date +%H:%M)"
}

echo "=== 主控启动 $(date) ==="
last_push=0

# 扫描期间：每攒够 PUSH_EVERY 条就入库一次
while pgrep -f "scripts/scan-packs.mjs" > /dev/null 2>&1; do
  sleep 120
  cur=$(merge_all)
  echo "  $(date +%H:%M) 累计 $cur 条"
  if [ "$cur" -ge $((last_push + PUSH_EVERY)) ]; then
    commit_all "$cur"
    last_push=$cur
  fi
done

echo "=== 4 路全部退出 $(date) ==="
final=$(merge_all)
echo "最终合并去重后 $final 条"
commit_all "$final"
echo "=== 全量入库完成 $(date) ==="
