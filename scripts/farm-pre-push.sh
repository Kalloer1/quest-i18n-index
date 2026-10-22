#!/bin/sh
# farm 主机的 pre-push 钩子：只允许推 refs/heads/farm/*。
#
# 装法（主机上执行一次）：
#   cp scripts/farm-pre-push.sh ~/quest-repo/.git/hooks/pre-push
#   chmod +x ~/quest-repo/.git/hooks/pre-push
#
# 为什么用钩子而不是「脚本纪律」：
#   translate-local.mjs 里写死 `HEAD:refs/heads/farm/<host>` 只是**代码约定**，
#   任何人 `git push origin main`、改一行参数、跑一个临时脚本都能绕过它。
#   钩子跑在 git 自己身上，是仓库层的硬约束 —— 误推 main 从「事故」变成「不可能」。
#   三台主机共享 main 的写权限时，这条边界的价值远大于多装一个文件。
#
# 用 sh 不用 bash：FreeBSD base 系统没有 bash（装了也是 /usr/local/bin/bash，
# 钩子的 shebang 指向它会在纯净机器上直接 ENOENT）。
#
# stdin 每行：<local_ref> <local_sha> <remote_ref> <remote_sha>
# 一次 push 可能带多行（--all / 多 refspec），所以逐行检查、全部通过才放行。
set -u

status=0

while read -r local_ref local_sha remote_ref remote_sha; do
  # 空行/结尾：git 不会给空行，这里只是防御。
  [ -z "${remote_ref:-}" ] && continue
  case "$remote_ref" in
    refs/heads/farm/*)
      : # 自己的分支，放行
      ;;
    *)
      echo "pre-push 拒绝：目标 $remote_ref 不是 refs/heads/farm/*" >&2
      echo "  本地 ref  $local_ref ($local_sha)" >&2
      echo "  本机只准推自己的 farm 分支，main 由 CI 的 farm-merge 统一合并。" >&2
      status=1
      ;;
  esac
done

exit $status
