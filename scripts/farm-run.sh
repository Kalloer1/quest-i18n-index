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
# 每批交给 translate-local 的包数上限（0 = 不限）。
# 为什么必须有：`refresh_code` 只在**两批之间**生效，一个进程跑 100~198 包要几小时，
# 期间 main 上的脚本更新永远进不来 —— 2026-10-23 的版本溯源特性 09:24 上线，
# 08:11 之前起的进程全程用旧代码，一次都没写出 `.source.json`。
# 25 包 ≈ 十几分钟一批：用「频繁短暂停」换「代码最长滞后一批」。
FARM_BATCH_LIMIT=${FARM_BATCH_LIMIT:-25}
# 连续多少批「已完成」数不涨就停机等人工（见主循环里的自旋防护）。
STAGNANT_LIMIT=${STAGNANT_LIMIT:-3}

cd "$REPO_DIR" || { echo "找不到仓库目录 $REPO_DIR" >&2; exit 1; }

# ---- CurseForge / Modrinth 下载凭据 ----
# 必须在这里 export：translate-local 的下载步骤要 CF_KEY，缺了会让**每一个包**
# 都在 prepare-pack 阶段失败，而失败又被记成 per-pack failed、循环一路往下跑 ——
# 2026-10-23 实测：25 秒内烧掉了 145 个条目全部变成 FAILED，看起来像「跑得飞快」。
if [ -z "${CF_KEY:-}" ]; then
  if [ -f "$HOME/.cf-key" ]; then
    CF_KEY=$(cat "$HOME/.cf-key")
    export CF_KEY
  else
    echo "缺少 CF_KEY（$HOME/.cf-key 不存在），拒绝空跑：所有下载都会失败" >&2
    exit 1
  fi
fi

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
# 分批循环的进度指针：上一批「已完成 N 个」与连续未增长批次计数。
done_prev=
stagnant=0

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

# ---- 主循环：分批跑，每批之间刷新代码 ----
# 循环语义（rc=0 不再等于「不再重启」）：
#   1) 每批传入 `--limit $FARM_BATCH_LIMIT`，进程跑完这一批就正常退出；
#   2) rc=0 且本批日志最后一条是「本次处理 0 个」→ 真的做完了，break；
#   3) rc=0 但还有待处理 → 回到循环顶部：查停止文件 → refresh_code → 下一批。
# 判定「待处理 0」只能看**本次进程刚写的行**：上一轮的「本次处理 0 个」还躺在日志里，
# 直接 tail 全文会把它当成本批的结果，于是第一批就跑完就误判「全部完成」而停机。
while :; do
  if [ -f "$STOP_FILE" ]; then
    echo "发现 $STOP_FILE，停止重启" >&2
    break
  fi

  refresh_code

  # 本批的日志起点（行号）。下面只用「起点之后」的行判断本批进度。
  log_start=$(wc -l < "$LOG" 2>/dev/null | tr -d ' \t')
  [ -n "$log_start" ] || log_start=0

  # nohup + & 再 wait：让 node 脱离当前会话（ssh 断开不跟着死），同时保留退出码。
  nohup node scripts/translate-local.mjs \
    --farm \
    --branch "farm/$HOST" \
    --slug-file "$SLUG_FILE" \
    --lanes "$LANES" \
    --limit "$FARM_BATCH_LIMIT" \
    --push-every "$PUSH_EVERY" \
    --push-minutes "$PUSH_MINUTES" \
    >> "$LOG" 2>&1 &
  pid=$!
  echo "$(date '+%Y-%m-%d %H:%M:%S') 启动 pid=$pid host=$HOST batch-limit=$FARM_BATCH_LIMIT 日志=$LOG" >> "$LOG"
  wait "$pid"
  rc=$?

  # 本批最后一条进度行（translate-local 启动时打「…本次处理 K 个…」）。
  # 只在本批新增区间里找，避免把上一轮的残留行当成这一轮的结果。
  batch_tail=$(tail -n "+$((log_start + 1))" "$LOG" 2>/dev/null | grep '本次处理' | tail -n 1)
  drained=0
  case "$batch_tail" in
    *"本次处理 0 个"*) drained=1 ;;
  esac

  case "$rc" in
    0)
      if [ "$drained" -eq 1 ]; then
        echo "本批 rc=0 且待处理 0 个（分片清单已清空），全部完成，退出" >> "$LOG"
        break
      fi
      # 本批跑完但还有活：刷新代码后继续 —— rc=0 是「该换新代码了」，不是「收工」。
      #
      # 自旋防护：待处理队列里「失败但未 done」的包不会被移出（`pendingWorklist` 只看 done），
      # 若队头这批每次都失败，就会以「30s 一批」的速度无限重试同一批，空烧 API 与日志。
      # 用启动行里的「已完成 N 个」当进度指针：连续几批都不涨就停下来等人看。
      done_now=$(printf '%s\n' "$batch_tail" | sed -n 's/.*已完成 \([0-9][0-9]*\) 个.*/\1/p')
      if [ -n "$done_now" ] && [ "$done_now" = "${done_prev:-}" ]; then
        stagnant=$((stagnant + 1))
      else
        stagnant=0
      fi
      if [ -n "$done_now" ]; then done_prev=$done_now; fi
      if [ "$stagnant" -ge "$STAGNANT_LIMIT" ]; then
        echo "连续 $STAGNANT_LIMIT 批「已完成」数没涨（最后已完成=$done_now），停下来人工排查。看 $LOG" >> "$LOG"
        break
      fi
      echo "本批跑完（rc=0，limit=$FARM_BATCH_LIMIT，已完成=$done_now），刷新代码后继续下一批" >> "$LOG"
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
