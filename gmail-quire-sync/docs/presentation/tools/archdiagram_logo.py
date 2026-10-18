#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
terao-archdiagram : JSON 仕様からアーキテクチャ図（SVG / PNG）を生成する。

    python3 archdiagram_logo.py spec.json -o out.svg [--png out.png] [--strict]

仕様の書き方は terao-archdiagram スキルの references/spec.md を参照。
このファイルはその写しに、製品ロゴを載せるための次のキーだけを足したもの:
  - card の "logo": ロゴ SVG のパス（仕様ファイルからの相対）。icon の代わりに描く
  - lane の "platform": {"logo": パス, "text": "Google Workspace"}。レーン名の下に提供元を1行で示す
"""

import argparse
import base64
import json
import os
import math
import sys
import unicodedata
from xml.sax.saxutils import escape

# ---------------------------------------------------------------- キャンバス
W = 1280
H = 720
MX = 52                 # 左右マージン
TITLE_Y = 62
LANE_GAP = 46           # レーン間（矢印の通り道）
FRAME_PAD = 12          # レーン枠の内側余白
BLOCK_GAP = 10          # ブロック間
CARD_PAD = 10

FONT = ("'M PLUS 1p','Hiragino Sans','Hiragino Kaku Gothic ProN',"
        "'Yu Gothic','Noto Sans JP','Noto Sans CJK JP',Meiryo,sans-serif")

# cairosvg（Pango）はフォントスタックを1つの名前として解釈するため、
# PNG 化のときだけサンドボックスに実在する単一フォント名に差し替える。
# SVG ファイル本体のフォント指定は FONT のまま（ブラウザ／Google スライド用）。
PNG_FONT = "Noto Sans CJK JP"

INK = "#1A1A1A"
BODY = "#595959"
SUB = "#5A5A5A"
HAIR = "#D7DCE3"
WHITE = "#FFFFFF"

# ---------------------------------------------------------------- パレット
# fill=淡い塗り / line=枠線 / text=文字 / key=番号丸・バッジの地色
PALETTE = {
    "teal":   {"fill": "#E3F4F6", "line": "#7FC8D1", "text": "#0B6C77", "key": "#0097A7"},
    "amber":  {"fill": "#FFF3E0", "line": "#FFCC80", "text": "#8A5000", "key": "#FFAB40"},
    "green":  {"fill": "#E8F5E9", "line": "#A5D6A7", "text": "#2E6B33", "key": "#66BB6A"},
    "rose":   {"fill": "#FCE9E9", "line": "#EFB4B4", "text": "#A33C3C", "key": "#E57373"},
    "violet": {"fill": "#EDE7F6", "line": "#B9A7DF", "text": "#5A3E96", "key": "#9575CD"},
    "blue":   {"fill": "#E4F0FA", "line": "#9EC6E8", "text": "#1B5E8C", "key": "#5B9BD5"},
    "gray":   {"fill": "#F4F6F8", "line": "#D7DCE3", "text": "#595959", "key": "#9AA5B1"},
}


SPEC_DIR = "."


def logo_image(path, x, y, w, h):
    """ロゴ SVG/PNG を data URI で埋め込む。縦横比は保つ。"""
    full = path if os.path.isabs(path) else os.path.join(SPEC_DIR, path)
    with open(full, "rb") as fp:
        data = base64.b64encode(fp.read()).decode()
    mime = "image/svg+xml" if full.endswith(".svg") else "image/png"
    return (f'<image x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'preserveAspectRatio="xMidYMid meet" href="data:{mime};base64,{data}"/>')


def pal(name):
    return PALETTE.get(name or "teal", PALETTE["teal"])


# ---------------------------------------------------------------- 文字幅
def char_w(ch, fs):
    if unicodedata.east_asian_width(ch) in ("W", "F", "A"):
        return fs * 1.0
    return fs * 0.53


def text_w(s, fs):
    return sum(char_w(c, fs) for c in s)


def wrap(text, fs, max_w):
    """明示改行を尊重しつつ、日本語は文字単位・英語は語単位で折り返す。"""
    out = []
    for para in str(text).split("\n"):
        if not para:
            out.append("")
            continue
        line = ""
        i = 0
        while i < len(para):
            ch = para[i]
            token = ch
            # 半角の連続（英単語・数字）はまとめて1トークン
            if unicodedata.east_asian_width(ch) not in ("W", "F", "A") and ch != " ":
                j = i
                while (j < len(para) and para[j] != " "
                       and unicodedata.east_asian_width(para[j]) not in ("W", "F", "A")):
                    j += 1
                token = para[i:j]
            if line and text_w(line + token, fs) > max_w:
                out.append(line.rstrip())
                line = token.lstrip()
            else:
                line += token
            i += len(token)
        if line:
            out.append(line.rstrip())
    return out or [""]


# ---------------------------------------------------------------- SVG部品
def esc(s):
    return escape(str(s))


def tspan_lines(lines, x, y, fs, lh, color, weight="normal", anchor="middle"):
    parts = [f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{fs}" '
             f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}" '
             f'xml:space="preserve">']
    for i, ln in enumerate(lines):
        dy = 0 if i == 0 else lh
        parts.append(f'<tspan x="{x:.1f}" dy="{dy:.1f}">{esc(ln)}</tspan>')
    parts.append('</text>')
    return "".join(parts)


def rect(x, y, w, h, fill, stroke=None, rx=8, dash=None, sw=1.4):
    s = f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" fill="{fill}"'
    if stroke:
        s += f' stroke="{stroke}" stroke-width="{sw}"'
    if dash:
        s += f' stroke-dasharray="{dash}"'
    return s + '/>'


def pill(x, y, w, h, text, fill, color, fs=11.5, weight="bold"):
    return (rect(x, y, w, h, fill, rx=h / 2) +
            tspan_lines([text], x + w / 2, y + h / 2 + fs * 0.36, fs, 0, color, weight))


def arrow_h(x1, x2, y, color):
    """左→右の矢印。"""
    head = 9
    return (f'<line x1="{x1:.1f}" y1="{y:.1f}" x2="{x2 - head:.1f}" y2="{y:.1f}" '
            f'stroke="{color}" stroke-width="2.4" stroke-linecap="round"/>'
            f'<polygon points="{x2:.1f},{y:.1f} {x2 - head:.1f},{y - 5.5:.1f} '
            f'{x2 - head:.1f},{y + 5.5:.1f}" fill="{color}"/>')


def arrow_v(x, y1, y2, color):
    head = 8
    return (f'<line x1="{x:.1f}" y1="{y1:.1f}" x2="{x:.1f}" y2="{y2 - head:.1f}" '
            f'stroke="{color}" stroke-width="2.2" stroke-linecap="round"/>'
            f'<polygon points="{x:.1f},{y2:.1f} {x - 5:.1f},{y2 - head:.1f} '
            f'{x + 5:.1f},{y2 - head:.1f}" fill="{color}"/>')


def elbow(x1, y1, x2, y2, color):
    """直角の折れ線矢印（横→縦→横）。曲線は使わない。"""
    head = 9
    mid = (x1 + x2) / 2
    d = f"M {x1:.1f} {y1:.1f} L {mid:.1f} {y1:.1f} L {mid:.1f} {y2:.1f} L {x2 - head:.1f} {y2:.1f}"
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2.4" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
            f'<polygon points="{x2:.1f},{y2:.1f} {x2 - head:.1f},{y2 - 5.5:.1f} '
            f'{x2 - head:.1f},{y2 + 5.5:.1f}" fill="{color}"/>')


# ---------------------------------------------------------------- アイコン
def icon(kind, cx, cy, color, s=30):
    """単色アイコン。中心 (cx, cy)、外接サイズ s。"""
    k = s / 30.0
    x, y = cx - 15 * k, cy - 15 * k

    def P(d, fill="none", sw=2.0):
        return (f'<path d="{d}" fill="{fill}" stroke="{color}" stroke-width="{sw * k:.2f}" '
                f'stroke-linejoin="round" stroke-linecap="round"/>')

    if kind == "mail":
        return (f'<rect x="{x + 2 * k:.1f}" y="{y + 6 * k:.1f}" width="{26 * k:.1f}" '
                f'height="{18 * k:.1f}" rx="{3 * k:.1f}" fill="none" stroke="{color}" '
                f'stroke-width="{2 * k:.2f}"/>' +
                P(f"M {x + 2 * k:.1f} {y + 8 * k:.1f} L {cx:.1f} {y + 17 * k:.1f} "
                  f"L {x + 28 * k:.1f} {y + 8 * k:.1f}"))
    if kind == "folder":
        return P(f"M {x + 2 * k:.1f} {y + 24 * k:.1f} L {x + 2 * k:.1f} {y + 7 * k:.1f} "
                 f"L {x + 12 * k:.1f} {y + 7 * k:.1f} L {x + 15 * k:.1f} {y + 11 * k:.1f} "
                 f"L {x + 28 * k:.1f} {y + 11 * k:.1f} L {x + 28 * k:.1f} {y + 24 * k:.1f} Z")
    if kind == "sheet":
        g = [f'<rect x="{x + 3 * k:.1f}" y="{y + 5 * k:.1f}" width="{24 * k:.1f}" '
             f'height="{20 * k:.1f}" rx="{2 * k:.1f}" fill="none" stroke="{color}" '
             f'stroke-width="{2 * k:.2f}"/>']
        for i in (1, 2):
            g.append(f'<line x1="{x + 3 * k:.1f}" y1="{y + (5 + 6.7 * i) * k:.1f}" '
                     f'x2="{x + 27 * k:.1f}" y2="{y + (5 + 6.7 * i) * k:.1f}" '
                     f'stroke="{color}" stroke-width="{1.5 * k:.2f}"/>')
        g.append(f'<line x1="{x + 11 * k:.1f}" y1="{y + 5 * k:.1f}" x2="{x + 11 * k:.1f}" '
                 f'y2="{y + 25 * k:.1f}" stroke="{color}" stroke-width="{1.5 * k:.2f}"/>')
        return "".join(g)
    if kind == "app":
        return (f'<rect x="{x + 6 * k:.1f}" y="{y + 3 * k:.1f}" width="{18 * k:.1f}" '
                f'height="{24 * k:.1f}" rx="{3 * k:.1f}" fill="none" stroke="{color}" '
                f'stroke-width="{2 * k:.2f}"/>'
                f'<line x1="{x + 11 * k:.1f}" y1="{y + 23 * k:.1f}" x2="{x + 19 * k:.1f}" '
                f'y2="{y + 23 * k:.1f}" stroke="{color}" stroke-width="{2 * k:.2f}" '
                f'stroke-linecap="round"/>')
    if kind == "doc":
        return (P(f"M {x + 7 * k:.1f} {y + 3 * k:.1f} L {x + 18 * k:.1f} {y + 3 * k:.1f} "
                  f"L {x + 23 * k:.1f} {y + 9 * k:.1f} L {x + 23 * k:.1f} {y + 27 * k:.1f} "
                  f"L {x + 7 * k:.1f} {y + 27 * k:.1f} Z") +
                P(f"M {x + 11 * k:.1f} {y + 15 * k:.1f} L {x + 19 * k:.1f} {y + 15 * k:.1f}", sw=1.5) +
                P(f"M {x + 11 * k:.1f} {y + 20 * k:.1f} L {x + 19 * k:.1f} {y + 20 * k:.1f}", sw=1.5))
    if kind == "db":
        return (f'<ellipse cx="{cx:.1f}" cy="{y + 8 * k:.1f}" rx="{11 * k:.1f}" '
                f'ry="{4.5 * k:.1f}" fill="none" stroke="{color}" stroke-width="{2 * k:.2f}"/>'
                + P(f"M {cx - 11 * k:.1f} {y + 8 * k:.1f} L {cx - 11 * k:.1f} {y + 22 * k:.1f} "
                    f"A {11 * k:.1f} {4.5 * k:.1f} 0 0 0 {cx + 11 * k:.1f} {y + 22 * k:.1f} "
                    f"L {cx + 11 * k:.1f} {y + 8 * k:.1f}")
                + P(f"M {cx - 11 * k:.1f} {y + 15 * k:.1f} A {11 * k:.1f} {4.5 * k:.1f} 0 0 0 "
                    f"{cx + 11 * k:.1f} {y + 15 * k:.1f}", sw=1.5))
    if kind == "gear":
        pts = []
        for i in range(8):
            a = math.radians(i * 45)
            pts.append(f"{cx + 12 * k * math.cos(a):.1f},{cy + 12 * k * math.sin(a):.1f}")
            a2 = math.radians(i * 45 + 22.5)
            pts.append(f"{cx + 8 * k * math.cos(a2):.1f},{cy + 8 * k * math.sin(a2):.1f}")
        return (f'<polygon points="{" ".join(pts)}" fill="none" stroke="{color}" '
                f'stroke-width="{2 * k:.2f}" stroke-linejoin="round"/>'
                f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{4 * k:.1f}" fill="none" '
                f'stroke="{color}" stroke-width="{2 * k:.2f}"/>')
    if kind == "ai":
        return (P(f"M {cx:.1f} {cy - 13 * k:.1f} L {cx + 4 * k:.1f} {cy - 4 * k:.1f} "
                  f"L {cx + 13 * k:.1f} {cy:.1f} L {cx + 4 * k:.1f} {cy + 4 * k:.1f} "
                  f"L {cx:.1f} {cy + 13 * k:.1f} L {cx - 4 * k:.1f} {cy + 4 * k:.1f} "
                  f"L {cx - 13 * k:.1f} {cy:.1f} L {cx - 4 * k:.1f} {cy - 4 * k:.1f} Z"))
    if kind == "cloud":
        return P(f"M {cx - 12 * k:.1f} {cy + 6 * k:.1f} A {6 * k:.1f} {6 * k:.1f} 0 0 1 "
                 f"{cx - 8 * k:.1f} {cy - 5 * k:.1f} A {8 * k:.1f} {8 * k:.1f} 0 0 1 "
                 f"{cx + 8 * k:.1f} {cy - 4 * k:.1f} A {6 * k:.1f} {6 * k:.1f} 0 0 1 "
                 f"{cx + 12 * k:.1f} {cy + 6 * k:.1f} Z")
    if kind == "user":
        return (f'<circle cx="{cx:.1f}" cy="{cy - 6 * k:.1f}" r="{6 * k:.1f}" fill="none" '
                f'stroke="{color}" stroke-width="{2 * k:.2f}"/>' +
                P(f"M {cx - 11 * k:.1f} {cy + 12 * k:.1f} A {11 * k:.1f} {10 * k:.1f} 0 0 1 "
                  f"{cx + 11 * k:.1f} {cy + 12 * k:.1f}"))
    return ""


# ---------------------------------------------------------------- 計測
FS_CARD = 13.5
LH_CARD = 1.6
FS_CAP = 11
FS_NOTE = 11.5
FS_LABEL = 12.5


def measure(block, inner_w):
    """ブロックの高さを決め、折り返し済みテキストを block['_'] に格納する。"""
    t = block.get("type", "card")
    cache = {}
    block["_"] = cache

    if t == "spacer":
        return float(block.get("height", 10))

    if t == "arrow":
        return float(block.get("height", 26))

    if t == "label":
        fs = block.get("size", FS_LABEL)
        cache["lines"] = wrap(block.get("text", ""), fs, inner_w)
        cache["fs"] = fs
        return len(cache["lines"]) * fs * 1.55 + 4

    if t == "note":
        w = inner_w - 18
        cache["lines"] = wrap(block.get("text", ""), FS_NOTE, w)
        return len(cache["lines"]) * FS_NOTE * 1.55 + 18

    if t == "group":
        pad = 10
        inner = inner_w - pad * 2
        h = pad
        if block.get("title"):
            cache["tlines"] = wrap(block["title"], 12.5, inner)
            h += len(cache["tlines"]) * 12.5 * 1.5 + 8
        for b in block.get("blocks", []):
            b["_h"] = measure(b, inner)
        hs = [b["_h"] for b in block.get("blocks", [])]
        h += sum(hs) + BLOCK_GAP * max(0, len(hs) - 1) + pad
        return h

    # card
    text_left = CARD_PAD + (26 if block.get("num") else 0)
    inner = inner_w - text_left - CARD_PAD
    h = CARD_PAD
    if block.get("icon") or block.get("logo"):
        h += 36
    fs = block.get("size", FS_CARD)
    cache["fs"] = fs
    cache["lines"] = wrap(block.get("title", ""), fs, inner)
    h += len(cache["lines"]) * fs * LH_CARD
    if block.get("caption"):
        cache["clines"] = wrap(block["caption"], FS_CAP, inner)
        h += 4 + len(cache["clines"]) * FS_CAP * 1.5
    if block.get("tag"):
        h += 8 + 22
    h += CARD_PAD
    return max(h, 46)


# ---------------------------------------------------------------- 描画
def draw(block, x, y, w, lane_color, out):
    t = block.get("type", "card")
    cache = block.get("_", {})
    h = block["_h"]
    c = pal(block.get("color") or lane_color)

    if t == "spacer":
        return

    if t == "arrow":
        out.append(arrow_v(x + w / 2, y + 2, y + h - 2, block.get("stroke") or c["key"]))
        return

    if t == "label":
        fs = cache["fs"]
        align = block.get("align", "center")
        ax = x + w / 2 if align == "center" else x + 2
        anchor = "middle" if align == "center" else "start"
        out.append(tspan_lines(cache["lines"], ax, y + fs * 1.15, fs, fs * 1.55,
                               block.get("text_color") or SUB,
                               "bold" if block.get("bold") else "normal", anchor))
        return

    if t == "note":
        out.append(rect(x, y, w, h, block.get("fill", WHITE), c["line"], rx=7,
                        dash="4 3", sw=1.2))
        out.append(tspan_lines(cache["lines"], x + w / 2, y + 9 + FS_NOTE * 1.15,
                               FS_NOTE, FS_NOTE * 1.55, c["text"]))
        return

    if t == "group":
        out.append(rect(x, y, w, h, block.get("fill", WHITE), c["line"], rx=9,
                        dash="6 4" if block.get("dashed") else None, sw=1.4))
        pad = 10
        cy = y + pad
        if block.get("title"):
            out.append(tspan_lines(cache["tlines"], x + w / 2, cy + 12.5 * 1.15,
                                   12.5, 12.5 * 1.5, c["text"], "bold"))
            cy += len(cache["tlines"]) * 12.5 * 1.5 + 8
        for b in block.get("blocks", []):
            draw(b, x + pad, cy, w - pad * 2, block.get("color") or lane_color, out)
            cy += b["_h"] + BLOCK_GAP
        return

    # card
    out.append(rect(x, y, w, h, block.get("fill") or c["fill"], c["line"], rx=8,
                    dash="6 4" if block.get("dashed") else None, sw=1.4))
    text_left = CARD_PAD + (26 if block.get("num") else 0)
    cx = x + text_left + (w - text_left - CARD_PAD) / 2
    cy = y + CARD_PAD

    if block.get("num"):
        ncy = y + h / 2
        out.append(f'<circle cx="{x + CARD_PAD + 9:.1f}" cy="{ncy:.1f}" '
                   f'r="9.5" fill="{c["key"]}"/>')
        out.append(tspan_lines([str(block["num"])], x + CARD_PAD + 9,
                               ncy + 4, 11.5, 0, WHITE, "bold"))
    if block.get("logo"):
        out.append(logo_image(block["logo"], cx - 40, cy + 1, 80, 28))
        cy += 36
    elif block.get("icon"):
        out.append(icon(block["icon"], cx, cy + 15, c["key"], 30))
        cy += 36

    fs = cache["fs"]
    out.append(tspan_lines(cache["lines"], cx, cy + fs * 1.15, fs, fs * LH_CARD,
                           c["text"], "bold"))
    cy += len(cache["lines"]) * fs * LH_CARD

    if block.get("caption"):
        out.append(tspan_lines(cache["clines"], cx, cy + 4 + FS_CAP * 1.1,
                               FS_CAP, FS_CAP * 1.5, SUB))
        cy += 4 + len(cache["clines"]) * FS_CAP * 1.5

    if block.get("tag"):
        tw = text_w(block["tag"], 11) + 22
        out.append(pill(cx - tw / 2, cy + 8, tw, 22, block["tag"], WHITE, c["text"], 11))

    if block.get("badge"):
        bw = text_w(block["badge"], 10.5) + 16
        a = pal("amber")
        out.append(pill(x + w - bw - 6, y - 9, bw, 19, block["badge"], a["key"], WHITE, 10.5))


# ---------------------------------------------------------------- 本体
def build(spec, strict=False, tight=False):
    lanes = spec["lanes"]
    n = len(lanes)
    avail = W - MX * 2
    weights = [float(l.get("width", 1)) for l in lanes]
    tw = sum(weights)
    lane_w = [(avail - LANE_GAP * (n - 1)) * w / tw for w in weights]
    lane_x, cur = [], MX
    for w in lane_w:
        lane_x.append(cur)
        cur += w + LANE_GAP

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {{H}}" '
           f'width="{W}" height="{{H}}" lang="ja">',
           f'<rect x="0" y="0" width="{W}" height="{{H}}" fill="{WHITE}"/>']

    # --- 見出し
    y = TITLE_Y
    out.append(tspan_lines([spec.get("title", "")], MX, y, 28, 0, INK, "bold", "start"))
    if spec.get("subtitle"):
        y += 26
        out.append(tspan_lines([spec["subtitle"]], MX, y, 14, 0, SUB, "normal", "start"))
    head_bottom = y + 22

    # --- レーン計測
    lane_top = head_bottom + 24
    frames = []
    for i, lane in enumerate(lanes):
        inner = lane_w[i] - FRAME_PAD * 2
        for b in lane.get("blocks", []):
            b["_h"] = measure(b, inner)
        hs = [b["_h"] for b in lane.get("blocks", [])]
        body = sum(hs) + BLOCK_GAP * max(0, len(hs) - 1)
        has_frame = lane.get("frame", "solid") != "none"
        fh = body + (FRAME_PAD * 2 if has_frame else 0)
        frames.append({"h": fh, "body": body, "inner": inner, "has_frame": has_frame})

    has_platform = any(l.get("platform") for l in lanes)
    header_h = 30 + (24 if has_platform else 0)
    frame_top = lane_top + header_h
    max_fh = max(f["h"] for f in frames)

    # --- 矢印（枠の下に描く）
    conns = spec.get("connections")
    if conns is None:
        conns = [{"from": str(i + 1), "to": str(i + 2)} for i in range(n - 1)]

    def anchor_y(ref):
        parts = str(ref).split(".")
        li = int(parts[0]) - 1
        f = frames[li]
        if len(parts) == 1:
            return frame_top + f["h"] / 2
        bi = int(parts[1]) - 1
        yy = frame_top + (FRAME_PAD if f["has_frame"] else 0)
        for k, b in enumerate(lanes[li].get("blocks", [])):
            if k == bi:
                return yy + b["_h"] / 2
            yy += b["_h"] + BLOCK_GAP
        return frame_top + f["h"] / 2

    for cn in conns:
        li = int(str(cn["from"]).split(".")[0]) - 1
        lj = int(str(cn["to"]).split(".")[0]) - 1
        y1, y2 = anchor_y(cn["from"]), anchor_y(cn["to"])
        x1 = lane_x[li] + lane_w[li] + 4
        x2 = lane_x[lj] - 4
        col = pal(cn.get("color") or lanes[lj].get("color", "teal"))["line"]
        if abs(y1 - y2) < 3:
            out.append(arrow_h(x1, x2, (y1 + y2) / 2, col))
        else:
            out.append(elbow(x1, y1, x2, y2, col))

    # --- レーン本体
    lane_bottom = frame_top
    for i, lane in enumerate(lanes):
        f = frames[i]
        c = pal(lane.get("color"))
        x = lane_x[i]

        # ヘッダ（バッジ＋サービス名）
        bx = x + (FRAME_PAD if f["has_frame"] else 0)
        if lane.get("badge"):
            bw = text_w(lane["badge"], 11.5) + 20
            out.append(pill(bx, lane_top, bw, 23, lane["badge"], c["key"], WHITE, 11.5))
            bx += bw + 9
        out.append(tspan_lines([lane.get("name", "")], bx, lane_top + 17,
                               15.5, 0, INK, "bold", "start"))
        pf = lane.get("platform")
        if pf:
            px = x + (FRAME_PAD if f["has_frame"] else 0)
            py = lane_top + 30
            if pf.get("logo"):
                out.append(logo_image(pf["logo"], px, py, pf.get("logo_w", 18), 16))
                px += pf.get("logo_w", 18) + 6
            if pf.get("text"):
                out.append(tspan_lines([pf["text"]], px, py + 12.5, 11.5, 0, SUB,
                                       "normal", "start"))

        # 枠
        if f["has_frame"]:
            out.append(rect(x, frame_top, lane_w[i], f["h"],
                            lane.get("fill", WHITE), c["line"], rx=10,
                            dash="6 4" if lane.get("frame") == "dashed" else None, sw=1.5))

        cy = frame_top + (FRAME_PAD if f["has_frame"] else 0)
        for b in lane.get("blocks", []):
            draw(b, x + (FRAME_PAD if f["has_frame"] else 0), cy, f["inner"],
                 lane.get("color", "teal"), out)
            cy += b["_h"] + BLOCK_GAP
        lane_bottom = max(lane_bottom, frame_top + f["h"])

    # --- レーン下の注記（枠の外）。縦位置はレーンごとに独立して積む。
    lane_btm = [frame_top + frames[i]["h"] for i in range(n)]
    for i, lane in enumerate(lanes):
        ny = lane_btm[i] + 12
        for nb in lane.get("notes", []):
            nb.setdefault("type", "note")
            nb["_h"] = measure(nb, lane_w[i])
            draw(nb, lane_x[i], ny, lane_w[i], lane.get("color", "teal"), out)
            ny += nb["_h"] + 8
        lane_btm[i] = ny - 8 if lane.get("notes") else lane_btm[i]

    # --- ブラケット（複数レーンにまたがる注記）。またぐレーンの下だけを見る。
    for br in spec.get("brackets", []):
        a, b = br["lanes"][0] - 1, br["lanes"][-1] - 1
        bx = lane_x[a]
        bw = lane_x[b] + lane_w[b] - bx
        by = max(lane_btm[a:b + 1]) + 12
        nb = {"type": "note", "text": br["text"], "color": br.get("color", "teal")}
        nb["_h"] = measure(nb, bw)
        draw(nb, bx, by, bw, br.get("color", "teal"), out)
        for k in range(a, b + 1):
            lane_btm[k] = by + nb["_h"]

    # --- 下部のひとこと枠。重なるレーンの下にだけ潜り込ませる。
    bottom = max(lane_btm)
    co = spec.get("callout")
    if co:
        c = pal(co.get("color", "amber"))
        span = W - MX * 2
        cw = co.get("width", 0.62) * span
        cx = MX + co.get("x", 0.06) * span
        over = [lane_btm[i] for i in range(n)
                if lane_x[i] < cx + cw and lane_x[i] + lane_w[i] > cx]
        lines = []
        for t in (co["text"] if isinstance(co["text"], list) else [co["text"]]):
            lines += wrap(t, 14, cw - 78)
        ch = len(lines) * 14 * 1.7 + 28
        cy = (max(over) if over else bottom) + 18
        out.append(rect(cx, cy, cw, ch, c["fill"], c["line"], rx=10, dash="6 4", sw=1.5))
        out.append(f'<circle cx="{cx + 32:.1f}" cy="{cy + ch / 2:.1f}" r="15" fill="{c["key"]}"/>')
        out.append(tspan_lines(["!"], cx + 32, cy + ch / 2 + 6, 18, 0, WHITE, "bold"))
        out.append(tspan_lines(lines, cx + 62, cy + 14 + 14 * 1.2, 14, 14 * 1.7,
                               c["text"], "bold", "start"))
        bottom = max(bottom, cy + ch)

    total = bottom + 26
    height = int(math.ceil(total / 8) * 8) if tight else H
    if total > H:
        height = int(math.ceil(total / 8) * 8)
        msg = (f"[overflow] 内容が 1280x720 に収まりません（必要 {int(total)}px）。"
               f"項目を減らすか、レーンあたりのブロックを 4 個以内にしてください。")
        if strict:
            sys.exit(msg)
        print(msg, file=sys.stderr)

    # 内容が浅いときは、上下の余白が均等になるよう全体を少し下げる
    dy = 0.0 if tight else min(36.0, max(0.0, (height - total) / 2))
    if dy > 2:
        out.insert(2, f'<g transform="translate(0,{dy:.1f})">')
        out.append('</g>')

    out.append('</svg>')
    return "".join(out).replace("{H}", str(height))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("-o", "--out", default="diagram.svg")
    ap.add_argument("--png", help="同時に PNG も書き出す（Google スライド貼り付け用）")
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--strict", action="store_true", help="はみ出したらエラーで止める")
    ap.add_argument("--tight", action="store_true",
                    help="下余白を詰めて内容の高さに合わせる（HTML埋め込み用）")
    a = ap.parse_args()

    global SPEC_DIR
    SPEC_DIR = os.path.dirname(os.path.abspath(a.spec))
    with open(a.spec, encoding="utf-8") as fp:
        spec = json.load(fp)
    svg = build(spec, a.strict, a.tight)
    with open(a.out, "w", encoding="utf-8") as fp:
        fp.write(svg)
    print(f"wrote {a.out}")

    if a.png:
        import cairosvg
        raster = svg.replace(FONT, PNG_FONT)
        cairosvg.svg2png(bytestring=raster.encode("utf-8"), write_to=a.png,
                         scale=a.scale, background_color="white")
        print(f"wrote {a.png}")


if __name__ == "__main__":
    main()
