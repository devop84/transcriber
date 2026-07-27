#!/usr/bin/env python3
"""Download a faster-whisper model into a Hugging Face hub cache with NDJSON progress."""

from __future__ import annotations

import json
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {
                    "type": "error",
                    "message": "Usage: download_model.py <hub_cache_dir> <repo_id>",
                }
            ),
            flush=True,
        )
        return 2

    cache_dir = sys.argv[1]
    repo_id = sys.argv[2]

    try:
        from huggingface_hub import snapshot_download
        from tqdm.auto import tqdm
    except ImportError as exc:
        print(json.dumps({"type": "error", "message": str(exc)}), flush=True)
        return 1

    class ProgressTqdm(tqdm):
        def update(self, n=1):
            super().update(n)
            total = self.total or 0
            cur = self.n or 0
            pct = (100.0 * cur / total) if total else 0.0
            print(
                json.dumps(
                    {"type": "progress", "n": cur, "total": total, "percent": pct}
                ),
                flush=True,
            )

    print(json.dumps({"type": "start", "repo": repo_id}), flush=True)
    try:
        path = snapshot_download(
            repo_id,
            cache_dir=cache_dir,
            allow_patterns=[
                "config.json",
                "preprocessor_config.json",
                "model.bin",
                "tokenizer.json",
                "vocabulary.*",
            ],
            tqdm_class=ProgressTqdm,
        )
    except Exception as exc:
        print(json.dumps({"type": "error", "message": str(exc)}), flush=True)
        return 1

    print(json.dumps({"type": "done", "path": path}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
