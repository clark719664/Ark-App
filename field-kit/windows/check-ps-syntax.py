#!/usr/bin/env python3
"""Structural syntax checker for Ark Field Kit PowerShell scripts.

pwsh is not installed in the build environment, so this performs a best-effort
STRUCTURAL validation of every .ps1 it is given:

  * balanced braces {}, parens (), and brackets []
  * balanced here-strings ( @" ... "@  and  @' ... '@ )
  * a param(...) block is present (skippable per file)
  * a [CmdletBinding(...)] attribute is present (skippable per file)

It does this with a small state machine that skips PowerShell comments and
string literals so that brackets *inside* strings/comments don't cause false
positives. Standard library only.

Usage:
    python3 check-ps-syntax.py file1.ps1 [file2.ps1 ...]
    python3 check-ps-syntax.py            # checks every .ps1 next to this file

Exit code 0 = all files pass, 1 = at least one failure.
"""

import sys
from pathlib import Path

# Files that are legitimately allowed to lack param()/[CmdletBinding()]
# (dot-sourced helper libraries, not entry-point scripts).
NO_PARAM_REQUIRED = {"_FieldKit.ps1"}
NO_CMDLETBINDING_REQUIRED = {"_FieldKit.ps1"}

PAIRS = {")": "(", "]": "[", "}": "{"}
OPENERS = set(PAIRS.values())
CLOSERS = set(PAIRS.keys())
# Characters after which a bare '#' starts a comment (token boundary).
COMMENT_PREV_OK = set(" \t\r\n;({[|&,=+")


def line_col(text, idx):
    """Return 1-based (line, col) for a character offset."""
    line = text.count("\n", 0, idx) + 1
    col = idx - (text.rfind("\n", 0, idx))
    return line, col


def scan(text):
    """Walk the source, returning (errors, opener_stack_leftovers).

    errors is a list of human-readable strings. Skips comments and strings so
    only *code* brackets are counted.
    """
    errors = []
    stack = []  # (char, index) of unmatched openers
    i = 0
    n = len(text)
    at_line_start = True  # True when no non-whitespace seen yet on this line

    while i < n:
        c = text[i]
        prev = text[i - 1] if i > 0 else "\n"

        # --- here-strings: must open with @" or @' followed by end-of-line ---
        if c == "@" and i + 1 < n and text[i + 1] in ("\"", "'"):
            quote = text[i + 1]
            # Look at the remainder of this physical line after @" / @'
            eol = text.find("\n", i + 2)
            if eol == -1:
                eol = n
            tail = text[i + 2:eol].strip()
            if tail == "":
                # Valid here-string opener. Find the terminator: a line whose
                # first two chars are  "@  (or  '@ ) at column 0.
                term = quote + "@"
                j = eol + 1
                closed = False
                while j <= n:
                    nl = text.find("\n", j)
                    if nl == -1:
                        nl = n
                    line_txt = text[j:nl]
                    if line_txt[:2] == term:
                        i = j + 2  # consume the terminator
                        closed = True
                        break
                    j = nl + 1
                if not closed:
                    ln, col = line_col(text, i)
                    errors.append(
                        f"unterminated here-string opened at line {ln} col {col} "
                        f"(expected a line starting with {term!r})"
                    )
                    return errors, stack
                at_line_start = True
                continue
            # else: @" not at end of line -> not a here-string, fall through

        # --- block comment <# ... #> ---
        if c == "<" and i + 1 < n and text[i + 1] == "#":
            end = text.find("#>", i + 2)
            if end == -1:
                ln, col = line_col(text, i)
                errors.append(f"unterminated block comment <# at line {ln} col {col}")
                return errors, stack
            i = end + 2
            at_line_start = False
            continue

        # --- line comment # ... (only when '#' is at a token boundary) ---
        if c == "#" and (at_line_start or prev in COMMENT_PREV_OK):
            nl = text.find("\n", i)
            i = n if nl == -1 else nl
            continue

        # --- double-quoted string ---
        if c == "\"":
            i += 1
            while i < n:
                if text[i] == "`":  # PowerShell escape char
                    i += 2
                    continue
                if text[i] == "\"":
                    i += 1
                    break
                i += 1
            at_line_start = False
            continue

        # --- single-quoted string (escape is doubled '') ---
        if c == "'":
            i += 1
            while i < n:
                if text[i] == "'":
                    if i + 1 < n and text[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            at_line_start = False
            continue

        # --- brackets ---
        if c in OPENERS:
            stack.append((c, i))
        elif c in CLOSERS:
            want = PAIRS[c]
            if not stack:
                ln, col = line_col(text, i)
                errors.append(f"unmatched closing {c!r} at line {ln} col {col}")
            elif stack[-1][0] != want:
                ln, col = line_col(text, i)
                oln, ocol = line_col(text, stack[-1][1])
                errors.append(
                    f"mismatched {c!r} at line {ln} col {col}: "
                    f"innermost opener is {stack[-1][0]!r} at line {oln} col {ocol}"
                )
                stack.pop()
            else:
                stack.pop()

        # track line-start state
        if c == "\n":
            at_line_start = True
        elif c not in (" ", "\t", "\r"):
            at_line_start = False
        i += 1

    return errors, stack


def check_file(path):
    """Return list of problem strings for one file ([] means it passed)."""
    problems = []
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as e:
        return [f"could not read file: {e}"]

    errors, stack = scan(text)
    problems.extend(errors)
    for ch, idx in stack:
        ln, col = line_col(text, idx)
        problems.append(f"unclosed {ch!r} opened at line {ln} col {col}")

    name = path.name
    lowered = text.lower()
    if name not in NO_PARAM_REQUIRED and "param(" not in lowered.replace(" ", ""):
        problems.append("missing a param(...) block")
    if name not in NO_CMDLETBINDING_REQUIRED and "[cmdletbinding" not in lowered:
        problems.append("missing a [CmdletBinding(...)] attribute")
    return problems


def main(argv):
    here = Path(__file__).resolve().parent
    if argv:
        files = [Path(a) for a in argv]
    else:
        files = sorted(here.glob("*.ps1"))
    if not files:
        print("No .ps1 files to check.")
        return 0

    any_fail = False
    for f in files:
        if not f.exists():
            print(f"FAIL  {f}  (file not found)")
            any_fail = True
            continue
        problems = check_file(f)
        if problems:
            any_fail = True
            print(f"FAIL  {f.name}")
            for p in problems:
                print(f"        - {p}")
        else:
            print(f"PASS  {f.name}")
    print()
    print("RESULT:", "ONE OR MORE FILES FAILED" if any_fail else "all files passed")
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
