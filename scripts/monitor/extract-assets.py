#!/usr/bin/env python3

import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Optional, Set, Tuple
from urllib.parse import SplitResult, urldefrag, urljoin, urlsplit


class MonitorInputError(ValueError):
    pass


def _has_c0_or_del(value: str) -> bool:
    return any(
        ord(character) < 0x20 or ord(character) == 0x7F
        for character in value
    )


def _format_external_value(value: str, limit: int = 160) -> str:
    escaped = value.encode("unicode_escape").decode("ascii")
    if len(escaped) <= limit:
        return escaped
    return escaped[: limit - 3] + "..."


def validate_page_url(value: str) -> SplitResult:
    if not value or any(character.isspace() for character in value):
        raise MonitorInputError("URL 无效：地址为空或包含空白字符。")
    if "\\" in value or _has_c0_or_del(value):
        raise MonitorInputError("URL 无效：地址包含反斜杠或控制字符。")

    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
        parsed.port
    except (UnicodeError, ValueError) as error:
        raise MonitorInputError("URL 无效：地址格式或端口不合法。") from error

    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise MonitorInputError("URL 无效：只允许完整的 HTTP(S) 地址。")
    if username is not None or password is not None:
        raise MonitorInputError("URL 无效：地址不能包含用户名或密码。")
    if "#" in value:
        raise MonitorInputError("URL 无效：地址不能包含 fragment。")
    return parsed


def origin(parsed: SplitResult) -> Tuple[str, str, int]:
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    port = parsed.port if parsed.port is not None else default_port
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.has_app_mount = False
        self.has_base_href = False
        self.module_sources: List[str] = []
        self.stylesheet_sources: List[str] = []

    def handle_starttag(
        self, tag: str, attributes: List[Tuple[str, Optional[str]]]
    ) -> None:
        values = {}
        for name, value in attributes:
            values.setdefault(name.lower(), value)

        if values.get("id") == "app":
            self.has_app_mount = True
        if tag.lower() == "base" and "href" in values:
            self.has_base_href = True

        if tag.lower() == "script":
            script_type = (values.get("type") or "").strip().lower()
            source = values.get("src")
            if script_type == "module" and source:
                self.module_sources.append(source)

        if tag.lower() == "link":
            relations = {
                relation.lower()
                for relation in (values.get("rel") or "").split()
            }
            source = values.get("href")
            if "stylesheet" in relations and source:
                self.stylesheet_sources.append(source)


def resolve_asset(
    page_url: str, page_origin: Tuple[str, str, int], value: str
) -> str:
    if any(character.isspace() for character in value):
        raise MonitorInputError("资源不是同源 HTTP(S) URL：包含空白字符。")
    if "\\" in value or _has_c0_or_del(value):
        raise MonitorInputError(
            "资源不是同源 HTTP(S) URL："
            f"{_format_external_value(value)}"
        )

    try:
        resolved, _fragment = urldefrag(urljoin(page_url, value))
        parsed = validate_page_url(resolved)
    except (UnicodeError, ValueError) as error:
        raise MonitorInputError(
            "资源不是同源 HTTP(S) URL："
            f"{_format_external_value(value)}"
        ) from error

    if origin(parsed) != page_origin:
        raise MonitorInputError(
            "资源不是同源 HTTP(S) URL："
            f"{_format_external_value(resolved)}"
        )
    return resolved


def extract_assets(page_url: str, html_path: Path) -> List[str]:
    parsed_page = validate_page_url(page_url)
    parser = AssetParser()
    parser.feed(html_path.read_text(encoding="utf-8"))
    parser.close()

    if parser.has_base_href:
        raise MonitorInputError(
            "HTML 包含 base href，无法按浏览器语义安全解析资源。"
        )
    if not parser.has_app_mount:
        raise MonitorInputError('HTML 缺少 Vue 挂载点 id="app"。')
    if not parser.module_sources:
        raise MonitorInputError("HTML 没有可巡检的模块脚本。")
    if not parser.stylesheet_sources:
        raise MonitorInputError("HTML 没有可巡检的样式表。")

    page_origin = origin(parsed_page)
    ordered_sources = parser.stylesheet_sources + parser.module_sources
    assets: List[str] = []
    seen: Set[str] = set()
    for source in ordered_sources:
        resolved = resolve_asset(page_url, page_origin, source)
        if resolved not in seen:
            seen.add(resolved)
            assets.append(resolved)
    return assets


def main(arguments: List[str]) -> int:
    try:
        if len(arguments) == 3 and arguments[1] == "--validate-url":
            validate_page_url(arguments[2])
            return 0
        if len(arguments) != 3 or arguments[1].startswith("-"):
            raise MonitorInputError(
                "用法：extract-assets.py --validate-url URL，"
                "或 extract-assets.py PAGE_URL HTML_FILE"
            )

        for asset in extract_assets(arguments[1], Path(arguments[2])):
            print(asset)
        return 0
    except (MonitorInputError, OSError, UnicodeError) as error:
        print(f"HTML 资源解析失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
