import { formatDistance } from 'date-fns';
import { ServerManager } from './server/Server';
import {
  BackupService,
  LoggerService,
  RECORD_ROOT,
  REQUEST_METHODS,
  SyncService,
  URL_BASES,
  URL_PATHS,
  WebSocketService,
} from './services/';
import {
  Backup,
  IndexSignatureType,
  LightNodeConfig,
  SyncerConfig,
  Tables,
} from './types';
import {
  createQuery,
  getContractInfo,
  getMonth,
  getYear,
  isAddress,
  isSuccessResponse,
} from './utils/utils';

/**
 * LightNode class represents a lightweight node for syncing data.
 * It is responsible for setting up and managing synchronization services, called SyncerServices.
 * The LightNode class is initialized with a configuration object, which contains information
 * about the synchronization process, API keys, contracts, and other settings.
 */
class _LightNode {
  /**
   * LightNode configuration
   * @type {LightNodeConfig}
   * @access private
   */
  private _config!: LightNodeConfig;

  /**
   * LightNode syncers
   * @type {Map<string, SyncService>}
   * @access private
   */
  private readonly _syncers: Map<string, SyncService> = new Map();

  /**
   * # launch
   * Launches the LightNode instance
   * @param {LightNodeConfig} _config - The configuration object for the LightNode.
   * @returns {void}
   * @access public
   */
  public async launch(_config: LightNodeConfig): Promise<void> {
    this._config = _config;
    this._validateConfig();
    this._setServices();
    await this._launchServices();
    await this._createSyncers();
    this._launchSyncers();
    this._logSyncers();
  }
  /**
   *  # createSyncer
   * Creates a a new syncer
   * @param type - Type of syncer
   * @param contracts - Contracts to filter
   * @returns {string | null} string or null
   */
  public async createSyncer(type: Tables, contract: string): Promise<void> {
    const { name } = await getContractInfo(contract);
    const id = `${type}-syncer-${name}`;
    const syncService = new SyncService({
      chain: this._config.syncer.chain,
      workerCount: this._config.syncer.workerCount,
      managerCount: this._config.syncer.managerCount,
      apiKey: this._config.syncer.apiKey,
      contracts: [contract],
      upkeepDelay: 0,
      type: type,
      date: await this._getStartDate(type),
      backup: await this._loadBackup(type),
    });

    this._syncers.set(id, syncService);

    this._syncers.get(id)?.launch();
  }
  /**
   * # _launchServices
   * @returns {void}
   * @access private
   */
  private async _launchServices(): Promise<void> {
    ServerManager.launch();
    WebSocketService.launch();
    await BackupService.launch();
  }

  /**
   * # _logSyncers
   * Logs information about the LightNode syncer
   * @returns {void}
   * @access private
   */
  private _logSyncers(): void {
    const processStart = new Date();
    process.title = 'Reservoir Light Node';
    setInterval(() => {
      let workers: any[] = [];
      let managers: any[] = [];

      this._syncers.forEach((syncer, syncerId) => {
        syncer.managers.forEach((manager, id) => {
          if (!manager) return;
          managers.push({
            type: syncer.config.type,
            Syncer: syncerId,
            Manager: id,
            Year: getYear(manager?.config.date),
            Month: getMonth(manager?.config.date),
            Requests: manager?.requestCount,
            Insertions: manager?.insertCount,
            Status: manager?.status,
            Busy: manager?.isBusy,
            Backfilled: manager?.isBackfilled,
          });
          manager.workers.forEach((worker, id) => {
            workers.push({
              Worker: id,
              Date: worker?.date.substring(5),
              Busy: worker?.isBusy,
              Status: worker?.status,
              Backfilled: worker?.isBackfilled,
              Insertions: worker?.counts?._insertions,
              Continuation: worker?.continuation,
              '2xx': worker?.counts._requests['2xx'],
              '4xx': worker?.counts._requests['4xx'],
              '5xx': worker?.counts?._requests['5xx'],
            });
          });
        });
      });

      // console.clear();
      // const used = process.memoryUsage();
      // const timeSince = formatDistance(processStart, new Date(), {
      //   addSuffix: true,
      // });
      // console.log(`Runtime: ${processStart} (${timeSince})`);
      // console.log(
      //   `Memory usage: ${Math.round((used.rss / 1024 / 1024) * 100) / 100} MB`
      // );
      // console.table(managers);
      // console.table(
      //   workers.sort(
      //     (a, b) => new Date(a.date).getDate() - new Date(b.date).getDate()
      //   )
      // );
    }, 100);
  }

  /**
   * # _getStartDate
   * Gets the start date for the lightnode
   * @param {LightNodeConfig} syncer - The type of the syncer, which is used to parse and insert in a generic way.
   * @returns {string} - The start date for the LightNode.
   */
  private async _getStartDate(syncer: SyncerConfig['type']): Promise<string> {
    const res = await REQUEST_METHODS.sales({
      url: `${URL_BASES[this._config.syncer.chain]}${URL_PATHS[syncer]}`,
      query: createQuery('', this._config.syncer.contracts, syncer, false),
      apiKey: this._config.syncer.apiKey,
    });
    if (!isSuccessResponse(res))
      throw new Error(
        `FAILED TO GET STARTED DATE: ${res.data.message}:${res.status}`
      );

    const data = res.data as IndexSignatureType;

    const type = RECORD_ROOT[syncer];
    if (data[type]?.length > 0 && data[type]?.[data[type]?.length - 1]) {
      return data[type][data[type].length - 1].updatedAt.substring(0, 10);
    }
    return new Date().toISOString().substring(0, 10);
  }

