#!/bin/sh
# 全量扫描：CF 10000（API 硬上限）+ MD 18867 = 28867 条，4 路并行。
#
# 为什么 4 路：serv00 有 5 核、进程上限 20、内存 512MB，扫描是流式的（不吃内存）。
# 单路 44 小时 → 4 路约 11 小时。
#
# 为什么每个进程写自己的文件：并行进程共写一个 TSV 会交错损坏行。
# 主控（monitor.sh）负责合并 + 每 5000 条入库。
#
# 用法（在 serv00 的 ~/quest 下）：
#   sh scripts/scan-full.sh
set -e
cd "$HOME/quest" || exit 1

# CF_KEY 从 ~/.cf-key 读（不入 git，600 权限），避免密钥出现在 ps 输出里。
if [ -f "$HOME/.cf-key" ]; then
  . "$HOME/.cf-key"
fi
if [ -z "$CF_KEY" ]; then
  echo "缺少 CF_KEY：把它写进 ~/.cf-key（内容形如 export CF_KEY='...'）" >&2
  exit 1
fi
export CF_KEY

OUTDIR="$HOME/scan-full"
mkdir -p "$OUTDIR"

echo "=== 启动 4 路扫描 ==="
echo "CF  0-5000      → $OUTDIR/cf-0.tsv"
echo "CF  5000-10000  → $OUTDIR/cf-1.tsv"
echo "MD  0-9433      → $OUTDIR/mr-0.tsv"
echo "MD  9433-18867  → $OUTDIR/mr-1.tsv"

# 每路独立 nohup，SSH 断开也不影响。
SCAN_OUT="$OUTDIR/cf-0.tsv" nohup node scripts/scan-packs.mjs \
  --cf 5000 --cf-start 0 --cf-end 5000 --mr 0 \
  > "$OUTDIR/cf-0.log" 2>&1 &
echo $! > "$OUTDIR/cf-0.pid"

SCAN_OUT="$OUTDIR/cf-1.tsv" nohup node scripts/scan-packs.mjs \
  --cf 5000 --cf-start 5000 --cf-end 10000 --mr 0 \
  > "$OUTDIR/cf-1.log" 2>&1 &
echo $! > "$OUTDIR/cf-1.pid"

SCAN_OUT="$OUTDIR/mr-0.tsv" nohup node scripts/scan-packs.mjs \
  --cf 0 --mr 9433 --mr-start 0 --mr-end 9433 \
  > "$OUTDIR/mr-0.log" 2>&1 &
echo $! > "$OUTDIR/mr-0.pid"

SCAN_OUT="$OUTDIR/mr-1.tsv" nohup node scripts/scan-packs.mjs \
  --cf 0 --mr 9434 --mr-start 9433 --mr-end 18867 \
  > "$OUTDIR/mr-1.log" 2>&1 &
echo $! > "$OUTDIR/mr-1.pid"

sleep 3
echo "=== 已启动 ==="
ps -o pid,command -p $(cat "$OUTDIR"/*.pid | tr '\n' ',' | sed 's/,$//') 2>/dev/null || echo "(ps 不支持 -p 列表，用 pgrep 查看)"
