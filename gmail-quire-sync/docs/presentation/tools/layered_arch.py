#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
レイヤー構成のアーキテクチャ図（中心の層を上下の層が囲み、左に入力・右に出力を置く形）を
JSON 仕様から SVG / PNG で出力する。配色とフォントは terao-archdiagram / terao-slides と共通。

    python3 layered_arch.py spec.json -o diagram.svg --png diagram.png

仕様の書式は references/spec.md を参照。
"""
import argparse
import base64
import json
import os
import sys
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
BUILTIN_LOGOS = os.path.join(HERE, "..", "assets", "logos")
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
W = 1280
SIDE = 252            # 入力・出力の列を置くときの中央カラムの左右余白
MARGIN = 52
GAP = 44              # 層と層のあいだ（矢印とラベルの場所）
BOUND_PAD = 26        # 範囲枠と中の層のすきま


def warn(msg):
    print("[warn] " + msg, file=sys.stderr)


def text_w(s, size):
    """だいたいの文字幅（全角=1em、半角=0.55em）。はみ出し警告に使う。"""
    return sum(size if ord(ch) > 0x2E7F else size * 0.55 for ch in s)


class Diagram:
    def __init__(self, spec, spec_dir):
        self.spec = spec
        self.dirs = [spec_dir, BUILTIN_LOGOS]
        if spec.get("logo_dir"):
            self.dirs.insert(0, os.path.join(spec_dir, spec["logo_dir"]))
        self.out = []
        self.geo = {}     # id -> (x, y, w, h)
        self.badges = []

    # ---------- 部品 ----------
    def t(self, x, y, s, size=13, color=INK, weight="normal", anchor="start"):
        self.out.append(f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size}" '
                        f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}">{escape(s)}</text>')

    def box(self, x, y, w, h, color, rx=10, dash=None, sw=1.6, fill=None):
        c = PAL[color]
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" '
                        f'fill="{fill or c["fill"]}" stroke="{c["line"]}" stroke-width="{sw}"{d}/>')

    def find_logo(self, name):
        for d in self.dirs:
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
        if not name.endswith(".svg"):
            return self.find_logo(name + ".svg")
        raise SystemExit(f"logo not found: {name}")

    def logo(self, name, x, y, w, h):
        p = self.find_logo(name)
        mime = "image/svg+xml" if p.endswith(".svg") else "image/png"
        with open(p, "rb") as fp:
            b = base64.b64encode(fp.read()).decode()
        self.out.append(f'<image x="{x:.1f}" y="{y:.1f}" width="{w}" height="{h}" '
                        f'preserveAspectRatio="xMidYMid meet" href="data:{mime};base64,{b}"/>')

    def icon(self, kind, cx, cy, color):
        """単色の簡易アイコン。doc / users / user"""
        if kind == "doc":
            self.out.append(f'<rect x="{cx - 17}" y="{cy - 14}" width="34" height="28" rx="5" fill="none" '
                            f'stroke="{color}" stroke-width="2"/>'
                            f'<path d="M{cx - 9},{cy - 5} h18 M{cx - 9},{cy + 1} h18 M{cx - 9},{cy + 7} h10" '
                            f'stroke="{color}" stroke-width="2" stroke-linecap="round"/>')
        elif kind in ("user", "users"):
            n = 3 if kind == "users" else 1
            for i in range(n):
                x = cx + (i - (n - 1) / 2) * 30
                self.out.append(f'<circle cx="{x}" cy="{cy - 7}" r="6" fill="none" stroke="{color}" stroke-width="2"/>'
                                f'<path d="M{x - 11},{cy + 12} a11,10 0 0 1 22,0" '
                                f'fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round"/>')
        else:
            raise SystemExit(f"unknown icon: {kind}")

    def mark(self, m, x, y, size, color):
        """m は {"logo": ..} か {"icon": ..}。左上 (x, y)、高さ size に収める。戻り値は使った幅。"""
        if "logo" in m:
            w = m.get("w", size)
            h = m.get("h", size)
            self.logo(m["logo"], x, y + (size - h) / 2, w, h)
            return w
        self.icon(m["icon"], x + size / 2 + (30 if m["icon"] == "users" else 0), y + size / 2 + 2,
                  PAL[m.get("color", "gray")]["key"])
        return 90 if m["icon"] == "users" else size

    def badge(self, x, y, n):
        """作業の順番などを示す番号。最後にまとめて上に描く。"""
        self.badges.append((x, y, str(n)))

    def draw_badges(self):
        for x, y, n in self.badges:
            self.out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="14" fill="{INK}" stroke="{WHITE}" stroke-width="2.5"/>')
            self.t(x, y + 5.5, n, 15, WHITE, "bold", "middle")

    def line(self, pts, dash=None, head_end=True, head_start=False, sw=1.8):
        d = " ".join(f"{'M' if i == 0 else 'L'}{x:.1f},{y:.1f}" for i, (x, y) in enumerate(pts))
        ds = f' stroke-dasharray="{dash}"' if dash else ""
        me = ' marker-end="url(#ah)"' if head_end else ""
        ms = ' marker-start="url(#ahs)"' if head_start else ""
        self.out.append(f'<path d="{d}" fill="none" stroke="{ARROW}" stroke-width="{sw}"{ds}{me}{ms} '
                        f'stroke-linejoin="round"/>')

    # ---------- 層 ----------
    def band(self, L, x, y, w, h):
        color = L.get("color", "teal")
        c = PAL[color]
        self.box(x, y, w, h, color, sw=2.2 if L.get("emphasis") else 1.6)
        if "step" in L:
            self.badge(x + 2, y + 2, L["step"])
        lx = x + 20
        size = min(44, h - 26)
        for m in L.get("marks", []):
            lx += self.mark(m, lx, y + (h - size) / 2, size, color) + 8
        tx = max(lx + 8, x + 80)
        title_y = y + h / 2 - 4 if L.get("sub") else y + h / 2 + 7
        self.t(tx, title_y, L["title"], L.get("title_size", 19), c["text"], "bold")
        if L.get("sub"):
            self.t(tx, y + h / 2 + 19, L["sub"], 12.5, SUB)
        left_end = tx + max(text_w(L["title"], L.get("title_size", 19)), text_w(L.get("sub", ""), 12.5))
        if L.get("badge_logo"):
            b = L["badge_logo"]
            bw_, bh_ = b.get("w", 92), b.get("h", 14)
            bx = x + b["x"] if "x" in b else left_end + 24
            self.logo(b["logo"], bx, y + (h - bh_) / 2 - 4, bw_, bh_)
            left_end = bx + bw_
        right = L.get("right", [])
        n = len(right)
        for i, s in enumerate(right):
            yy = y + h / 2 + (i - (n - 1) / 2) * 23 + 5
            self.t(x + w - 24, yy, s, 14, c["text"], "bold", "end")
            if x + w - 24 - text_w(s, 14) < left_end + 12:
                warn(f"band '{L.get('id')}': right text overlaps title: {s}")

    def row(self, L, x, y, w, h):
        items = L["items"]
        gap = L.get("gap", 22)
        bw = (w - gap * (len(items) - 1)) / len(items)
        for i, it in enumerate(items):
            bx = x + i * (bw + gap)
            color = it.get("color", "teal")
            c = PAL[color]
            self.box(bx, y, bw, h, color, sw=2.2 if it.get("emphasis") else 1.6)
            if "step" in it:
                self.badge(bx + 2, y + 2, it["step"])
            lx = bx + 16
            for m in it.get("marks", []):
                lx += self.mark(m, lx, y + 14, 28, color) + 6
            self.t(lx + 4, y + 34, it["title"], 16.5, c["text"], "bold")
            if lx + 4 + text_w(it["title"], 16.5) > bx + bw - 8:
                warn(f"row item '{it.get('id')}': title too long")
            for j, s in enumerate(it.get("lines", [])):
                self.t(bx + 18, y + 68 + j * 21, "・" + s, 13, INK)
                if 18 + text_w("・" + s, 13) > bw - 8:
                    warn(f"row item '{it.get('id')}': line too long: {s}")
            if 68 + (len(it.get("lines", [])) - 1) * 21 > h - 12:
                warn(f"row item '{it.get('id')}': too many lines for height {h}")
            if it.get("id"):
                self.geo[it["id"]] = (bx, y, bw, h)

    # ---------- 全体 ----------
    def build(self):
        S = self.spec
        has_in, has_out = bool(S.get("inputs")), bool(S.get("outputs"))
        X = SIDE if has_in else MARGIN
        R = SIDE if has_out else MARGIN
        CW = W - X - R
        self.X, self.CW = X, CW

        # 範囲枠（boundary）の上下端に当たる層
        bounds = S.get("boundaries", [])
        if "boundary" in S:
            bounds = [S["boundary"]] + bounds
        ends = {b["layers"][-1]: b for b in bounds}

        # 縦の配置
        y = S.get("top", 108)
        layers = S["layers"]
        for i, L in enumerate(layers):
            h = L.get("h", 128 if L.get("type") == "row" else 70)
            self.geo[L.get("id", f"_{i}")] = (X, y, CW, h)
            L["_y"], L["_h"] = y, h
            g = L.get("gap_after", GAP)
            if L.get("id") in ends and i < len(layers) - 1:
                g = max(g, BOUND_PAD * 2 - 2)
            y += h + g
        body_bottom = layers[-1]["_y"] + layers[-1]["_h"]

        cal = S.get("callout")
        H = body_bottom + (30 + 56 + 52 if cal else 52)
        H = max(H, S.get("min_height", 720))
        self.H = H

        o = self.out
        o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" lang="ja">')
        o.append('<defs>'
                 f'<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                 f'<path d="M0,0 L10,5 L0,10 z" fill="{ARROW}"/></marker>'
                 f'<marker id="ahs" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                 f'<path d="M10,0 L0,5 L10,10 z" fill="{ARROW}"/></marker></defs>')
        o.append(f'<rect width="{W}" height="{H}" fill="{WHITE}"/>')

        self.t(MARGIN, 56, S.get("title", ""), 27, INK, "bold")
        if S.get("subtitle"):
            self.t(MARGIN, 84, S["subtitle"], 14, SUB)

        # 範囲枠（層より先に描く）
        for b in bounds:
            g0 = self.geo[b["layers"][0]]
            g1 = self.geo[b["layers"][-1]]
            top, bot = g0[1] - BOUND_PAD, g1[1] + g1[3] + BOUND_PAD
            self.box(X - 14, top, CW + 28, bot - top, "gray", rx=14, dash="7 5", sw=1.6, fill="#FBFCFD")
            if b.get("logo"):
                lw, lh = b.get("logo_w", 120), b.get("logo_h", 18)
                o.append(f'<rect x="{X}" y="{top - 10}" width="{lw + 8}" height="22" fill="{WHITE}"/>')
                self.logo(b["logo"], X + 4, top - 8, lw, lh)
                if b.get("label"):
                    o.append(f'<rect x="{X + lw + 8}" y="{top - 10}" width="{text_w(b["label"], 12) + 12}" '
                             f'height="22" fill="{WHITE}"/>')
                    self.t(X + lw + 14, top + 5, b["label"], 12, SUB, "bold")
            elif b.get("label"):
                o.append(f'<rect x="{X}" y="{top - 10}" width="{text_w(b["label"], 13) + 16}" height="22" fill="{WHITE}"/>')
                self.t(X + 8, top + 5, b["label"], 13, SUB, "bold")

        for L in layers:
            if L.get("type") == "row":
                self.row(L, X, L["_y"], CW, L["_h"])
            else:
                self.band(L, X, L["_y"], CW, L["_h"])

        self.links(S.get("links", []))
        if has_in:
            self.inputs(S["inputs"])
        if has_out:
            self.outputs(S["outputs"])
        if cal:
            self.callout(cal, body_bottom + 30)
        self.draw_badges()
        o.append("</svg>")
        return "".join(o)

    def links(self, links):
        for k in links:
            a, b = self.geo[k["from"]], self.geo[k["to"]]
            # 上下に並ぶ2つをつなぐ。x は細い方の中心＋dx
            narrow = a if a[2] <= b[2] else b
            x = narrow[0] + narrow[2] / 2 + k.get("dx", 0)
            if a[1] < b[1]:
                y0, y1 = a[1] + a[3], b[1]
            else:
                y0, y1 = a[1], b[1] + b[3]
            both = k.get("both", False)
            step = 2 if y1 > y0 else -2
            pts = [(x, y0 + step), (x, y1 - step)]
            self.line(pts, dash=k.get("dash"), head_start=both)
            if k.get("label"):
                side = k.get("label_side", "right")
                ly = (y0 + y1) / 2 + 4
                if abs(y1 - y0) > 60:
                    ly = min(y0, y1) + 28
                strong = k.get("strong")
                size = 12.5 if strong else 11.5
                color = PAL[k.get("color", "violet")]["text"] if strong else SUB
                tw = text_w(k["label"], size)
                lx0 = x + 6 if side == "right" else x - 10 - tw - 4
                # ラベルの下地（枠線や破線と重ならないように）
                self.out.append(f'<rect x="{lx0:.1f}" y="{ly - size:.1f}" width="{tw + 8:.1f}" '
                                f'height="{size + 6:.1f}" fill="{WHITE}"/>')
                if side == "right":
                    self.t(x + 10, ly, k["label"], size, color, "bold" if strong else "normal")
                else:
                    self.t(x - 10, ly, k["label"], size, color, "bold" if strong else "normal", "end")

    def side_ys(self, items, default_top, default_bottom):
        n = len(items)
        ys = []
        for i, it in enumerate(items):
            if "y" in it:
                ys.append(it["y"])
            else:
                step = (default_bottom - default_top) / max(n, 1)
                ys.append(default_top + step * (i + 0.5) + 25)
        return ys

    def inputs(self, cfg):
        items = cfg["items"] if isinstance(cfg, dict) else cfg
        target = cfg.get("to") if isinstance(cfg, dict) else None
        X = self.X
        cx = 132
        top = self.spec.get("top", 108)
        last = self.spec["layers"][-1]
        ys = self.side_ys(items, top, last["_y"])
        col = X - 30
        for y, it in zip(ys, items):
            m = it.get("mark", {"icon": "doc"})
            if "logo" in m:
                self.logo(m["logo"], cx - m.get("w", 40) / 2, y - 46, m.get("w", 40), m.get("h", 30))
            else:
                self.icon(m["icon"], cx, y - 32, PAL[m.get("color", "gray")]["key"])
            self.t(cx, y - 1, it["title"], 13.5, INK, "bold", "middle")
            if "step" in it:
                self.badge(cx - 62, y - 44, it["step"])
            if it.get("sub"):
                self.t(cx, y + 17, it["sub"], 11.5, SUB, "middle")
            self.line([(cx + 76, y - 30), (col, y - 30)], dash="5 4", head_end=False)
        tg = self.geo[target] if target else self.geo[self.spec["layers"][0].get("id", "_0")]
        ty = tg[1] + min(35, tg[3] / 2)
        y_top = min(min(ys) - 30, ty) - 8
        y_bot = max(ys) - 30
        self.line([(col, y_top), (col, y_bot)], dash="5 4", head_end=False)
        self.line([(col, ty), (tg[0] - 2, ty)])

    def outputs(self, cfg):
        items = cfg["items"] if isinstance(cfg, dict) else cfg
        X, CW = self.X, self.CW
        cx = 1150
        top = self.spec.get("top", 108)
        last = self.spec["layers"][-1]
        ys = self.side_ys(items, top, last["_y"])
        for y, it in zip(ys, items):
            m = it.get("mark", {"icon": "doc"})
            if "logo" in m:
                w, h = m.get("w", 100), m.get("h", 30)
                self.logo(m["logo"], cx - w / 2, y - 52, w, h)
            else:
                self.icon(m["icon"], cx, y - 35, PAL[m.get("color", "gray")]["key"])
            self.t(cx, y - 1, it["title"], 13.5, INK, "bold", "middle")
            if "step" in it:
                self.badge(cx + 68 if "logo" in m else cx - 62, y - 44, it["step"])
            if it.get("sub"):
                self.t(cx, y + 17, it["sub"], 11.5, SUB, "middle")
            if it.get("from"):
                g = self.geo[it["from"]]
                sy = g[1] + g[3] / 2
                ex = X + CW + 30
                ty = y - 37 if "logo" in m else y - 30
                self.line([(g[0] + g[2] + 2, sy), (ex, sy), (ex, ty), (cx - 64, ty)])
                if it.get("label"):
                    self.t(ex + 6, sy + it.get("label_dy", -14), it["label"], 11.5, SUB)
            else:
                self.line([(X + CW + 16, y - 30), (cx - 60, y - 30)], dash="5 4", head_end=False)

    def callout(self, cal, y):
        X, CW = self.X, self.CW
        a = PAL[cal.get("color", "amber")]
        lines = cal["text"] if isinstance(cal["text"], list) else [cal["text"]]
        o = self.out
        o.append(f'<rect x="{X}" y="{y}" width="{CW}" height="56" rx="10" fill="{a["fill"]}" '
                 f'stroke="{a["line"]}" stroke-width="1.5" stroke-dasharray="6 4"/>'
                 f'<circle cx="{X + 32}" cy="{y + 28}" r="14" fill="{a["key"]}"/>')
        self.t(X + 32, y + 34, "!", 17, WHITE, "bold", "middle")
        if len(lines) == 1:
            self.t(X + 60, y + 34, lines[0], 14, a["text"], "bold")
        else:
            self.t(X + 60, y + 25, lines[0], 14, a["text"], "bold")
            self.t(X + 60, y + 46, lines[1], 14, a["text"], "bold")
        if len(lines) > 2:
            warn("callout: only 2 lines are drawn")


def main():
    ap = argparse.ArgumentParser(description="JSON 仕様からレイヤー構成のアーキテクチャ図を作る")
    ap.add_argument("spec")
    ap.add_argument("-o", "--out", default="layered.svg")
    ap.add_argument("--png")
    ap.add_argument("--scale", type=float, default=2.0)
    a = ap.parse_args()
    with open(a.spec, encoding="utf-8") as fp:
        spec = json.load(fp)
    d = Diagram(spec, os.path.dirname(os.path.abspath(a.spec)))
    svg = d.build()
    if d.H > 720:
        warn(f"height {d.H:.0f}px exceeds 720 (16:9). 層の高さや数を減らす")
    with open(a.out, "w", encoding="utf-8") as fp:
        fp.write(svg)
    print("wrote", a.out)
    if a.png:
        import cairosvg
        cairosvg.svg2png(bytestring=svg.replace(FONT, PNG_FONT).encode("utf-8"),
                         write_to=a.png, scale=a.scale, background_color="white")
        print("wrote", a.png)


if __name__ == "__main__":
    main()
