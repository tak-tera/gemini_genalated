#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
レイヤー構成のアーキテクチャ図（中心のハブを各層が囲む形）を SVG / PNG で出力する。
配色とフォントは terao-archdiagram / terao-slides の規約に合わせている。

    python3 layered_arch.py -o ../layered.svg --png ../layered.png
"""
import argparse
import base64
import os
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "..", "logos")
W, H = 1280, 720
FONT = ("'M PLUS 1p','Hiragino Sans','Hiragino Kaku Gothic ProN',"
        "'Yu Gothic','Noto Sans JP','Noto Sans CJK JP',Meiryo,sans-serif")
PNG_FONT = "Noto Sans CJK JP"
INK, SUB, WHITE = "#1A1A1A", "#5A5A5A", "#FFFFFF"
PAL = {
    "teal":   {"fill": "#E3F4F6", "line": "#7FC8D1", "text": "#0B6C77", "key": "#0097A7"},
    "amber":  {"fill": "#FFF3E0", "line": "#FFCC80", "text": "#8A5000", "key": "#FFAB40"},
    "green":  {"fill": "#E8F5E9", "line": "#A5D6A7", "text": "#2E6B33", "key": "#66BB6A"},
    "rose":   {"fill": "#FCE9E9", "line": "#EFB4B4", "text": "#A33C3C", "key": "#E57373"},
    "violet": {"fill": "#EDE7F6", "line": "#B9A7DF", "text": "#5A3E96", "key": "#9575CD"},
    "blue":   {"fill": "#E4F0FA", "line": "#9EC6E8", "text": "#1B5E8C", "key": "#5B9BD5"},
    "gray":   {"fill": "#F4F6F8", "line": "#D7DCE3", "text": "#595959", "key": "#9AA5B1"},
}
ARROW = "#8A94A0"
out = []


def t(x, y, s, size=13, color=INK, weight="normal", anchor="start"):
    out.append(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
               f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}">{escape(s)}</text>')


def box(x, y, w, h, color, rx=10, dash=None, sw=1.6, fill=None):
    c = PAL[color]
    d = f' stroke-dasharray="{dash}"' if dash else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
               f'fill="{fill or c["fill"]}" stroke="{c["line"]}" stroke-width="{sw}"{d}/>')


def logo(name, x, y, w, h):
    with open(os.path.join(LOGO, name), "rb") as fp:
        b = base64.b64encode(fp.read()).decode()
    out.append(f'<image x="{x}" y="{y}" width="{w}" height="{h}" '
               f'preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,{b}"/>')


def user_icon(cx, cy, color, s=1.0):
    out.append(f'<circle cx="{cx}" cy="{cy - 7 * s}" r="{6 * s}" fill="none" stroke="{color}" stroke-width="2"/>'
               f'<path d="M{cx - 11 * s},{cy + 12 * s} a{11 * s},{10 * s} 0 0 1 {22 * s},0" '
               f'fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round"/>')


def line(points, color=ARROW, dash=None, head_end=True, head_start=False, sw=1.8):
    d = " ".join(f"{'M' if i == 0 else 'L'}{x},{y}" for i, (x, y) in enumerate(points))
    ds = f' stroke-dasharray="{dash}"' if dash else ""
    me = ' marker-end="url(#ah)"' if head_end else ""
    ms = ' marker-start="url(#ahs)"' if head_start else ""
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{ds}{me}{ms} '
               f'stroke-linejoin="round"/>')


def build():
    out.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" lang="ja">')
    out.append('<defs>'
               f'<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
               f'<path d="M0,0 L10,5 L0,10 z" fill="{ARROW}"/></marker>'
               f'<marker id="ahs" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
               f'<path d="M10,0 L0,5 L10,10 z" fill="{ARROW}"/></marker></defs>')
    out.append(f'<rect width="{W}" height="{H}" fill="{WHITE}"/>')

    # 見出し
    t(52, 56, "Gmail → Quire タスク登録アーキテクチャ", 27, INK, "bold")
    t(52, 84, "AI が下書きし、人が承認する。Google Workspace の台帳を中心にした登録基盤", 14, SUB)

    X, CW = 252, 776          # 中央カラム
    CX = X + CW / 2

    # --- 上：AI 判断（Claude）
    box(X, 108, CW, 70, "violet")
    logo("claude.svg", X + 20, 121, 44, 44)
    t(X + 80, 139, "Claude（AI 判断）", 19, PAL["violet"]["text"], "bold")
    t(X + 80, 161, "定期実行（毎時）／共通スキル", 12.5, SUB)
    logo("anthropic.svg", X + 300, 131, 92, 14)
    t(X + CW - 24, 137, "タスクの判定・抽出", 14, PAL["violet"]["text"], "bold", "end")
    t(X + CW - 24, 160, "登録先プロジェクトの推定", 14, PAL["violet"]["text"], "bold", "end")

    # --- Google Workspace の範囲
    box(X - 14, 196, CW + 28, 292, "gray", rx=14, dash="7 5", sw=1.6, fill="#FBFCFD")
    out.append(f'<rect x="{X}" y="186" width="128" height="22" fill="{WHITE}"/>')
    logo("google-workspace.svg", X + 4, 188, 120, 18)

    # --- 中心：台帳（ハブ）
    box(X, 222, CW, 72, "amber", sw=2.2)
    logo("google-sheets.svg", X + 22, 236, 40, 44)
    t(X + 80, 252, "台帳：登録ログ", 20, PAL["amber"]["text"], "bold")
    t(X + 80, 276, "Google スプレッドシート／すべての候補・判定・承認を1行ずつ記録", 12.5, SUB)
    t(X + CW - 24, 252, "状態管理", 14, PAL["amber"]["text"], "bold", "end")
    t(X + CW - 24, 275, "承認待ち → 登録済／却下", 14, PAL["amber"]["text"], "bold", "end")
    line([(CX, 178), (CX, 220)])
    t(CX + 10, 204, "承認待ちを追記", 11.5, SUB)

    # --- 中段：3つの機能
    bw, gap, by, bh = 244, 22, 334, 128
    cols = [X, X + bw + gap, X + 2 * (bw + gap)]
    items = [
        ("teal", ["google-apps-script.svg", "google-chat.svg"], "確認カード送信",
         ["Apps Script（5分ごと）", "Chat Webhook・cardsV2", "1回最大20件"]),
        ("blue", ["google-sheets.svg"], "ルール・設定",
         ["送信元・関係性・キーワード", "修正・移動から学習（毎朝）", "担当者・General の入れ先"]),
        ("amber", ["google-apps-script.svg"], "承認ページ（安全制御）",
         ["アクセスは本人のみ", "HMAC 署名・入力検証", "二重登録を防止"]),
    ]
    for (color, logos, title, lines), x in zip(items, cols):
        c = PAL[color]
        box(x, by, bw, bh, color, sw=2.2 if color == "amber" else 1.6)
        lx = x + 16
        for lg in logos:
            logo(lg, lx, by + 14, 28, 28)
            lx += 34
        t(lx + 4, by + 34, title, 16.5, c["text"], "bold")
        for i, s in enumerate(lines):
            t(x + 18, by + 68 + i * 21, "・" + s, 13, INK)
    # ハブ → 各機能
    line([(cols[0] + bw / 2, 296), (cols[0] + bw / 2, by - 2)])
    line([(cols[1] + bw / 2, 298), (cols[1] + bw / 2, by - 2)], head_start=True)
    line([(cols[2] + bw / 2, 298), (cols[2] + bw / 2, by - 2)], head_start=True)

    # --- 下：人（承認者）
    hy = 512
    box(X, hy, CW, 70, "rose")
    for i in range(3):
        user_icon(X + 36 + i * 30, hy + 37, PAL["rose"]["key"], 1.0)
    t(X + 140, hy + 31, "人（承認者）", 19, PAL["rose"]["text"], "bold")
    t(X + 140, hy + 54, "Google Chat のカードから判断", 12.5, SUB)
    t(X + CW - 24, hy + 31, "登録する｜内容を直して登録｜却下", 14, PAL["rose"]["text"], "bold", "end")
    t(X + CW - 24, hy + 54, "最終判断は必ず人が行う", 14, PAL["rose"]["text"], "bold", "end")
    line([(cols[0] + bw / 2, by + bh + 2), (cols[0] + bw / 2, hy - 2)])
    t(cols[0] + bw / 2 + 10, by + bh + 30, "カードが届く", 11.5, SUB)
    line([(cols[2] + bw / 2, hy - 2), (cols[2] + bw / 2, by + bh + 2)])
    t(cols[2] + bw / 2 + 10, by + bh + 30, "ボタンで開く", 11.5, SUB)

    # --- 左：入力
    lx = 132
    inputs = [(150, "gmail.svg", "依頼メール", "Gmail"),
              (270, None, "議事録・チャット", "共通スキル"),
              (390, None, "手入力・他プロジェクト", "共通スキル")]
    for y, lg, a, b in inputs:
        if lg:
            logo(lg, lx - 20, y - 46, 40, 30)
        else:
            out.append(f'<rect x="{lx - 18}" y="{y - 46}" width="36" height="28" rx="5" fill="none" '
                       f'stroke="{PAL["gray"]["key"]}" stroke-width="2"/>'
                       f'<path d="M{lx - 10},{y - 37} h20 M{lx - 10},{y - 31} h20 M{lx - 10},{y - 25} h12" '
                       f'stroke="{PAL["gray"]["key"]}" stroke-width="2" stroke-linecap="round"/>')
        t(lx, y - 1, a, 13.5, INK, "bold", "middle")
        t(lx, y + 17, b, 11.5, SUB, "middle")
        line([(lx + 76, y - 30), (222, y - 30)], dash="5 4", head_end=False)
    line([(222, 120), (222, 360)], dash="5 4", head_end=False)
    line([(222, 143), (X - 2, 143)])

    # --- 右：成果物
    rx = 1150
    line([(X + CW + 2, by + bh / 2), (X + CW + 30, by + bh / 2), (X + CW + 30, 160), (rx - 64, 160)])
    t(X + CW + 36, 342, "Quire API", 11.5, SUB)
    logo("quire.svg", rx - 50, 128, 100, 30)
    t(rx, 180, "Quire タスク", 13.5, INK, "bold", "middle")
    t(rx, 198, "期間・担当者つき", 11.5, SUB, "middle")
    outs = [(300, "監査ログ", "判断と結果の記録"), (420, "育つルール", "使うほど賢くなる")]
    for y, a, b in outs:
        out.append(f'<rect x="{rx - 17}" y="{y - 50}" width="34" height="30" rx="5" fill="none" '
                   f'stroke="{PAL["gray"]["key"]}" stroke-width="2"/>'
                   f'<path d="M{rx - 9},{y - 41} h18 M{rx - 9},{y - 35} h18 M{rx - 9},{y - 29} h10" '
                   f'stroke="{PAL["gray"]["key"]}" stroke-width="2" stroke-linecap="round"/>')
        t(rx, y - 1, a, 13.5, INK, "bold", "middle")
        t(rx, y + 17, b, 11.5, SUB, "middle")
        line([(X + CW + 16, y - 30), (rx - 60, y - 30)], dash="5 4", head_end=False)

    # --- 下部のひとこと
    cy = 612
    a = PAL["amber"]
    out.append(f'<rect x="{X}" y="{cy}" width="{CW}" height="56" rx="10" fill="{a["fill"]}" '
               f'stroke="{a["line"]}" stroke-width="1.5" stroke-dasharray="6 4"/>'
               f'<circle cx="{X + 32}" cy="{cy + 28}" r="14" fill="{a["key"]}"/>')
    t(X + 32, cy + 34, "!", 17, WHITE, "bold", "middle")
    t(X + 60, cy + 25, "AI は下書きまで。決めるのは人。", 14, a["text"], "bold")
    t(X + 60, cy + 46, "判断の記録が台帳に残り、使うほど振り分けが賢くなる", 14, a["text"], "bold")

    out.append("</svg>")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default="layered.svg")
    ap.add_argument("--png")
    a = ap.parse_args()
    svg = build()
    with open(a.out, "w", encoding="utf-8") as fp:
        fp.write(svg)
    print("wrote", a.out)
    if a.png:
        import cairosvg
        cairosvg.svg2png(bytestring=svg.replace(FONT, PNG_FONT).encode("utf-8"),
                         write_to=a.png, scale=2.0, background_color="white")
        print("wrote", a.png)


if __name__ == "__main__":
    main()
