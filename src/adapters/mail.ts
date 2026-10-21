/**
 * 邮件适配器（方案第四章第 7 条：邮件为可替换适配器）。
 *
 * 三种实现：
 *  - console：默认，只写入服务端日志（开发与验收演示用，零外部依赖）；
 *  - smtp：真实的 SMTP 客户端（仅使用 node:net / node:tls，不引入第三方库），
 *    支持隐式 TLS(465) 与 STARTTLS(587)，可用本地假服务器完整验证；
 *  - memory：测试用收集器。
 *
 * 安全要点：主题与收件人必须过滤 CR/LF，防止 SMTP 头注入。
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { dependencyUnavailable, validationFailed } from '../domain/errors.ts';
import type { Logger } from '../util/logger.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailSendResult {
  provider: string;
  deliveredAt: string;
  detail: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** 校验并规范化收件人；同时阻断头注入 */
export function assertSafeRecipient(to: string): string {
  const value = to.trim();
  if (value === '' || /[\r\n]/.test(value) || !EMAIL_PATTERN.test(value)) {
    throw validationFailed([{ field: 'to', message: `收件人邮箱不合法：${to}` }]);
  }
  return value;
}

/** 单行头字段：去掉换行，避免头部注入 */
export function assertSafeHeader(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw validationFailed([{ field, message: `${field} 不允许包含换行符` }]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

export class ConsoleMailProvider implements MailProvider {
  readonly name = 'console';
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ adapter: 'mail', provider: 'console' });
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const to = assertSafeRecipient(message.to);
    const subject = assertSafeHeader(message.subject, 'subject');

    this.logger.info('【邮件适配器 console】模拟发送邮件', {
      to,
      subject,
      bodyPreview: message.text.slice(0, 500),
      note: '当前 MAIL_PROVIDER=console，邮件不会真正投递；生产环境请配置 smtp',
    });

    return {
      provider: this.name,
      deliveredAt: new Date().toISOString(),
      detail: `已写入服务端日志（收件人 ${to}）`,
    };
  }
}

// ---------------------------------------------------------------------------
// memory（测试用）
// ---------------------------------------------------------------------------

export class MemoryMailProvider implements MailProvider {
  readonly name = 'memory';
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailSendResult> {
    assertSafeRecipient(message.to);
    assertSafeHeader(message.subject, 'subject');
    this.sent.push({ ...message });
    return {
      provider: this.name,
      deliveredAt: new Date().toISOString(),
      detail: `已记录到内存（共 ${this.sent.length} 封）`,
    };
  }

  clear(): void {
    this.sent.length = 0;
  }
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** 连接与命令超时（毫秒） */
  timeoutMs?: number;
  /** 465 端口为隐式 TLS */
  implicitTls?: boolean;
  /** 自签名证书的测试服务器可设为 false */
  rejectUnauthorized?: boolean;
}

/** 基于行的响应读取器，支持 STARTTLS 后重新绑定 socket */
class SmtpReader {
  private buffer = '';
  private pending: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private detach: Array<() => void> = [];

  attach(socket: Socket | TLSSocket, timeoutMs: number): void {
    this.detachAll();
    const onData = (chunk: Buffer): void => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    };
    const onError = (error: Error): void => this.fail(error);
    const onTimeout = (): void => this.fail(new Error('SMTP 连接超时'));
    const onClose = (): void => this.fail(new Error('SMTP 连接被对端关闭'));

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
    socket.on('close', onClose);
    socket.setTimeout(timeoutMs);

    this.detach = [
      () => socket.off('data', onData),
      () => socket.off('error', onError),
      () => socket.off('timeout', onTimeout),
      () => socket.off('close', onClose),
    ];
  }

  detachAll(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
  }

  reset(): void {
    this.buffer = '';
    this.failure = null;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.pending) {
      const waiter = this.pending;
      this.pending = null;
      waiter.reject(this.failure);
    }
  }

  private drain(): void {
    if (!this.pending) return;
    const index = this.buffer.search(/\r?\n/);
    if (index < 0) return;

    const line = this.buffer.slice(0, index);
    this.buffer = this.buffer.slice(index).replace(/^\r?\n/, '');

    const waiter = this.pending;
    this.pending = null;
    waiter.resolve(line);
  }

  readLine(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.drain();
    });
  }

  /** 读取完整响应：多行响应以「250-」续行，直到出现「250 」 */
  async readResponse(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const line = await this.readLine();
      lines.push(line);
      const match = /^(\d{3})([- ])/.exec(line);
      if (match && match[2] === ' ') return { code: Number(match[1]), text: lines.join('\n') };
      if (!match) return { code: 0, text: lines.join('\n') };
    }
    throw new Error('SMTP 响应行数异常');
  }
}

