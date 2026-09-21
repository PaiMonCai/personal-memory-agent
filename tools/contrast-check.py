#!/usr/bin/env python3
"""按 WCAG 2.2 AA 核对 style.css 里的配色对比度。

正文文字需 ≥ 4.5:1；大字号与 UI 组件边界需 ≥ 3:1。
配色会随主题预设与用户自定义色变化，所以这个检查要能随时复跑。

用法：python tools/contrast-check.py
"""
import pathlib
import re
import sys

CSS_PATH = pathlib.Path(__file__).resolve().parent.parent / "assets" / "style.css"
CSS = CSS_PATH.read_text(encoding="utf-8")


def block(selector: str) -> str:
    m = re.search(re.escape(selector) + r"\s*\{(.*?)\}", CSS, re.S)
    return m.group(1) if m else ""


def vars_of(body: str) -> dict:
    return {k: v.strip() for k, v in re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;]+);", body)}


light = vars_of(block(":root"))
dark = vars_of(block("html[data-mode='dark']"))
# 深浅模式的页面底色由 JS 按所选主题注入，CSS 里取不到，用最亮的深色预设当基准（最严苛）
dark["--bg-from"] = "#15171f"
dark["--bg-to"] = "#1d2130"


def resolve(name: str, table: dict, depth: int = 0) -> str:
    v = table.get(name) or light.get(name) or ""
    if v.startswith("var(") and depth < 5:
        inner = re.match(r"var\((--[a-z0-9-]+)", v)
        if inner:
            return resolve(inner.group(1), table, depth + 1)
    return v


def to_rgb(v: str):
    v = v.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", v)
    if m:
        n = int(m.group(1), 16)
        return ((n >> 16) & 255, (n >> 8) & 255, n & 255)
    m = re.fullmatch(r"#([0-9a-fA-F]{3})", v)
    if m:
        return tuple(int(c * 2, 16) for c in m.group(1))
    m = re.fullmatch(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)", v)
    if m:
        return (float(m.group(1)), float(m.group(2)), float(m.group(3)))
    return None


def lum(rgb) -> float:
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (ch(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg, bg) -> float:
    a, b = lum(fg), lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def alpha_over(fg_raw: str, bg):
    m = re.fullmatch(r"rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)", fg_raw)
    if not m:
        return fg_raw
    r, g, b, a = (float(x) for x in m.groups())
    return tuple(a * c + (1 - a) * d for c, d in zip((r, g, b), bg))


WHITE = (255, 255, 255)

CASES = [
    ("浅色", light, [
        ("正文 / 卡片底", "--text", "--surface", 4.5),
        ("次要文字 / 卡片底", "--text-2", "--surface", 4.5),
        ("辅助文字 / 卡片底", "--text-3", "--surface", 4.5),
        ("正文 / 页面底", "--text", "--bg-from", 4.5),
        ("辅助文字 / 页面底", "--text-3", "--bg-from", 4.5),
        ("主按钮文字 / 强调色", None, "--brand", 4.5),
        ("想法徽章 / 卡片底", "--idea", "--surface", 4.5),
        ("资料徽章 / 卡片底", "--material", "--surface", 4.5),
        ("待办徽章 / 卡片底", "--todo", "--surface", 4.5),
        ("随记徽章 / 卡片底", "--note", "--surface", 4.5),
        ("危险色 / 卡片底", "--danger", "--surface", 4.5),
        ("已完成徽章文字 / 徽章底", "--done-fg", "--done-bg", 4.5),
        ("逾期徽章文字 / 徽章底", "--due-fg", "--due-bg", 4.5),
        ("控件边框 / 卡片底", "--line-strong", "--surface", 3.0),
        ("拖动手柄 / 悬浮层底", "--text-3", "--float-bg", 3.0),
        ("侧栏键盘提示 / 悬浮层底", "--text-3", "--float-bg", 4.5),
        ("模型列表项 / 面板底", "--text-2", "--surface", 4.5),
        ("模型列表提示 / 面板底", "--text-3", "--surface", 4.5),
        ("行内代码 / 代码底", "--text-2", "--surface-3", 4.5),
    ]),
    ("深色", dark, [
        ("正文 / 卡片底", "--text", "--surface", 4.5),
        ("次要文字 / 卡片底", "--text-2", "--surface", 4.5),
        ("辅助文字 / 卡片底", "--text-3", "--surface", 4.5),
        ("正文 / 页面底", "--text", "--bg-from", 4.5),
        ("辅助文字 / 页面底", "--text-3", "--bg-from", 4.5),
        ("想法徽章 / 卡片底", "--idea", "--surface", 4.5),
        ("资料徽章 / 卡片底", "--material", "--surface", 4.5),
        ("待办徽章 / 卡片底", "--todo", "--surface", 4.5),
        ("随记徽章 / 卡片底", "--note", "--surface", 4.5),
        ("危险色 / 卡片底", "--danger", "--surface", 4.5),
        ("控件边框 / 卡片底", "--line-strong", "--surface", 3.0),
        ("拖动手柄 / 悬浮层底", "--text-3", "--float-bg", 3.0),
        ("侧栏键盘提示 / 悬浮层底", "--text-3", "--float-bg", 4.5),
        ("模型列表项 / 面板底", "--text-2", "--surface", 4.5),
        ("模型列表提示 / 面板底", "--text-3", "--surface", 4.5),
        ("行内代码 / 代码底", "--text-2", "--surface-3", 4.5),
    ]),
]

fails = []
for label, table, cases in CASES:
    print(f"=== {label} ===")
    for name, fg_name, bg_name, need in cases:
        bg = to_rgb(resolve(bg_name, table))
        fg_raw = resolve(fg_name, table) if fg_name else None
        fg = WHITE if fg_name is None else to_rgb(alpha_over(fg_raw, bg) if fg_raw.startswith("rgba") else fg_raw)
        if not fg or not bg:
            print(f"  跳过  {name}")
            continue
        r = ratio(fg, bg)
        ok = r >= need
        if not ok:
            fails.append((label, name, r, need))
        print(f"  {'OK  ' if ok else 'FAIL'} {name:24s} {r:5.2f}:1  (需 {need})")
    print()

if fails:
    print("未达标的组合：")
    for label, name, r, need in fails:
        print(f"  {label} · {name}：{r:.2f}:1，需 {need}:1")
    sys.exit(1)

print("全部通过 WCAG 2.2 AA 对比度要求")
