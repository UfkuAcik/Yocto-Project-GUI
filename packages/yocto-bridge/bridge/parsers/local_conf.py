"""Lossless comment- and multiline-preserving BitBake .conf parser & editor."""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

_DIRECTIVE_RE = re.compile(r"^(\s*)(require|include|INHERIT|inherit)\b(.*)$")
_ASSIGN_START_RE = re.compile(
    r"^(\s*)([A-Za-z0-9_:${}.+-]+)\s*(\?\?=|\?=|:=|\+=|=\+|\.=|=\.|=)\s*(.*)$"
)
_BBLAYERS_ITEM_RE = re.compile(r"\S+")


@dataclass
class BlankNode:
    raw: str

    def render(self) -> str:
        return self.raw


@dataclass
class CommentNode:
    raw: str

    def render(self) -> str:
        return self.raw


@dataclass
class DirectiveNode:
    raw: str
    keyword: str
    argument: str

    def render(self) -> str:
        return self.raw


@dataclass
class AssignmentNode:
    raw_lines: list[str]
    indent: str
    key: str
    operator: str
    raw_value: str
    inline_comment: str = ""
    is_multiline: bool = False

    def render(self) -> str:
        return "\n".join(self.raw_lines)

    def unquoted_value(self) -> str:
        val = self.raw_value.strip()
        if len(val) >= 2 and (
            (val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'")
        ):
            val = val[1:-1]
        # Collapse line-continuation backslashes cleanly
        val = re.sub(r"\\\s*\n\s*", " ", val)
        return " ".join(val.split())

    def set_value(self, new_value: str, operator: str | None = None) -> None:
        if operator:
            self.operator = operator
        escaped = new_value.replace('"', '\\"')
        comment_suffix = f" {self.inline_comment}" if self.inline_comment else ""
        self.raw_value = f'"{escaped}"'
        self.is_multiline = False
        self.raw_lines = [f"{self.indent}{self.key} {self.operator} {self.raw_value}{comment_suffix}"]


@dataclass
class RawNode:
    raw: str

    def render(self) -> str:
        return self.raw


ConfNode = BlankNode | CommentNode | DirectiveNode | AssignmentNode | RawNode


def _split_value_and_inline_comment(text: str) -> tuple[str, str]:
    in_double = False
    in_single = False
    escaped = False
    for idx, ch in enumerate(text):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and (in_double or in_single):
            escaped = True
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "'" and not in_double:
            in_single = not in_single
        elif ch == "#" and not in_double and not in_single:
            return text[:idx].rstrip(), text[idx:]
    return text.rstrip(), ""


def _continues_next_line(line: str) -> bool:
    stripped = line.rstrip()
    return stripped.endswith("\\") and not stripped.endswith("\\\\")


@dataclass
class ConfDocument:
    nodes: list[ConfNode] = field(default_factory=list)
    trailing_newline: bool = True

    def render(self) -> str:
        body = "\n".join(node.render() for node in self.nodes)
        if self.trailing_newline and (body or self.nodes):
            return body + "\n"
        return body

    def clone(self) -> ConfDocument:
        return parse_conf(self.render())

    @property
    def comments_count(self) -> int:
        return sum(1 for n in self.nodes if isinstance(n, CommentNode))

    @property
    def directives(self) -> list[str]:
        return [f"{n.keyword} {n.argument}".strip() for n in self.nodes if isinstance(n, DirectiveNode)]

    @property
    def multiline_keys(self) -> list[str]:
        return [
            n.key for n in self.nodes if isinstance(n, AssignmentNode) and n.is_multiline
        ]

    def get_variables(self) -> dict[str, str]:
        result: dict[str, str] = {}
        for node in self.nodes:
            if isinstance(node, AssignmentNode):
                result[node.key] = node.unquoted_value()
        return result

    def set_variable(self, key: str, value: str, operator: str | None = None) -> None:
        # Update the last occurrence if present (BitBake last-wins semantics for same op)
        for node in reversed(self.nodes):
            if isinstance(node, AssignmentNode) and node.key == key:
                node.set_value(value, operator=operator)
                return

        op = operator or ("=" if ":append" in key or ":prepend" in key else "?=")
        marker = "# Managed by Yocto Studio"
        has_marker = any(isinstance(n, CommentNode) and marker in n.raw for n in self.nodes)
        if not has_marker:
            if self.nodes and not isinstance(self.nodes[-1], BlankNode):
                self.nodes.append(BlankNode(""))
            self.nodes.append(CommentNode(marker))

        escaped = value.replace('"', '\\"')
        line = f'{key} {op} "{escaped}"'
        self.nodes.append(
            AssignmentNode(
                raw_lines=[line],
                indent="",
                key=key,
                operator=op,
                raw_value=f'"{escaped}"',
            )
        )

    def remove_variable(self, key: str) -> bool:
        removed = False
        kept: list[ConfNode] = []
        for node in self.nodes:
            if isinstance(node, AssignmentNode) and node.key == key:
                removed = True
                continue
            kept.append(node)
        self.nodes = kept
        return removed

    def get_bblayers(self) -> list[str]:
        for node in reversed(self.nodes):
            if isinstance(node, AssignmentNode) and node.key == "BBLAYERS":
                val = node.unquoted_value()
                return _BBLAYERS_ITEM_RE.findall(val)
        return []

    def _set_bblayers(self, layers: list[str]) -> None:
        if not layers:
            formatted = ['BBLAYERS ?= ""']
        elif len(layers) == 1:
            formatted = [f'BBLAYERS ?= " {layers[0]} "']
        else:
            formatted = ['BBLAYERS ?= " \\']
            for lyr in layers:
                formatted.append(f"  {lyr} \\")
            formatted.append('  "')

        for node in reversed(self.nodes):
            if isinstance(node, AssignmentNode) and node.key == "BBLAYERS":
                node.raw_lines = formatted
                node.raw_value = "\n".join(formatted).split(node.operator, 1)[1].strip()
                node.is_multiline = len(formatted) > 1
                return

        self.nodes.append(
            AssignmentNode(
                raw_lines=formatted,
                indent="",
                key="BBLAYERS",
                operator="?=",
                raw_value="\n".join(formatted).split("?=", 1)[1].strip(),
                is_multiline=len(formatted) > 1,
            )
        )

    def add_bblayer(self, path: str) -> bool:
        layers = self.get_bblayers()
        if path in layers:
            return False
        layers.append(path)
        self._set_bblayers(layers)
        return True

    def remove_bblayer(self, path: str) -> bool:
        layers = self.get_bblayers()
        if path not in layers:
            return False
        layers = [x for x in layers if x != path]
        self._set_bblayers(layers)
        return True

    def unified_diff(self, other: ConfDocument, filename: str = "conf/local.conf") -> str:
        return "".join(
            difflib.unified_diff(
                self.render().splitlines(keepends=True),
                other.render().splitlines(keepends=True),
                fromfile=f"a/{filename}",
                tofile=f"b/{filename}",
            )
        )


def parse_conf(text: str) -> ConfDocument:
    """Parse BitBake .conf source into lossless AST nodes."""
    trailing_newline = text.endswith("\n")
    lines = text.splitlines()
    nodes: list[ConfNode] = []

    i = 0
    total = len(lines)
    while i < total:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            nodes.append(BlankNode(line))
            i += 1
            continue

        if stripped.startswith("#"):
            nodes.append(CommentNode(line))
            i += 1
            continue

        dir_match = _DIRECTIVE_RE.match(line)
        if dir_match:
            nodes.append(
                DirectiveNode(
                    raw=line,
                    keyword=dir_match.group(2),
                    argument=dir_match.group(3).strip(),
                )
            )
            i += 1
            continue

        assign_match = _ASSIGN_START_RE.match(line)
        if assign_match:
            indent, key, op, rest = assign_match.groups()
            raw_lines = [line]
            val_parts: list[str] = []
            inline_comment = ""

            if _continues_next_line(line):
                val_parts.append(rest)
                j = i + 1
                while j < total:
                    cont = lines[j]
                    raw_lines.append(cont)
                    if _continues_next_line(cont):
                        val_parts.append(cont)
                        j += 1
                    else:
                        v_tail, inline_comment = _split_value_and_inline_comment(cont)
                        val_parts.append(v_tail)
                        j += 1
                        break
                i = j
                nodes.append(
                    AssignmentNode(
                        raw_lines=raw_lines,
                        indent=indent,
                        key=key,
                        operator=op,
                        raw_value="\n".join(val_parts),
                        inline_comment=inline_comment,
                        is_multiline=True,
                    )
                )
            else:
                v_clean, inline_comment = _split_value_and_inline_comment(rest)
                nodes.append(
                    AssignmentNode(
                        raw_lines=raw_lines,
                        indent=indent,
                        key=key,
                        operator=op,
                        raw_value=v_clean,
                        inline_comment=inline_comment,
                        is_multiline=False,
                    )
                )
                i += 1
            continue

        nodes.append(RawNode(line))
        i += 1

    return ConfDocument(nodes=nodes, trailing_newline=trailing_newline)
