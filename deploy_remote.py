# -*- coding: utf-8 -*-
"""
一键远程部署到腾讯云服务器（走 SSH，无需在服务器上手动敲命令）

用法:
  python deploy_remote.py <服务器IP> <用户名> <密码>
  例: python deploy_remote.py 1.2.3.4 root MyPass123
  (腾讯云轻量服务器 Ubuntu 默认用户是 ubuntu；CVM 一般是 root)

流程:
  1) 本地打包(排除 node_modules/数据/浏览器)
  2) SFTP 上传
  3) 服务器上解压并执行 tencent-setup.sh（装 Docker → 构建 → 启动）
  4) 自检 /api/health，打印带访问口令的地址
"""
import sys, os, tarfile, time, socket, re
import paramiko

ROOT = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(ROOT, '..', 'tiktok-scraper.tar.gz')
REMOTE_DIR = '/root/tiktok-scraper'

INCLUDE = [
    'Dockerfile', 'docker-compose.yml', 'tencent-setup.sh', 'pack.sh',
    'server.js', 'package.json', 'package-lock.json', 'README.md', 'start.bat',
]
INCLUDE_DIRS = ['lib', 'public']


def pack():
    out = os.path.abspath(BUNDLE)
    if os.path.exists(out):
        os.remove(out)
    with tarfile.open(out, 'w:gz') as tf:
        for f in INCLUDE:
            p = os.path.join(ROOT, f)
            if os.path.exists(p):
                tf.add(p, arcname=f)
        for d in INCLUDE_DIRS:
            p = os.path.join(ROOT, d)
            if os.path.exists(p):
                tf.add(p, arcname=d)
    size = os.path.getsize(out) / 1024 / 1024
    print(f'[1/5] 本地打包完成: {out}  ({size:.1f} MB)')
    return out


def connect(host, user, password):
    print(f'[2/5] 连接 {user}@{host} ...')
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(
        host, port=22, username=user, password=password,
        timeout=25, banner_timeout=25, auth_timeout=25,
        look_for_keys=False, allow_agent=False,
    )
    print('  ✓ 连接成功')
    return cli


def run(cli, cmd, timeout=None, show=True):
    """执行命令并实时打印输出；返回 (exit_code, 全部输出)"""
    tr = cli.get_transport()
    ch = tr.open_session()
    ch.settimeout(timeout)
    ch.exec_command(cmd)
    buf = []
    while True:
        if ch.recv_ready():
            data = ch.recv(4096).decode('utf-8', 'replace')
            buf.append(data)
            if show:
                sys.stdout.write(data)
                sys.stdout.flush()
        if ch.recv_stderr_ready():
            data = ch.recv_stderr(4096).decode('utf-8', 'replace')
            buf.append(data)
            if show:
                sys.stdout.write(data)
                sys.stdout.flush()
        if ch.exit_status_ready() and not ch.recv_ready() and not ch.recv_stderr_ready():
            break
        time.sleep(0.15)
    code = ch.recv_exit_status()
    ch.close()
    return code, ''.join(buf)


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    host, user, password = sys.argv[1], sys.argv[2], sys.argv[3]

    bundle = pack()
    cli = connect(host, user, password)
    try:
        # 环境摸底
        code, osinfo = run(cli, 'uname -srm; cat /etc/os-release | grep PRETTY_NAME; whoami; nproc; free -h | head -2')
        print('\n[3/5] 服务器环境:')
        print(osinfo.strip())
        print()

        # 创建目录并上传
        run(cli, f'mkdir -p {REMOTE_DIR}', show=False)
        print(f'[4/5] 上传到 {REMOTE_DIR} ...')
        sftp = cli.open_sftp()
        sftp.put(bundle, f'{REMOTE_DIR}/bundle.tar.gz')
        print('  ✓ 上传完成')
        sftp.close()

        # 解压
        code, out = run(cli, f'cd {REMOTE_DIR} && tar -xzf bundle.tar.gz && rm -f bundle.tar.gz && ls', show=True)
        if code != 0:
            print('✗ 解压失败'); sys.exit(1)

        # 执行一键部署（装 Docker + 构建 + 启动，可能 5-10 分钟）
        print('\n[5/5] 服务器上开始部署（装 Docker + 构建 Chromium 镜像，请耐心等待）...\n')
        code, out = run(cli, f'cd {REMOTE_DIR} && bash tencent-setup.sh 2>&1', timeout=None, show=True)

        # 读取访问口令
        code, envout = run(cli, f'cat {REMOTE_DIR}/.env 2>/dev/null', show=False)
        token = ''
        m = re.search(r'ACCESS_TOKEN=(.+)', envout)
        if m:
            token = m.group(1).strip()

        # 自检
        code, health = run(cli, 'curl -s --max-time 8 http://127.0.0.1:8899/api/health', show=False)
        print('\n' + '=' * 52)
        if '"ok":true' in health:
            pub = run(cli, 'curl -s --max-time 6 https://api.ipify.org || curl -s --max-time 6 ifconfig.me', show=False)[1].strip()
            print('  ✅ 部署成功')
            print(f'  服务器内网自检: {health.strip()}')
            print()
            print(f'  访问地址:  http://{pub or host}:8899/')
            if token:
                print(f'  访问口令:  {token}')
                print(f'  首次进入:  http://{pub or host}:8899/?token={token}')
            print()
            print('  ⚠️ 记得在腾讯云控制台【防火墙/安全组】放行 TCP 8899')
        else:
            print('  ✗ 部署后自检失败，请把上面的输出贴给我')
            print('  health 响应:', health.strip()[:300])
        print('=' * 52)
    finally:
        cli.close()


if __name__ == '__main__':
    main()
