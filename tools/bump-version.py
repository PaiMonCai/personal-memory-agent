#!/usr/bin/env python3
"""静态资源版本号统一递增工具。

用法：
    python tools/bump-version.py 20260922d

把所有 HTML / JS 里形如 `?v=xxx` 的版本查询参数统一改成新值。

为什么要用它：平台网关会给静态资源做边缘缓存，重新发布后裸路径可能仍返回旧副本。
解决办法是给资源引用加版本指纹，但版本号散落在 index.html 与每个 JS 模块的 import 里，
手工改极易漏掉一两处 —— 而漏改的后果是同一个模块被当成两个模块加载
（对 cloud.js 而言就是出现两个 SDK 客户端实例，行为会出问题）。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATTERN = re.compile(r"\?v=[A-Za-z0-9._-]+")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1

    new = sys.argv[1].strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", new):
        print("版本号只能包含字母、数字、点、下划线和连字符")
        return 1

    targets = [ROOT / "index.html"] + sorted((ROOT / "assets" / "js").glob("*.js"))
    old_values: set[str] = set()
    total = 0

    for f in targets:
        if not f.exists():
            continue
        src = f.read_text(encoding="utf-8")
        found = PATTERN.findall(src)
        if not found:
            continue
        old_values.update(found)
        out, n = PATTERN.subn(f"?v={new}", src)
        f.write_text(out, encoding="utf-8")
        total += n
        print(f"  {f.relative_to(ROOT)}: {n} 处")

    print()
    print(f"旧版本号：{sorted(old_values) or '（无）'}")
    print(f"新版本号：?v={new}")
    print(f"共修改 {total} 处")

    if total == 0:
        print("\n警告：一处都没改到，请检查 HTML 与 JS 里的引用是否真的带了 ?v= 参数")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
