"""提取 dsh 设计令牌：静态色阶 + 别名（语义）映射。只读。

输出三块：
1. --dsw-static-* 的全部「名字:#hex」；
2. --dsw-alias-*: var(...) 的全部映射（看语义怎么落到静态色阶上）；
3. 找深色主题块（含 data-ds-dark-theme / dark）附近的别名覆盖。
"""
import re

ASAR = r"D:\dsh\resources\app.asar"
with open(ASAR, "rb") as handle:
    text = handle.read().decode("utf-8", "replace")

static_pairs = {}
for name, value in re.findall(r"(--dsw-static-[a-z0-9-]+):(#[0-9a-fA-F]{3,8})", text):
    static_pairs.setdefault(name, value)

alias_pairs = {}
for name, value in re.findall(r"(--dsw-alias-[a-z0-9-]+):([^;{}]{1,60})", text):
    alias_pairs.setdefault(name, value.strip())

print(f"静态色阶 {len(static_pairs)} 个：")
for name in sorted(static_pairs):
    print(f"  {name} = {static_pairs[name]}")

print(f"\n别名令牌 {len(alias_pairs)} 个：")
for name in sorted(alias_pairs):
    print(f"  {name} = {alias_pairs[name]}")

print("\n深色主题块上下文（data-ds-dark-theme 前后 1200 字）：")
index = text.find("data-ds-dark-theme")
if index < 0:
    print("  没找到 data-ds-dark-theme")
else:
    chunk = text[max(0, index - 200) : index + 1200]
    print("".join(ch if ch.isprintable() or ch in "\n" else "·" for ch in chunk))
