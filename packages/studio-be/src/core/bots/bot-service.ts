import { BotConfig, Logger, ListenHandle, BotTemplate } from 'botpress/sdk'
import { BotEditSchema } from 'common/validation'
import { coreActions } from 'core/app/core-client'
import { TYPES } from 'core/app/types'
import { FileContent, GhostService, ReplaceContent } from 'core/bpfs'
import { CMSService } from 'core/cms'
import { ConfigProvider } from 'core/config'
import { JobService } from 'core/distributed/job-service'
import { MigrationService } from 'core/migration'
import { getBuiltinPath, listDir } from 'core/misc/list-dir'
import { stringify } from 'core/misc/utils'
import { InvalidOperationError } from 'core/routers'
import { WorkspaceService } from 'core/users'
import { WrapErrorsWith } from 'errors'
import fse from 'fs-extra'
import { inject, injectable, postConstruct, tagged } from 'inversify'
import Joi from 'joi'
import _ from 'lodash'
import path from 'path'

const BOT_CONFIG_FILENAME = 'bot.config.json'
const BOT_ID_PLACEHOLDER = '/bots/BOT_ID_PLACEHOLDER/'
const BOTID_REGEX = /^[A-Z0-9]+[A-Z0-9_-]{1,}[A-Z0-9]+$/i
const IGNORED_ACTION = ['say']

const DEFAULT_BOT_CONFIGS = {
  locked: false,
  disabled: false,
  private: false,
  details: {}
}

const BotCreationSchema = Joi.object().keys({
  id: Joi.string()
    .regex(BOTID_REGEX)
    .required(),
  name: Joi.string()
    .max(50)
    .allow('')
    .optional(),
  category: Joi.string().allow(null),
  description: Joi.string()
    .max(500)
    .allow(''),
  pipeline_status: {
    current_stage: {
      promoted_by: Joi.string(),
      promoted_on: Joi.date(),
      id: Joi.string()
    }
  },
  locked: Joi.bool()
})

const debug = DEBUG('services:bots')

@injectable()
export class BotService {
  public mountBot: Function = this.localMount
  public unmountBot: Function = this.localUnmount

  private _botIds: string[] | undefined
  private static _mountedBots: Map<string, boolean> = new Map()
  private _trainWatchers: { [botId: string]: ListenHandle } = {}

  constructor(
    @inject(TYPES.Logger)
    @tagged('name', 'BotService')
    private logger: Logger,
    @inject(TYPES.ConfigProvider) private configProvider: ConfigProvider,
    @inject(TYPES.CMSService) private cms: CMSService,
    @inject(TYPES.GhostService) private ghostService: GhostService,
    @inject(TYPES.WorkspaceService) private workspaceService: WorkspaceService,
    @inject(TYPES.JobService) private jobService: JobService,
    @inject(TYPES.MigrationService) private migrationService: MigrationService
  ) {
    this._botIds = undefined
  }

  @postConstruct()
  async init() {
    this.mountBot = await this.jobService.broadcast<void>(this.localMount.bind(this))
    this.unmountBot = await this.jobService.broadcast<void>(this.localUnmount.bind(this))
  }

  async findBotById(botId: string): Promise<BotConfig | undefined> {
    if (!(await this.ghostService.forBot(botId).fileExists('/', 'bot.config.json'))) {
      this.logger.forBot(botId).warn(`Bot "${botId}" not found. Make sure it exists on your filesystem or database.`)
      return
    }

    return this.configProvider.getBotConfig(botId)
  }

  async findBotsByIds(botsIds: string[]): Promise<BotConfig[]> {
    const actualBotsIds = await this.getBotsIds()
    const unlinkedBots = _.difference(actualBotsIds, botsIds)
    const linkedBots = _.without(actualBotsIds, ...unlinkedBots)
    const botConfigs: BotConfig[] = []

    for (const botId of linkedBots) {
      const config = await this.findBotById(botId)
      config && botConfigs.push(config)
    }

    return botConfigs
  }