function connectPlain(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const onError = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`连接 SMTP 服务器超时：${host}:${port}`));
    });
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function connectTls(
  options: { host: string; port: number; timeoutMs: number; rejectUnauthorized: boolean },
  existing?: Socket,
): Promise<TLSSocket> {
  const { host, port, timeoutMs, rejectUnauthorized } = options;
  return new Promise((resolve, reject) => {
    const socket = existing
      ? tlsConnect({ socket: existing, servername: host, rejectUnauthorized })
      : tlsConnect({ host, port, servername: host, rejectUnauthorized });

    const onError = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TLS 握手超时：${host}:${port}`));
    });
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

/** 组装 RFC 5322 邮件正文 */
export function buildSmtpPayload(from: string, message: MailMessage): string {
  const to = assertSafeRecipient(message.to);
  const subject = assertSafeHeader(message.subject, 'subject');

  // 主题使用 RFC 2047 Base64 编码，保证中文主题在各客户端正常显示
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@property-listing>`,
  ];

  const body = Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  // 以 SMTP 的行终止规则拼接，并对「单独一行 .」做转义
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  private readonly options: Required<SmtpOptions>;

  constructor(options: SmtpOptions) {
    this.options = {
      timeoutMs: 15_000,
      implicitTls: options.port === 465,
      rejectUnauthorized: true,
      ...options,
    };
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const { host, port, user, password, from, timeoutMs, implicitTls, rejectUnauthorized } =
      this.options;

    if (host === '') {
      throw dependencyUnavailable('邮件服务', new Error('SMTP_HOST 未配置'));
    }

    const reader = new SmtpReader();
    let socket: Socket | TLSSocket;

    try {
      socket = implicitTls
        ? await connectTls({ host, port, timeoutMs, rejectUnauthorized })
        : await connectPlain(host, port, timeoutMs);
    } catch (error) {
      throw dependencyUnavailable('邮件服务', error);
    }

    try {
      reader.attach(socket, timeoutMs);

      const greeting = await reader.readResponse();
      if (greeting.code !== 220) throw new Error(`SMTP 问候失败：${greeting.text}`);

      const send = async (command: string): Promise<{ code: number; text: string }> => {
        socket.write(`${command}\r\n`);
        return reader.readResponse();
      };

      let ehlo = await send(`EHLO property-listing`);
      if (ehlo.code !== 250) throw new Error(`EHLO 失败：${ehlo.text}`);

      if (!implicitTls) {
        const supportsStartTls = /STARTTLS/i.test(ehlo.text);
        if (supportsStartTls) {
          const started = await send('STARTTLS');
          if (started.code !== 220) throw new Error(`STARTTLS 失败：${started.text}`);

          reader.detachAll();
          socket = await connectTls({ host, port, timeoutMs, rejectUnauthorized }, socket);
          reader.reset();
          reader.attach(socket, timeoutMs);

          ehlo = await send(`EHLO property-listing`);
          if (ehlo.code !== 250) throw new Error(`STARTTLS 后 EHLO 失败：${ehlo.text}`);
        }
      }

      if (user !== '') {
        const authStart = await send('AUTH LOGIN');
        if (authStart.code !== 334) throw new Error(`AUTH LOGIN 被拒绝：${authStart.text}`);

        const userStep = await send(Buffer.from(user, 'utf8').toString('base64'));
        if (userStep.code !== 334) throw new Error(`用户名步骤失败：${userStep.text}`);

        const passStep = await send(Buffer.from(password, 'utf8').toString('base64'));
        if (passStep.code !== 235) throw new Error(`认证失败：${passStep.text}`);
      }

      const mailFrom = await send(`MAIL FROM:<${from}>`);
      if (mailFrom.code !== 250) throw new Error(`MAIL FROM 失败：${mailFrom.text}`);

      const rcptTo = await send(`RCPT TO:<${assertSafeRecipient(message.to)}>`);
      if (rcptTo.code !== 250 && rcptTo.code !== 251) {
        throw new Error(`RCPT TO 失败：${rcptTo.text}`);
      }

      const dataStart = await send('DATA');
      if (dataStart.code !== 354) throw new Error(`DATA 被拒绝：${dataStart.text}`);

      socket.write(`${buildSmtpPayload(from, message)}\r\n.\r\n`);
      const accepted = await reader.readResponse();
      if (accepted.code !== 250) throw new Error(`邮件投递失败：${accepted.text}`);

      socket.write('QUIT\r\n');
      socket.end();
      reader.detachAll();

      return {
        provider: this.name,
        deliveredAt: new Date().toISOString(),
        detail: `SMTP ${host}:${port} 已接受（${accepted.text.split('\n')[0] ?? ''}）`,
      };
    } catch (error) {
      try {
        socket.destroy();
      } catch {
        // 忽略清理失败
      }
      reader.detachAll();

      if (error instanceof Error && error.name === 'DomainError') throw error;
      throw dependencyUnavailable('邮件服务', error);
    }
  }
}
