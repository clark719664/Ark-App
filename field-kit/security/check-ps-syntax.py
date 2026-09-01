#!/usr/bin/env python3
"""Structural syntax checker for PowerShell (.ps1) files.

pwsh is not installed in the field-kit dev environment, so we cannot run
PowerShell's own parser. This checker approximates it: it tokenizes each
script into strings / comments / code so that brackets inside strings are
NOT miscounted, then verifies:

  * balanced { } ( ) [ ]
  * balanced here-strings  @" ... "@  and  @' ... '@
  * a param(...) block is present
  * a [CmdletBinding()] attribute is present

It is a lint, not a full parser. It cannot catch every error, but it
reliably catches the unbalanced-bracket / unterminated-string / unterminated
here-string class of mistakes that are easy to introduce when authoring
PowerShell without a shell to run it in.

Usage:
    python3 check-ps-syntax.py FILE.ps1 [FILE2.ps1 ...]
    python3 check-ps-syntax.py           # checks every .ps1 next to this file

Exit code 0 = all files pass, 1 = at least one problem found.
"""

import sys
from pathlib import Path

PAIRS = {")": "(", "]": "[", "}": "{"}
OPENERS = set(PAIRS.values())


def tokenize_check(text):
    """Walk the source tracking string / comment / here-string state.

    Returns (errors, code_chars) where code_chars is the source with all
    string and comment content blanked out (kept as spaces / newlines) so a
    later bracket scan only sees real code.
    """
    errors = []
    out = []
    i = 0
    n = len(text)
    line = 1

    # State flags
    in_line_comment = False
    in_block_comment = False   # <# ... #>
    in_sq = False              # '...'
    in_dq = False              # "..."
    in_here_sq = False         # @' ... '@
    in_here_dq = False         # @" ... "@

    at_line_start_ws = True     # only whitespace seen so far on this line

    def blank(ch):
        out.append("\n" if ch == "\n" else " ")

    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        # ---- here-string terminators (must be at start of a line) ----
        if in_here_dq:
            if at_line_start_ws and ch == '"' and nxt == "@":
                in_here_dq = False
                blank(ch); blank(nxt)
                i += 2
                at_line_start_ws = False
                continue
            if ch == "\n":
                line += 1
                at_line_start_ws = True
            else:
                at_line_start_ws = at_line_start_ws and ch in " \t"
            blank(ch)
            i += 1
            continue

        if in_here_sq:
            if at_line_start_ws and ch == "'" and nxt == "@":
                in_here_sq = False
                blank(ch); blank(nxt)
                i += 2
                at_line_start_ws = False
                continue
            if ch == "\n":
                line += 1
                at_line_start_ws = True
            else:
                at_line_start_ws = at_line_start_ws and ch in " \t"
            blank(ch)
            i += 1
            continue

        # ---- line comment ----
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
                line += 1
                at_line_start_ws = True
                out.append("\n")
            else:
                blank(ch)
            i += 1
            continue

        # ---- block comment <# ... #> ----
        if in_block_comment:
            if ch == "#" and nxt == ">":
                in_block_comment = False
                blank(ch); blank(nxt)
                i += 2
                continue
            if ch == "\n":
                line += 1
            blank(ch)
            i += 1
            continue

        # ---- single-quoted string ----
        if in_sq:
            if ch == "'":
                if nxt == "'":       # '' escaped quote inside single-quoted
                    blank(ch); blank(nxt)
                    i += 2
                    continue
                in_sq = False
                blank(ch)
                i += 1
                continue
            if ch == "\n":
                line += 1
            blank(ch)
            i += 1
            continue

        # ---- double-quoted string ----
        if in_dq:
            if ch == "`":            # backtick escape: skip next char
                blank(ch)
                if nxt:
                    blank(nxt)
                    i += 2
                else:
                    i += 1
                continue
            if ch == '"':
                if nxt == '"':       # "" escaped quote
                    blank(ch); blank(nxt)
                    i += 2
                    continue
                in_dq = False
                blank(ch)
                i += 1
                continue
            if ch == "\n":
                line += 1
            blank(ch)
            i += 1
            continue

        # ---- not currently inside any string/comment ----
        # here-string openers: @" or @' followed by end-of-line
        if ch == "@" and nxt in ('"', "'"):
            rest = text[i + 2:]
            # what remains on this line after @" must be only whitespace
            eol = rest.split("\n", 1)[0]
            if eol.strip() == "":
                if nxt == '"':
                    in_here_dq = True
                else:
                    in_here_sq = True
                blank(ch); blank(nxt)
                i += 2
                at_line_start_ws = False
                continue

        if ch == "<" and nxt == "#":
            in_block_comment = True
            blank(ch); blank(nxt)
            i += 2
            continue

        if ch == "#":
            in_line_comment = True
            blank(ch)
            i += 1
            continue

        if ch == "'":
            in_sq = True
            blank(ch)
            i += 1
            at_line_start_ws = False
            continue

        if ch == '"':
            in_dq = True
            blank(ch)
            i += 1
            at_line_start_ws = False
            continue

        if ch == "`":               # backtick line-continuation / escape in code
            out.append(" ")
            if nxt:
                out.append(" " if nxt != "\n" else "\n")
                if nxt == "\n":
                    line += 1
                i += 2
            else:
                i += 1
            continue

        # ordinary code character
        if ch == "\n":
            line += 1
            at_line_start_ws = True
            out.append("\n")
        else:
            if ch not in " \t":
                at_line_start_ws = False
            out.append(ch)
        i += 1

    # Unterminated states
    if in_sq:
        errors.append("unterminated single-quoted string")
    if in_dq:
        errors.append("unterminated double-quoted string")
    if in_block_comment:
        errors.append("unterminated block comment <# ... #>")
    if in_here_dq:
        errors.append('unterminated here-string @" ... "@')
    if in_here_sq:
        errors.append("unterminated here-string @' ... '@")

    return errors, "".join(out)


