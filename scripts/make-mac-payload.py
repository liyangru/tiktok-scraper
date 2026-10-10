#!/usr/bin/env python3
"""
把 macOS 的 Chrome for Testing zip 转成 tar.gz 载荷（供打包进 app）。

为什么要转换、而不是直接解压再压缩：
  Windows 上无法可靠地创建符号链接（需要管理员权限），而 macOS 的 .app
  bundle 里 Framework 的 Versions/Current 等就是符号链接 —— 一旦丢失，
  app 在 mac 上直接起不来。
  这里直接在 zip → tar 之间做流式转换：不落盘、原样保留
  「符号链接 + 可执行权限位」，因此可以在 Windows 上产出正确的 mac 载荷。

用法:
  python make-mac-payload.py <chrome-mac-XXX.zip> <out.tar.gz> <prefix>
例:
  python make-mac-payload.py _macdl/chrome-mac-arm64.zip browser-payload-mac-arm64.tar.gz chromium-1248/chrome-mac-arm64
"""
import io
import stat
import sys
import tarfile
import zipfile


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2

    src, dst, prefix = sys.argv[1], sys.argv[2], sys.argv[3].strip("/")
    symlinks = 0
    files = 0
    dirs = 0
    total = 0

    with zipfile.ZipFile(src) as zf, tarfile.open(dst, "w:gz", compresslevel=6) as tf:
        for zi in zf.infolist():
            name = zi.filename.rstrip("/")
            if not name:
                continue
            mode = (zi.external_attr >> 16) & 0xFFFF
            tar_name = f"{prefix}/{name}"

            # 目录
            if zi.is_dir() or stat.S_ISDIR(mode):
                ti = tarfile.TarInfo(tar_name)
                ti.type = tarfile.DIRTYPE
                ti.mode = (mode & 0o7777) or 0o755
                tf.addfile(ti)
                dirs += 1
                continue

            # 符号链接：内容就是目标路径
            if stat.S_ISLNK(mode):
                ti = tarfile.TarInfo(tar_name)
                ti.type = tarfile.SYMTYPE
                ti.linkname = zf.read(zi).decode("utf-8")
                ti.mode = 0o777
                tf.addfile(ti)
                symlinks += 1
                continue

            # 普通文件：流式拷贝，避免一次性读进内存
            with zf.open(zi) as fp:
                ti = tarfile.TarInfo(tar_name)
                ti.type = tarfile.REGTYPE
                ti.size = zi.file_size
                ti.mode = (mode & 0o7777) or 0o644
                tf.addfile(ti, fp)
            files += 1
            total += zi.file_size

    print(
        f"[payload] {dst}  文件 {files} / 目录 {dirs} / 符号链接 {symlinks}  "
        f"解压后约 {total / 1048576:.0f} MB"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
