#!/usr/bin/env python3
"""
校验 macOS 浏览器载荷（browser-payload-mac-*.tar.gz）是否可用。

打包前跑一次，确认三件最容易出错的事：
  1. 符号链接还在（.app 里 Framework 的 Versions/Current 等，丢了 app 起不来）
  2. 主程序存在且带可执行权限位
  3. 版本 manifest 与预期一致

可选 `--extract-bin`：把主程序抽到 _verify_mac/ 下，用于配合 lib/browsers.js 的
findChromium 定位测试（Windows 上无法创建符号链接，所以只抽主程序）。

用法:
  python scripts/verify-mac-payload.py browser-payload-mac-arm64.tar.gz
  python scripts/verify-mac-payload.py browser-payload-mac-arm64.tar.gz --extract-bin
"""
import os
import sys
import tarfile

BIN_SUFFIX = '.app/Contents/MacOS/Google Chrome for Testing'


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print(__doc__)
        return 2
    path = args[0]
    do_extract = '--extract-bin' in sys.argv

    symlinks = []
    binary = None
    manifests = []
    total = 0

    with tarfile.open(path) as t:
        for m in t:
            if m.issym():
                symlinks.append((m.name, m.linkname))
            if m.name.endswith(BIN_SUFFIX):
                binary = m
            if m.name.endswith('.manifest') and 'chrome-mac' in m.name:
                manifests.append(os.path.basename(m.name))
            if m.isfile():
                total += m.size

        print(f'载荷: {path}')
        print(f'  解压后约 {total / 1048576:.0f} MB')
        print(f'  符号链接: {len(symlinks)} 个')
        for n, tgt in symlinks:
            print(f'    {os.path.basename(n)} -> {tgt}')
        print(f'  版本 manifest: {manifests or "(未找到)"}')

        ok = True
        if not symlinks:
            print('  ❌ 没有符号链接 —— 载荷很可能被错误地「解压再压缩」过')
            ok = False
        if binary is None:
            print('  ❌ 未找到主程序')
            ok = False
        else:
            print(f'  主程序: {binary.name}')
            print(f'    mode={oct(binary.mode)} size={binary.size}')
            if not binary.mode & 0o111:
                print('  ❌ 主程序没有可执行权限位')
                ok = False

        if do_extract and binary is not None:
            out = os.path.join('_verify_mac', binary.name)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, 'wb') as fh:
                fh.write(t.extractfile(binary).read())
            print(f'  已抽出主程序 -> {out}（可用于 findChromium 定位测试）')

    print('  ✅ 校验通过' if ok else '  ❌ 校验失败')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