  async getBots(): Promise<Map<string, BotConfig>> {
    const botIds = await this.getBotsIds()
    const bots = new Map<string, BotConfig>()

    for (const botId of botIds) {
      try {
        const bot = await this.findBotById(botId)
        bot && bots.set(botId, bot)
      } catch (err) {
        this.logger
          .forBot(botId)
          .attachError(err)
          .error(`Bot configuration file not found for bot "${botId}"`)
      }
    }

    return bots
  }

  async getBotsIds(ignoreCache?: boolean): Promise<string[]> {
    if (!this._botIds || ignoreCache) {
      this._botIds = (await this.ghostService.bots().directoryListing('/', BOT_CONFIG_FILENAME)).map(path.dirname)
    }

    return this._botIds
  }

  async updateBot(botId: string, updatedBot: Partial<BotConfig>): Promise<void> {
    const { error } = Joi.validate(updatedBot, BotEditSchema)
    if (error) {
      throw new InvalidOperationError(`An error occurred while updating the bot: ${error.message}`)
    }

    if (!(await this.botExists(botId))) {
      throw new Error(`Bot "${botId}" doesn't exist`)
    }

    if (!process.IS_PRO_ENABLED && !process.IS_STANDALONE && updatedBot.languages && updatedBot.languages.length > 1) {
      throw new Error('A single language is allowed on community edition.')
    }

    const actualBot = await this.configProvider.getBotConfig(botId)
    const updatedFields = _.pick(updatedBot, [
      'name',
      'description',
      'category',
      'details',
      'disabled',
      'private',
      'defaultLanguage',
      'languages',
      'locked'
    ]) as Partial<BotConfig>

    // bot needs to be mounted to perform the language changes
    if (updatedFields.defaultLanguage && updatedFields.defaultLanguage !== actualBot.defaultLanguage) {
      updatedFields.disabled = false
    }

    const newConfig = {
      ...actualBot,
      ...updatedFields
    } as BotConfig

    if (!newConfig.languages.includes(newConfig.defaultLanguage)) {
      throw new Error('Supported languages must include the default language of the bot')
    }

    await this.configProvider.setBotConfig(botId, newConfig)

    if (!updatedBot.disabled) {
      if (this.isBotMounted(botId)) {
        // we need to remount the bot to update the config
        await this.unmountBot(botId)
      }

      await this.mountBot(botId)
    }

    if (actualBot.defaultLanguage !== updatedBot.defaultLanguage) {
      await this.cms.translateContentProps(botId, actualBot.defaultLanguage, updatedBot.defaultLanguage!)
    }

    // This will regenerate previews for all the bot's languages
    if (actualBot.languages !== updatedBot.languages) {
      await this.cms.recomputeElementsForBot(botId)
    }

    if (!actualBot.disabled && updatedBot.disabled) {
      await this.unmountBot(botId)
    }
  }

  async exportBot(botId: string): Promise<Buffer> {
    const replaceContent: ReplaceContent = {
      from: [new RegExp(`/bots/${botId}/`, 'g')],
      to: [BOT_ID_PLACEHOLDER]
    }

    return this.ghostService.forBot(botId).exportToArchiveBuffer('models/**/*', replaceContent)
  }

  async duplicateBot(sourceBotId: string, destBotId: string, overwriteDest: boolean = false) {
    if (!(await this.botExists(sourceBotId))) {
      throw new Error('Source bot does not exist')
    }
    if (sourceBotId === destBotId) {
      throw new Error('New bot id needs to differ from original bot')
    }
    if (!overwriteDest && (await this.botExists(destBotId))) {
      this.logger
        .forBot(destBotId)
        .warn('Tried to duplicate a bot to existing destination id without allowing to overwrite')
      return
    }

    const sourceGhost = this.ghostService.forBot(sourceBotId)
    const destGhost = this.ghostService.forBot(destBotId)
    const botContent = await sourceGhost.directoryListing('/')
    await Promise.all(
      botContent.map(async file => destGhost.upsertFile('/', file, await sourceGhost.readFileAsBuffer('/', file)))
    )
    // const workspaceId = await this.workspaceService.getBotWorkspaceId(sourceBotId)
    // await this.workspaceService.addBotRef(destBotId, workspaceId)
    await this.mountBot(destBotId)
  }

