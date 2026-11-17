#!/usr/bin/env python3
"""POSIX PTY 驱动（C3 用）：给 TUI 一个真终端，按脚本送按键，收整段输出。

## 为什么不用 node-pty

node-pty 要编原生模块，Windows/CI 两套工具链都要维护；而这件事标准库就有：
`pty.fork()` 建会话、`os.read` 收字节、`select` 等可读、`TIOCSWINSZ` 设窗口大小。
DSH 的 headless-shutdown e2e 用的同一套（Python `pty.fork()`），这里按同样的口径实现。

## 只在 POSIX 上存在

`pty` 模块在 Windows 上 import 就失败；调用方（`tests/cli/entry.cli.e2e.ts`）用
`test.skipIf(process.platform === 'win32')` 显式跳过，不静默。

## 协议

argv: `pty-driver.py <timeout_ms> <command> [args...]`
环境变量 `DSC_PTY_STEPS`: JSON 数组，每步：

```json
{"send": "你好\r", "delayMs": 10000}
{"send": "\u0003", "after": "收到"}
```

- `delayMs`：发送前至少等这么久（默认 0）；
- `after`：输出里出现该子串后才发（用于「等模型回复再按 Ctrl+C」）；
- 两步可以同时给，先满足 `after` 再等 `delayMs`。

结束时向 stdout 打一行 JSON：`{"code": 0, "timedOut": false, "output": "..."}`。
超时视为失败（exit 2），但 JSON 仍会打出来，调用方能看清卡在哪。
"""

import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import fcntl


def wait_status_to_code(status: int) -> int:
    """把 waitpid 的 status 转成 shell 退出码（正常退出 / 被信号都给出可读值）。"""
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return -1


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: pty-driver.py <timeout_ms> <command> [args...]", file=sys.stderr)
        return 64

    timeout_ms = int(sys.argv[1])
    command = sys.argv[2:]
    steps = json.loads(os.environ.get("DSC_PTY_STEPS", "[]"))

    pid, fd = pty.fork()
    if pid == 0:  # 子进程：把当前进程换成被测命令，pty 的从端就是它的 stdin/stdout。
        try:
            os.execvp(command[0], command)
        except OSError as error:
            print(f"pty-driver: exec {command[0]} 失败：{error}", file=sys.stderr)
        os._exit(127)

    # 0x0 的窗口会让 ink 以为没有列宽；给一个正常终端尺寸。
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    output = bytearray()
    deadline = time.time() + timeout_ms / 1000.0
    index = 0
    next_send_at = time.time() + (steps[0].get("delayMs", 0) / 1000.0 if steps else 0)
    code = None
    timed_out = False

    while True:
        if time.time() > deadline:
            timed_out = True
            break

        if index < len(steps):
            step = steps[index]
            ready = True
            if "after" in step:
                ready = step["after"].encode("utf-8") in output
            if ready and time.time() >= next_send_at:
                try:
                    os.write(fd, step["send"].encode("utf-8"))
                except OSError:
                    # 子进程已经退出，写不进去；交给下面的 waitpid 收场。
                    pass
                index += 1
                if index < len(steps):
                    next_send_at = time.time() + steps[index].get("delayMs", 0) / 1000.0

        readable, _, _ = select.select([fd], [], [], 0.05)
        if fd in readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                # Linux 上从端关闭后 read 会抛 EIO；等价于 EOF。
                chunk = b""
            if not chunk:
                _, status = os.waitpid(pid, 0)
                code = wait_status_to_code(status)
                break
            output.extend(chunk)
        else:
            waited_pid, status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                code = wait_status_to_code(status)
                break

    if code is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
            code = wait_status_to_code(status)
        except ChildProcessError:
            code = None

    # 收尾前把缓冲区里剩下的字节读干净（子进程退出后可能还有一帧没读）。
    try:
        while True:
            readable, _, _ = select.select([fd], [], [], 0.05)
            if fd not in readable:
                break
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            output.extend(chunk)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass

    print(json.dumps({"code": code, "timedOut": timed_out, "output": output.decode("utf-8", "replace")}))
    return 2 if timed_out else 0


if __name__ == "__main__":
    sys.exit(main())