def check_brackets(code):
    """Balance-check brackets on code with strings/comments blanked out."""
    errors = []
    stack = []
    line = 1
    for ch in code:
        if ch == "\n":
            line += 1
            continue
        if ch in OPENERS:
            stack.append((ch, line))
        elif ch in PAIRS:
            if not stack:
                errors.append(f"line {line}: unexpected closing '{ch}'")
                continue
            opener, oline = stack.pop()
            if opener != PAIRS[ch]:
                errors.append(
                    f"line {line}: closing '{ch}' does not match "
                    f"'{opener}' opened on line {oline}")
    for opener, oline in stack:
        errors.append(f"line {oline}: unclosed '{opener}'")
    return errors


def check_file(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    problems = []

    token_errors, code = tokenize_check(text)
    problems.extend(token_errors)
    problems.extend(check_brackets(code))

    # Required structural elements (search in blanked code so matches in
    # comments/strings do not count).
    low = code.lower()
    if "param(" not in low.replace(" ", "").replace("\t", ""):
        # allow "param (" with space
        if "param(" not in low and "param (" not in low:
            problems.append("no param(...) block found")
    if "[cmdletbinding(" not in low.replace(" ", ""):
        problems.append("no [CmdletBinding()] attribute found")

    return problems


def main(argv):
    if argv:
        files = [Path(a) for a in argv]
    else:
        here = Path(__file__).resolve().parent
        files = sorted(here.glob("*.ps1"))

    if not files:
        print("No .ps1 files to check.")
        return 0

    any_fail = False
    for f in files:
        if not f.exists():
            print(f"MISSING  {f}")
            any_fail = True
            continue
        problems = check_file(f)
        if problems:
            any_fail = True
            print(f"FAIL     {f.name}")
            for p in problems:
                print(f"           - {p}")
        else:
            print(f"OK       {f.name}")
    print()
    if any_fail:
        print("Result: PROBLEMS FOUND")
        return 1
    print("Result: all files pass structural checks")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