  async getBotTemplates(): Promise<any[]> {
    const builtinPath = getBuiltinPath('bot-templates')
    const templates = await fse.readdir(builtinPath)

    const detailed = await templates.map(id => {
      try {
        const details = require(path.join(builtinPath, id, 'bot.config.json'))
        return { id, name: details.name, desc: details.desc, moduleId: 'builtin', moduleName: 'Botpress Builtin' }
      } catch (err) {}
    })

    return detailed.filter(x => x !== undefined)
  }

  async makeBotId(botId: string, workspaceId: string) {
    const workspace = await this.workspaceService.findWorkspace(workspaceId)
    return workspace?.botPrefix ? `${workspace.botPrefix}__${botId}` : botId
  }

  async addBot(bot: BotConfig, botTemplate: BotTemplate): Promise<void> {
    const { error } = Joi.validate(bot, BotCreationSchema)
    if (error) {
      throw new InvalidOperationError(`An error occurred while creating the bot: ${error.message}`)
    }

    const mergedConfigs = await this._createBotFromTemplate(bot, botTemplate)
    if (mergedConfigs) {
      if (!mergedConfigs.disabled) {
        await coreActions.onBotCreation(bot.id)
      }

      this._invalidateBotIds()
    }
  }

  private async _createBotFromTemplate(botConfig: BotConfig, template: BotTemplate): Promise<BotConfig | undefined> {
    const templatePath = path.resolve(getBuiltinPath('bot-templates'), template.id)
    const templateConfigPath = path.resolve(templatePath, BOT_CONFIG_FILENAME)

    try {
      const scopedGhost = this.ghostService.forBot(botConfig.id)
      const files = await this._loadBotTemplateFiles(templatePath)

      if (!(await fse.pathExists(templateConfigPath))) {
        throw new Error("Bot template doesn't exist")
      }

      const templateConfig = JSON.parse(await fse.readFile(templateConfigPath, 'utf-8'))
      const mergedConfigs = {
        ...DEFAULT_BOT_CONFIGS,
        ...templateConfig,
        ...botConfig,
        version: process.BOTPRESS_VERSION
      }

      if (!mergedConfigs.imports.contentTypes) {
        const allContentTypes = await this.cms.getAllContentTypes()
        mergedConfigs.imports.contentTypes = allContentTypes.map(x => x.id)
      }

      if (!mergedConfigs.defaultLanguage) {
        mergedConfigs.disabled = true
      }

      await scopedGhost.upsertFile('/', BOT_CONFIG_FILENAME, stringify(mergedConfigs))
      await scopedGhost.upsertFiles('/', files)

      return mergedConfigs
    } catch (err) {
      this.logger
        .forBot(botConfig.id)
        .attachError(err)
        .error(`Error creating bot ${botConfig.id} from template "${template.name}"`)
    }
  }

  private async _loadBotTemplateFiles(templatePath: string): Promise<FileContent[]> {
    const startsWithADot = /^\./gm
    const templateFiles = await listDir(templatePath, [startsWithADot, new RegExp(BOT_CONFIG_FILENAME)])

    return templateFiles.map(
      f =>
        <FileContent>{
          name: f.relativePath,
          content: fse.readFileSync(f.absolutePath)
        }
    )
  }

  public async migrateBotContent(botId: string): Promise<void> {
    if (botId) {
      const config = await this.configProvider.getBotConfig(botId)
      return this.migrationService.botMigration.executeMissingBotMigrations(botId, config.version)
    }

    for (const bot of await this.getBotsIds()) {
      const config = await this.configProvider.getBotConfig(bot)
      await this.migrationService.botMigration.executeMissingBotMigrations(bot, config.version)
    }
  }

