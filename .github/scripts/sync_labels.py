#!/usr/bin/env python3
"""Synchronize labels declared in .github/label.yaml to a GitHub repository."""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml


NAME_RE = re.compile(r"^(?:state:|action:)(.+)$")
COLOR_RE = re.compile(r"^[0-9a-fA-F]{6}$")
ALLOWED_FIELDS = {"name", "color", "description"}


class ValidationError(ValueError):
    pass


def load_and_validate(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(encoding="utf-8") as stream:
            labels = yaml.safe_load(stream)
    except OSError as exc:
        raise ValidationError(f"无法读取标签文件 {path}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise ValidationError(f"YAML 格式错误: {exc}") from exc

    if not isinstance(labels, list) or not labels:
        raise ValidationError("标签文件顶层必须是非空列表")

    seen: set[str] = set()
    for index, item in enumerate(labels, start=1):
        prefix = f"第 {index} 项"
        if not isinstance(item, dict):
            raise ValidationError(f"{prefix}必须是映射对象")
        unknown = set(item) - ALLOWED_FIELDS
        missing = ALLOWED_FIELDS - set(item)
        if unknown:
            raise ValidationError(f"{prefix}包含不支持的字段: {', '.join(sorted(unknown))}")
        if missing:
            raise ValidationError(f"{prefix}缺少字段: {', '.join(sorted(missing))}")

        name = item["name"]
        color = item["color"]
        description = item["description"]
        if not isinstance(name, str) or not name or name != name.strip():
            raise ValidationError(f"{prefix}的 name 必须是非空字符串，且不能有首尾空格")
        match = NAME_RE.fullmatch(name)
        if not match or not match.group(1).strip():
            raise ValidationError(f"{prefix}的 name 必须以 state: 或 action: 开头，且后缀非空")
        if name in seen:
            raise ValidationError(f"标签名重复: {name}")
        seen.add(name)
        if not isinstance(color, str) or not COLOR_RE.fullmatch(color):
            raise ValidationError(f"{prefix}的 color 必须是六位十六进制颜色值")
        if not isinstance(description, str) or len(description) > 100:
            raise ValidationError(f"{prefix}的 description 必须是字符串且不超过 100 个字符")

    return labels


def main() -> int:
    parser = argparse.ArgumentParser(description="同步 .github/label.yaml 中声明的 GitHub 标签")
    parser.add_argument("--file", type=Path, default=Path(".github/label.yaml"), help="标签 YAML 文件 (默认: .github/label.yaml)")
    parser.add_argument("--repo", default=os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY"), help="目标 owner/repo")
    parser.add_argument("--dry-run", action="store_true", help="只校验并展示命令，不调用 gh 或访问 GitHub")
    args = parser.parse_args()

    try:
        labels = load_and_validate(args.file)
        if not args.repo:
            raise ValidationError("未指定仓库；请通过 --repo 或 GH_REPO 设置 owner/repo")
        if not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repo):
            raise ValidationError("仓库格式必须是 owner/repo")

        for label in labels:
            command = [
                "gh", "label", "create", label["name"], "--repo", args.repo,
                "--color", label["color"], "--description", label["description"], "--force",
            ]
            if args.dry_run:
                print("DRY RUN:", " ".join(repr(part) for part in command))
            else:
                subprocess.run(command, check=True)
                print(f"已同步标签: {label['name']}")
    except ValidationError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"错误: 找不到 GitHub CLI gh: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"错误: gh 执行失败，退出码 {exc.returncode}", file=sys.stderr)
        return exc.returncode or 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
