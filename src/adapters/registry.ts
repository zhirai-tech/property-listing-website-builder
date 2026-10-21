/**
 * 适配器注册表（组合根的一部分）。
 *
 * 方案第六章第 8 条：所有外部服务都应有明确配置边界。
 * 这里集中把「配置」翻译成「具体适配器实例」，业务层只依赖接口，
 * 因此替换服务商不需要改动任何业务代码。
 */

import type { AppConfig } from '../config.ts';
import type { Logger } from '../util/logger.ts';
import type { Clock } from './clock.ts';
import { SystemClock } from './clock.ts';
import type { MapProvider } from './map.ts';
import { DisabledMapProvider, OsmMapProvider } from './map.ts';
import type { StorageProvider } from './storage.ts';
import { LocalStorageProvider, MemoryStorageProvider } from './storage.ts';
import type { MailProvider } from './mail.ts';
import { ConsoleMailProvider, MemoryMailProvider, SmtpMailProvider } from './mail.ts';
import type { DnsResolver } from './dns.ts';
import { FakeDnsResolver, SystemDnsResolver } from './dns.ts';
import type { HostingProvider } from './hosting.ts';
import { CustomDomainHostingProvider, DefaultHostingProvider } from './hosting.ts';

export interface Adapters {
  clock: Clock;
  map: MapProvider;
  storage: StorageProvider;
  mail: MailProvider;
  dns: DnsResolver;
  hosting: HostingProvider;
}

export interface CreateAdaptersOptions {
  overrides?: Partial<Adapters>;
  /** 使用内存存储（测试用） */
  inMemoryStorage?: boolean;
}

export function createAdapters(
  config: AppConfig,
  logger: Logger,
  options: CreateAdaptersOptions = {},
): Adapters {
  const hostingOptions = {
    publicBaseUrl: config.publicBaseUrl,
    cnameTarget: config.hosting.cnameTarget,
    domainVerifyPrefix: config.hosting.domainVerifyPrefix,
  };

  const dns: DnsResolver =
    options.overrides?.dns ??
    (config.env === 'test' ? new FakeDnsResolver() : new SystemDnsResolver());

  const map: MapProvider =
    config.map.provider === 'disabled'
      ? new DisabledMapProvider()
      : new OsmMapProvider({
          tileUrl: config.map.tileUrl,
          attribution: config.map.attribution,
          freeTierNote: config.map.freeTierNote,
          apiKey: config.map.apiKey,
          overpassEndpoint: config.map.overpassEndpoint,
          logger,
        });

  const storage: StorageProvider =
    options.inMemoryStorage || config.storage.provider === 'memory'
      ? new MemoryStorageProvider()
      : new LocalStorageProvider({ rootDir: config.uploadDir, urlPrefix: '/media' });

  const mail: MailProvider =
    config.mail.provider === 'smtp'
      ? new SmtpMailProvider({
          host: config.mail.smtpHost,
          port: config.mail.smtpPort,
          user: config.mail.smtpUser,
          password: config.mail.smtpPassword,
          from: config.mail.from,
        })
      : config.env === 'test'
        ? new MemoryMailProvider()
        : new ConsoleMailProvider(logger);

  const hosting: HostingProvider =
    config.hosting.provider === 'custom_domain'
      ? new CustomDomainHostingProvider(hostingOptions, dns)
      : new DefaultHostingProvider(hostingOptions);

  return {
    clock: options.overrides?.clock ?? new SystemClock(),
    map: options.overrides?.map ?? map,
    storage: options.overrides?.storage ?? storage,
    mail: options.overrides?.mail ?? mail,
    dns,
    hosting: options.overrides?.hosting ?? hosting,
  };
}
