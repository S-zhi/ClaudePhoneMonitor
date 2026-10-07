"""Private launcher preference; never contains transcript data or credentials."""

import argparse
import os
from pathlib import Path
import stat
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--feature", choices=("usage", "codex"), default="usage")
    parser.add_argument("--write", choices=("0", "1"))
    args = parser.parse_args()
    preference = Path(args.state_dir) / (args.feature + ".preference")
    try:
        try:
            metadata = preference.lstat()
        except FileNotFoundError:
            metadata = None
        if metadata is not None and not stat.S_ISREG(metadata.st_mode):
            raise ValueError("unsafe preference")
        if args.write is None:
            if metadata is None:
                return
            descriptor = os.open(preference, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor) as source:
                value = source.read(3).strip()
                if value not in ("0", "1") or source.read(1):
                    raise ValueError("invalid preference")
            print(value)
            return
        descriptor, temporary = tempfile.mkstemp(prefix="." + args.feature + "-preference-", dir=preference.parent)
        try:
            with os.fdopen(descriptor, "w") as destination:
                destination.write(args.write + "\n")
                destination.flush()
                os.fsync(destination.fileno())
            os.replace(temporary, preference)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    except (OSError, ValueError):
        print(args.feature + "_preference_unavailable: cannot safely read or save the private "
              + args.feature.capitalize() + " preference.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