  /**
   * # _createSyncers
   * Creates the LightNode syncers
   * @returns {void}
   * @access private
   */
  private async _createSyncers(): Promise<void> {
    const { syncer, backup } = this._config;
    if (!backup?.useBackup) {
      await BackupService.flush();
    }

    if (syncer.contracts && syncer.contracts.length > 0) {
      for await (const contract of syncer.contracts) {
        if (syncer.toSync.sales) {
          this._syncers.set(
            `sales-syncer-${contract}`,
            new SyncService({
              chain: syncer.chain,
              workerCount: syncer.workerCount,
              managerCount: syncer.managerCount,
              apiKey: syncer.apiKey,
              contracts: [contract],
              upkeepDelay: 0,
              type: 'sales',
              date: await this._getStartDate('sales'),
              backup: await this._loadBackup('sales'),
            })
          );
        }
        if (syncer.toSync.asks) {
          this._syncers.set(
            'asks-syncer',
            new SyncService({
              chain: syncer.chain,
              workerCount: syncer.workerCount,
              managerCount: syncer.managerCount,
              apiKey: syncer.apiKey,
              upkeepDelay: 60,
              contracts: syncer.contracts,
              type: 'asks',
              date: await this._getStartDate('asks'),
              backup: await this._loadBackup('asks'),
            })
          );
        }
      }

      return;
    }

    if (syncer.toSync.sales) {
      this._syncers.set(
        'sales-syncer',
        new SyncService({
          chain: syncer.chain,
          workerCount: syncer.workerCount,
          managerCount: syncer.managerCount,
          apiKey: syncer.apiKey,
          contracts: syncer.contracts,
          upkeepDelay: 0,
          type: 'sales',
          date: await this._getStartDate('sales'),
          backup: await this._loadBackup('sales'),
        })
      );
    }
    if (syncer.toSync.asks) {
      this._syncers.set(
        'asks-syncer',
        new SyncService({
          chain: syncer.chain,
          workerCount: syncer.workerCount,
          managerCount: syncer.managerCount,
          apiKey: syncer.apiKey,
          upkeepDelay: 60,
          contracts: syncer.contracts,
          type: 'asks',
          date: await this._getStartDate('asks'),
          backup: await this._loadBackup('asks'),
        })
      );
    }
  }

  /**
   * # _launchSyncers
   * Launches the LightNode syncers
   * @returns {void}
   * @access private
   */
  private _launchSyncers(): void {
    this._syncers.forEach((syncer): void => syncer.launch());
  }

  /**
   * # _setServivices
   * Sets internal services for the LightNode
   * @returns {void}
   * @access private
   */
  private _setServices(): void {
    LoggerService.set(this._config.logger);
    ServerManager.set(this._config.server);
    BackupService.set(this._config.backup);
    WebSocketService.set({
      apiKey: this._config.syncer.apiKey,
      contracts: this._config.syncer.contracts,
      chain: this._config.syncer.chain,
      toConnect: {
        asks: this._config.syncer.toSync.asks,
      },
    });
  }

  /**
   * # _validateConfig
   * Validates the LightNode configuration
   * @returns {void}
   * @access private
   * @throws {Error} - If any part of the configuration is invalid.
   */
  private _validateConfig(): void {
    const { server, syncer, logger, backup } = this._config;

    if (backup && !backup.redisUrl) {
      throw new Error(`INVALID REDIS URl; ${backup.redisUrl}`);
    }

    if (String(server.port).length !== 4)
      throw new Error(`INVALID SERVER PORT: ${server.port}`);

    if (!server.authorization)
      throw new Error(`INVALID SERVER AUTHORIZATION: ${server.authorization}`);

    if (logger?.datadog) {
      const { appName, apiKey } = logger.datadog;
      if (!appName || !apiKey)
        throw new Error(`INVALID DATADOG CONFIG: ${appName}-${apiKey}`);
    }

    if (!syncer.apiKey)
      throw new Error(`AN API KEY IS REQUIRED: ${syncer.apiKey}`);

    if (syncer?.contracts) {
      syncer.contracts.forEach((contract) => {
        if (!isAddress(contract)) {
          throw new Error(`INVALID CONTRACT ADDRESS: ${contract}`);
        }
      });
    }

    if (!syncer.chain) throw new Error(`INVALID CHAIN: ${syncer.chain}`);
  }
  /**
   * # _loadBackup
   * Loads a backup of the most recent state of the LightNode
   * @param {String} type - SyncerType
   * @access private
   * @returns {Backup} - LightNode Backup
   */
  private async _loadBackup(type: string): Promise<Backup | null> {
    return BackupService.load(type);
  }
}

export const LightNode = new _LightNode();