  async addLocalBotActions(botId: string, flowActions: string[]) {
    const botActions = await this.ghostService.forBot(botId).directoryListing('actions', '*.*')

    const missingLocalActions = flowActions
      .filter(x => !IGNORED_ACTION.includes(x))
      .map(x => `${x}.js`)
      .filter(x => !botActions.find(b => x === b))

    for (const actionName of missingLocalActions) {
      const builtinActionsPath = path.resolve(getBuiltinPath('actions'), actionName)
      let content

      if (await this.ghostService.global().fileExists('actions', actionName)) {
        content = await this.ghostService.global().readFileAsBuffer('actions', actionName)
      } else if (await fse.pathExists(builtinActionsPath)) {
        content = await fse.readFile(builtinActionsPath)
      }

      if (content) {
        await this.ghostService.forBot(botId).upsertFile('actions', actionName, content)
      }
    }
  }

  public async botExists(botId: string, ignoreCache?: boolean): Promise<boolean> {
    return (await this.getBotsIds(ignoreCache)).includes(botId)
  }

  @WrapErrorsWith(args => `Could not delete bot '${args[0]}'`, { hideStackTrace: true })
  async deleteBot(botId: string) {
    if (!(await this.botExists(botId))) {
      throw new Error(`Bot "${botId}" doesn't exist`)
    }

    await this.unmountBot(botId)
    await this.ghostService.forBot(botId).deleteFolder('/')
    this._invalidateBotIds()
  }

  public isBotMounted(botId: string): boolean {
    return BotService._mountedBots.get(botId) || false
  }

  async localMount(botId: string): Promise<boolean> {
    const startTime = Date.now()
    if (this.isBotMounted(botId)) {
      return true
    }

    if (!(await this.ghostService.forBot(botId).fileExists('/', 'bot.config.json'))) {
      this.logger
        .forBot(botId)
        .error(`Cannot mount bot "${botId}". Make sure it exists on the filesystem or the database.`)
      return false
    }

    try {
      const config = await this.configProvider.getBotConfig(botId)
      if (!config.languages.includes(config.defaultLanguage)) {
        throw new Error('Supported languages must include the default language of the bot')
      }

      await this.migrateBotContent(botId)

      await this.cms.loadElementsForBot(botId)

      BotService._mountedBots.set(botId, true)
      this._invalidateBotIds()

      // Call the BP client to check if bots must be trained, until the logic is moved on the studio
      this._trainWatchers[botId] = this.ghostService.forBot(botId).onFileChanged(async filePath => {
        const hasPotentialNLUChange = filePath.includes('/intents/') || filePath.includes('/entities/')
        if (!hasPotentialNLUChange) {
          return
        }

        await coreActions.checkForDirtyModels(botId)
      })

      return true
    } catch (err) {
      this.logger
        .forBot(botId)
        .attachError(err)
        .critical(`Cannot mount bot "${botId}"`)

      return false
    } finally {
      debug.forBot(botId, `Mount took ${Date.now() - startTime}ms`)
    }
  }

  async localUnmount(botId: string) {
    const startTime = Date.now()
    if (!this.isBotMounted(botId)) {
      this._invalidateBotIds()
      return
    }

    await this.cms.clearElementsFromCache(botId)

    BotService._mountedBots.set(botId, false)

    this._invalidateBotIds()
    this._trainWatchers[botId]?.remove()
    debug.forBot(botId, `Unmount took ${Date.now() - startTime}ms`)
  }

  private _invalidateBotIds(): void {
    this._botIds = undefined
  }

  public static getMountedBots() {
    const bots: string[] = []
    BotService._mountedBots.forEach((isMounted, bot) => isMounted && bots.push(bot))
    return bots
  }
}
