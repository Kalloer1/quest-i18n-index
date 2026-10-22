#!/bin/sh
# farm 主机上的启动器 / 守护：单实例 + 停止文件 + 有限重启。
#
# 装法（主机上）：
#   sh scripts/farm-run.sh            # 前台跑到退出
#   或放进 crontab：@reboot /bin/sh ~/quest-repo/scripts/farm-run.sh >> ~/farm-launcher.log 2>&1
#
# 用法：
#   HOST=gfdrgfd sh scripts/farm-run.sh
#   要停机就 `touch ~/quest-repo/.farm-stop`（进程自然结束，或下一轮不再重启）。
#
# 为什么不上 systemd：serv00 的 FreeBSD 没有 systemd；正经做法是写 /etc/rc.d 脚本，
# 但那要 root、要按机器改，三台免费主机上没必要 —— 一个 mkdir 锁 + cron @reboot 已经
# 覆盖了「开机自启」和「不重复跑」这两件真正需要的事。
#
# 为什么不用 pkill -f 做单实例：
#   `pkill -f translate-local` 会匹配到**任何**命令行里含这个串的进程 —— 包括这条
#   wrapper 自己、ssh 过来的 shell、tail 日志的窗口。踩过一次就是「启动脚本把自己杀了」。
#   mkdir 是原子操作（EEXIST 即已存在），锁目录里再放 pid 方便人工排查。
set -u

REPO_DIR=${REPO_DIR:-$HOME/quest-repo}
HOST=${HOST:-$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]')}
LOCK_DIR=${LOCK_DIR:-$HOME/.quest-farm.lock}
SLUG_FILE=${SLUG_FILE:-$REPO_DIR/research/shards/$HOST.txt}
LOG=${LOG:-$HOME/farm-run.log}
STOP_FILE=${STOP_FILE:-$REPO_DIR/.farm-stop}
LANES=${LANES:-8}
PUSH_EVERY=${PUSH_EVERY:-20}
PUSH_MINUTES=${PUSH_MINUTES:-20}
MAX_RESTARTS=${MAX_RESTARTS:-5}
BACKOFF=${BACKOFF:-60}

cd "$REPO_DIR" || { echo "找不到仓库目录 $REPO_DIR" >&2; exit 1; }

# ---- 单实例：mkdir 原子锁 ----
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "已有实例在跑（锁目录 $LOCK_DIR，pid $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'))——本次不启动" >&2
  exit 0
fi
echo $$ > "$LOCK_DIR/pid" 2>/dev/null

# 锁一定要在退出时释放，否则下一次 @reboot 也被自己挡住（更要紧的是别挡住人工启动）。
# 信号单独处理并显式 exit：只 rm 不退出的话，HUP 处理完脚本会从原处继续跑，
# 锁已经没了 —— 等于门户大开，第二个实例照样能起来。
release_lock() { rm -rf "$LOCK_DIR"; }
trap 'release_lock' EXIT
trap 'release_lock; exit 130' HUP INT TERM

# ---- 停止文件 ----
if [ -f "$STOP_FILE" ]; then
  echo "发现 $STOP_FILE（维护开关），本次不启动。删掉它再跑。" >&2
  exit 0
fi

if [ ! -f "$SLUG_FILE" ]; then
  echo "找不到本机分片清单 $SLUG_FILE" >&2
  echo "先从监工机同步 research/shards/ 下对应文件（git pull 就够了，它在仓库里）。" >&2
  exit 1
fi

restarts=0

# ---- 每轮开跑前把「代码」刷新到 main，但**不碰产物路径** ----
# 为什么必须刷新：farm 分支是从某一刻的 main 切出来的，之后 main 上的脚本修复
# 永远不会自动流到这台机器 —— 2026-10-23 就踩到过：合并 workflow 的变量名修复
# 只在 main 上，主机分支里还是旧版，push 触发的那次 run 直接用旧 workflow 报错。
# 为什么只 checkout 代码路径：main 上还堆着别台已经合进来的 patches 与 tar.gz，
# 整棵树拉下来会白占几百 MB（配额 3GB），而本机只需要自己的分片。
refresh_code() {
  if git fetch -q --depth=1 origin main 2>/dev/null; then
    # restore 只改工作区、不动索引：这样后面 commitAndPush 的 `git add patches/...`
    # 不会顺手把脚本改动卷进 farm 分支的提交里。
    git restore --source=origin/main --worktree -- scripts shared package.json .github 2>/dev/null \
      || git checkout origin/main -- scripts shared package.json .github 2>/dev/null \
      || true
    echo "$(date '+%Y-%m-%d %H:%M:%S') 代码刷新到 $(git rev-parse --short origin/main)" >> "$LOG"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') 刷新代码失败（fetch main），沿用本地版本继续" >> "$LOG"
  fi
}

while :; do
  if [ -f "$STOP_FILE" ]; then
    echo "发现 $STOP_FILE，停止重启" >&2
    break
  fi

  refresh_code

  # nohup + & 再 wait：让 node 脱离当前会话（ssh 断开不跟着死），同时保留退出码。
  nohup node scripts/translate-local.mjs \
    --farm \
    --branch "farm/$HOST" \
    --slug-file "$SLUG_FILE" \
    --lanes "$LANES" \
    --push-every "$PUSH_EVERY" \
    --push-minutes "$PUSH_MINUTES" \
    >> "$LOG" 2>&1 &
  pid=$!
  echo "$(date '+%Y-%m-%d %H:%M:%S') 启动 pid=$pid host=$HOST 日志=$LOG" >> "$LOG"
  wait "$pid"
  rc=$?

  case "$rc" in
    0)
      echo "正常结束（rc=0），不再重启" >> "$LOG"
      break
      ;;
    3|4)
      # 3 = 推送失败，4 = 磁盘不足。这两种都必须有人看一眼：
      # 自动重启只会把同一个错误刷满日志，还占着磁盘继续攒产物。
      echo "退出码 $rc（3=推送失败 / 4=磁盘不足），需人工处理后重跑，本脚本不再拉起" >> "$LOG"
      break
      ;;
    *)
      restarts=$((restarts + 1))
      if [ "$restarts" -gt "$MAX_RESTARTS" ]; then
        echo "已重启 $MAX_RESTARTS 次仍异常退出（最后 rc=$rc），放弃。看 $LOG" >> "$LOG"
        break
      fi
      echo "异常退出 rc=$rc，${BACKOFF}s 后第 $restarts/$MAX_RESTARTS 次重启" >> "$LOG"
      sleep "$BACKOFF"
      ;;
  esac
done
