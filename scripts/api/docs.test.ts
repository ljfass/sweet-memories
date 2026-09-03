import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const operationsPath = resolve(repositoryRoot, 'docs/photo-upload-operations.md');
const deploymentPath = resolve(repositoryRoot, 'docs/deployment.md');

function readOperations(): string {
  return readFileSync(operationsPath, 'utf8');
}

function section(document: string, heading: string, nextHeading?: string): string {
  const start = document.indexOf(heading);
  expect(start, 'missing section: ' + heading).toBeGreaterThanOrEqual(0);
  const end = nextHeading === undefined ? document.length : document.indexOf(nextHeading, start + 1);
  expect(end, 'missing section boundary: ' + nextHeading).toBeGreaterThan(start);
  return document.slice(start, end);
}

describe('photo upload operations guide', () => {
  it('documents the exact Ubuntu runtime, identities, data paths, and permissions', () => {
    const document = readOperations();

    expect(document).toContain('Ubuntu 24.04');
    expect(document).toContain('node-v24.20.0-linux-x64.tar.xz');
    expect(document).toContain('SHASUMS256.txt.sig');
    expect(document).toContain('gpg --verify SHASUMS256.txt.sig SHASUMS256.txt');
    expect(document).toContain("grep ' node-v24.20.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check --strict -");
    expect(document).toContain('libheif-examples sqlite3');
    expect(document).toContain('sweet-memories-media');
    expect(document).toContain('usermod --append --groups sweet-memories-media www-data');
    expect(document).toContain('/var/lib/sweet-memories/database/sweet-memories.sqlite3');

    for (const contract of [
      '0750 /var/lib/sweet-memories',
      '0700 /var/lib/sweet-memories/database',
      '0700 /var/lib/sweet-memories/staging',
      '0700 /var/lib/sweet-memories/backups',
      '2750 /var/lib/sweet-memories/media',
      '0700 /var/lib/sweet-memories/backups/deploy',
      '0700 /var/lib/sweet-memories/backups/manual',
    ]) {
      expect(document).toContain(contract);
    }
  });

  it('installs the exact root-owned helpers and service templates', () => {
    const document = readOperations();

    for (const contract of [
      'scripts/deploy/manage-api-release.sh /usr/local/sbin/manage-sweet-memories-api',
      'scripts/ops/backup-data.sh /usr/local/sbin/backup-sweet-memories-data',
      'scripts/ops/restore-data.sh /usr/local/sbin/restore-sweet-memories-data',
      'ops/systemd/sweet-memories-api.service /etc/systemd/system/sweet-memories-api.service',
      'ops/nginx/sweet-memories-api.conf /etc/nginx/snippets/sweet-memories-api.conf',
      'ops/sudoers/sweet-memories-api /etc/sudoers.d/sweet-memories-api',
      'systemctl daemon-reload',
      'systemctl enable sweet-memories-api.service',
      'nginx -t',
      'systemctl reload nginx.service',
    ]) {
      expect(document).toContain(contract);
    }
  });

  it('keeps preparation static and requires five-photo readiness before activation', () => {
    const document = readOperations();
    const preparation = section(document, '## 4. 准备阶段', '## 5. 备份和异地下载');

    expect(preparation).toContain('{ "mode": "static" }');
    expect(preparation).toContain('migration import-legacy');
    expect(preparation).toContain('https://huangjianfen.cn/admin');
    expect(preparation).toContain('migration check-ready');
    expect(preparation).toContain('cli uploads status');
    expect(preparation).toContain('图片上传：已禁用');
    expect(preparation).toContain('五张');
    expect(preparation).toContain('captured_date ASC, created_at ASC, id ASC');
    expect(preparation.indexOf('migration import-legacy')).toBeLessThan(
      preparation.indexOf('migration check-ready'),
    );
  });

  it('documents consistent backup, strict Mac download, and both restore modes', () => {
    const document = readOperations();
    const backup = section(document, '## 5. 备份和异地下载', '## 6. 恢复');
    const restore = section(document, '## 6. 恢复', '## 7. 激活 API 相册');

    expect(backup).toContain(
      '/usr/local/sbin/backup-sweet-memories-data /var/lib/sweet-memories/backups/manual',
    );
    expect(backup).toContain('执行位置：Mac');
    expect(backup).toContain('scp production-admin:');
    expect(backup).toContain('.tar.gz.sha256');
    expect(backup).toContain('shasum -a 256 --check');
    expect(backup).toContain('StrictHostKeyChecking yes');

    expect(restore).toContain('/usr/local/sbin/restore-sweet-memories-data verify');
    expect(restore).toContain('/usr/local/sbin/restore-sweet-memories-data apply');
    expect(restore).toContain('verify');
    expect(restore).toContain('不会停止服务');
    expect(restore).toContain('维护状态');
    expect(restore).toContain('sweet-memories-recovery-');
  });

  it('activates only after readiness and offsite backup, then gates uploads on public health', () => {
    const document = readOperations();
    const activation = section(document, '## 7. 激活 API 相册', '## 8. 手工回退');

    expect(activation).toContain('{ "mode": "api" }');
    expect(activation).toContain('migration check-ready');
    expect(activation).toContain('异地备份');
    expect(activation).toContain('migration activate');
    expect(activation).toContain('/api/photos');
    expect(activation).toContain('/media/');
    expect(activation).toContain('cli uploads enable');
    expect(activation.indexOf('migration check-ready')).toBeLessThan(
      activation.indexOf('{ "mode": "api" }'),
    );
    expect(activation.indexOf('/api/photos')).toBeLessThan(
      activation.indexOf('cli uploads enable'),
    );
  });

  it('uses fail-closed, conditional manual rollback and bounded diagnostics', () => {
    const document = readOperations();
    const rollback = section(document, '## 8. 手工回退', '## 9. 日志和磁盘排障');
    const diagnostics = section(document, '## 9. 日志和磁盘排障');

    expect(rollback).toContain('cli uploads disable');
    expect(rollback).toContain('rollback-if-current');
    expect(rollback).toContain('manage-release.sh');
    expect(rollback).toContain('只有前端确认回退成功');
    expect(rollback).toContain('任一 SSH 或 curl');
    expect(rollback).not.toContain('rollback /var/www/huangjianfen.cn');

    expect(diagnostics).toContain('journalctl -u sweet-memories-api.service');
    expect(diagnostics).toContain('systemctl status sweet-memories-api.service');
    expect(diagnostics).toContain('df -h /var/lib/sweet-memories /opt/sweet-memories-api');
    expect(diagnostics).toContain('/var/log/nginx/error.log');
    expect(diagnostics).toContain('database/sweet-memories.sqlite3');
  });

  it('labels every operational section by machine and rejects unsafe examples', () => {
    const document = readOperations();

    for (const heading of [
      '## 1. 安装 Ubuntu 运行环境',
      '## 2. 创建账号和持久化目录',
      '## 3. 安装服务文件和管理脚本',
      '## 4. 准备阶段',
      '## 5. 备份和异地下载',
      '## 6. 恢复',
      '## 7. 激活 API 相册',
      '## 8. 手工回退',
      '## 9. 日志和磁盘排障',
    ]) {
      expect(section(document, heading).slice(0, 220)).toMatch(/执行位置：(服务器|Mac)/u);
    }

    const forbidden = [
      /-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/u,
      /(?:ADMIN_)?PASSWORD\s*=\s*\S+/iu,
      /--password(?:=|\s+)\S+/iu,
      /chmod\s+777/u,
      /StrictHostKeyChecking\s+(?:no|accept-new)/iu,
      /ALL\s*=\s*\(ALL(?::ALL)?\)\s*(?:NOPASSWD:\s*)?ALL/u,
      /rm\s+-rf/u,
    ];
    for (const pattern of forbidden) {
      expect(document).not.toMatch(pattern);
    }
  });

  it('keeps every shell example strict and syntactically valid', () => {
    const document = readOperations();
    const blocks = [...document.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map(
      (match) => match[1] as string,
    );

    expect(blocks.length).toBeGreaterThan(10);
    for (const block of blocks) {
      expect(block).toMatch(/^set -Eeuo pipefail\n/u);
      expect(() => execFileSync('bash', ['-n'], { input: block })).not.toThrow();
    }
  });

  it('links from the static deployment guide without duplicating privileged commands', () => {
    const deployment = readFileSync(deploymentPath, 'utf8');
    const extension = section(deployment, '## 图片 API 扩展');

    expect(extension).toContain('[图片上传 API 运维指南](./photo-upload-operations.md)');
    expect(extension).toContain('原静态前端部署');
    expect(extension).not.toContain('sudo ');
    expect(extension).not.toContain('```');
    expect(extension.length).toBeLessThan(800);
  });
});
