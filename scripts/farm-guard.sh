#!/bin/sh
# 主机侧常驻守卫：每 5 分钟看一眼 translate-local 还在不在，不在就拉起来。
#
# 为什么不用外部定时任务：2026-10-23 那次停摆 4 小时，靠的是远端脚本 + 人肉巡检；
# 而「外部每 10 分钟跑一次」受调度器首次触发时间影响（实测第一次排到了 1 小时后）。
# 这个守卫跑在主机自己身上，主机活着它就在，不依赖任何外部调度。
#
# 为什么不用 cron：instabox 镜像里没有 cron 守护进程。
set -u

HOST=${HOST:-$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]')}
REPO=${REPO_DIR:-$HOME/quest-repo}
LOCK=${LOCK_DIR:-$HOME/.quest-farm.lock}
PIDFILE=$HOME/.farm-guard.pid
INTERVAL=${GUARD_INTERVAL:-300}

echo $$ > "$PIDFILE"
echo "[guard] $(date -u +%FT%TZ) 启动 host=$HOST interval=${INTERVAL}s"

while true; do
  sleep "$INTERVAL"
  # 已经有人在翻就别插手（farm-run.sh 自己有重启逻辑）
  if pgrep -f 'translate-local[.]mjs' >/dev/null 2>&1; then
    continue
  fi
  # 脚本被换成 CRLF 时，farm-run.sh 会在第 20 行就退出 —— 先修再启，否则白启。
  if grep -q "$(printf '\r')" "$HOME/farm-run.sh" 2>/dev/null; then
    echo "[guard] $(date -u +%FT%TZ) 检测到 CRLF，从 git 恢复"
    ( cd "$REPO" && git checkout -q origin/main -- scripts/farm-run.sh \
      && tr -d '\r' < scripts/farm-run.sh > "$HOME/farm-run.sh" ) || echo "[guard] 恢复失败"
  fi
  echo "[guard] $(date -u +%FT%TZ) 进程不在，重启 farm-run"
  rm -rf "$LOCK"
  ( cd "$REPO" && HOST="$HOST" sh "$HOME/farm-run.sh" >> "$HOME/farm-launcher.log" 2>&1 )
done
