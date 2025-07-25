import { PostgrestQueryBuilder } from "@supabase/postgrest-js";
import { SupabaseClient } from "@supabase/supabase-js";
import { GenericSchema } from "@supabase/supabase-js/dist/module/lib/types";
import { generateText, Message, OnLLMResponse, streamChatGPT } from "../core/controller/AIController";
import { generateObject, ObjectRequest } from "../core/controller/ObjectController";
import { SettingsController, UserInfo } from "../core/controller/SettingsController";
import { SharedContent, SharedContentController, SharedContentFilter, SharedContentObjectRequest } from "../core/controller/SharedContentController";
import { getSTTResponse, getTTSResponse } from "../core/controller/VoiceController";
import { EventBus, EventBusMessage, EventHandler, EventPayload } from "../fromRimori/EventBus";
import { Plugin, Tool } from "../fromRimori/PluginTypes";
import { AccomplishmentHandler, AccomplishmentPayload } from "./AccomplishmentHandler";
import { PluginController, RimoriInfo } from "./PluginController";


interface Db {
  from: {
    <TableName extends string & keyof GenericSchema['Tables'], Table extends GenericSchema['Tables'][TableName]>(relation: TableName): PostgrestQueryBuilder<GenericSchema, Table, TableName>;
    <ViewName extends string & keyof GenericSchema['Views'], View extends GenericSchema['Views'][ViewName]>(relation: ViewName): PostgrestQueryBuilder<GenericSchema, View, ViewName>;
  };
  storage: SupabaseClient["storage"];

  // functions: SupabaseClient["functions"];
  /**
   * The table prefix for of database tables of the plugin.
   */
  tablePrefix: string;
  /**
   * Get the table name for a given plugin table.
   * Internally all tables are prefixed with the plugin id. This function is used to get the correct table name for a given public table.
   * @param table The plugin table name to get the full table name for.
   * @returns The full table name.
   */
  getTableName: (table: string) => string;
}

interface PluginInterface {
  pluginId: string;
  setSettings: (settings: any) => Promise<void>;
  /**
   * Get the settings for the plugin. T can be any type of settings, UserSettings or SystemSettings.
   * @param defaultSettings The default settings to use if no settings are found.
   * @param genericSettings The type of settings to get.
   * @returns The settings for the plugin. 
   */
  getSettings: <T extends object>(defaultSettings: T) => Promise<T>;
  /**
  * Fetches all installed plugins.
  * @returns A promise that resolves to an array of plugins
  */
  getInstalled: () => Promise<Plugin[]>;
  getUserInfo: () => Promise<UserInfo>;
}

export class RimoriClient {
  private static instance: RimoriClient;
  private superbase: SupabaseClient;
  private pluginController: PluginController;
  private settingsController: SettingsController;
  private sharedContentController: SharedContentController;
  private accomplishmentHandler: AccomplishmentHandler;
  private supabaseUrl: string;
  private installedPlugins: Plugin[];
  private profile: UserInfo;
  public plugin: PluginInterface;
  public db: Db;

  private constructor(supabase: SupabaseClient, info: RimoriInfo, pluginController: PluginController) {
    this.superbase = supabase;
    this.pluginController = pluginController;
    this.settingsController = new SettingsController(supabase, info.pluginId);
    this.sharedContentController = new SharedContentController(this.superbase, this);
    this.supabaseUrl = this.pluginController.getSupabaseUrl();
    this.accomplishmentHandler = new AccomplishmentHandler(info.pluginId);
    this.installedPlugins = info.installedPlugins;
    this.profile = info.profile;

    this.from = this.from.bind(this);

    this.db = {
      from: this.from,
      storage: this.superbase.storage,
      // functions: this.superbase.functions,
      tablePrefix: info.tablePrefix,
      getTableName: this.getTableName.bind(this),
    }
    this.plugin = {
      pluginId: info.pluginId,
      setSettings: async (settings: any) => {
        await this.settingsController.setSettings(settings);
      },
      getSettings: async <T extends object>(defaultSettings: T): Promise<T> => {
        return await this.settingsController.getSettings<T>(defaultSettings);
      },
      getInstalled: async (): Promise<Plugin[]> => {
        return this.installedPlugins;
      },
      getUserInfo: async (): Promise<UserInfo> => {
        return this.profile;
      }
    }
  }

  public event = {
    /**
     * Emit an event to Rimori or a plugin. 
     * The topic schema is:
     * {pluginId}.{eventId}
     * Check out the event bus documentation for more information.
     * For triggering events from Rimori like context menu actions use the "global" keyword.
     * @param topic The topic to emit the event on.
     * @param data The data to emit.
     * @param eventId The event id.
     */
    emit: (topic: string, data?: any, eventId?: number) => {
      const globalTopic = this.pluginController.getGlobalEventTopic(topic);
      EventBus.emit(this.plugin.pluginId, globalTopic, data, eventId);
    },
    /**
     * Request an event.
     * @param topic The topic to request the event on.
     * @param data The data to request.
     * @returns The response from the event.
     */
    request: <T>(topic: string, data?: any): Promise<EventBusMessage<T>> => {
      const globalTopic = this.pluginController.getGlobalEventTopic(topic);
      return EventBus.request<T>(this.plugin.pluginId, globalTopic, data);
    },
    /**
     * Subscribe to an event.
     * @param topic The topic to subscribe to.
     * @param callback The callback to call when the event is emitted.
     * @returns An EventListener object containing an off() method to unsubscribe the listeners.
     */
    on: <T = EventPayload>(topic: string | string[], callback: EventHandler<T>) => {
      const topics = Array.isArray(topic) ? topic : [topic];
      return EventBus.on<T>(topics.map(t => this.pluginController.getGlobalEventTopic(t)), callback);
    },
    /**
     * Subscribe to an event once.
     * @param topic The topic to subscribe to.
     * @param callback The callback to call when the event is emitted.
     */
    once: <T = EventPayload>(topic: string, callback: EventHandler<T>) => {
      EventBus.once<T>(this.pluginController.getGlobalEventTopic(topic), callback);
    },
    /**
     * Respond to an event.
     * @param topic The topic to respond to.
     * @param data The data to respond with.
     */
    respond: <T = EventPayload>(topic: string | string[], data: EventPayload | ((data: EventBusMessage<T>) => EventPayload | Promise<EventPayload>)) => {
      const topics = Array.isArray(topic) ? topic : [topic];
      EventBus.respond(this.plugin.pluginId, topics.map(t => this.pluginController.getGlobalEventTopic(t)), data);
    },
    /**
     * Emit an accomplishment.
     * @param payload The payload to emit.
     */
    emitAccomplishment: (payload: AccomplishmentPayload) => {
      this.accomplishmentHandler.emitAccomplishment(payload);
    },
    /**
     * Subscribe to an accomplishment.
     * @param accomplishmentTopic The topic to subscribe to.
     * @param callback The callback to call when the accomplishment is emitted.
     */
    onAccomplishment: (accomplishmentTopic: string, callback: (payload: EventBusMessage<AccomplishmentPayload>) => void) => {
      this.accomplishmentHandler.subscribe(accomplishmentTopic, callback);
    },
    /**
     * Trigger an action that opens the sidebar and triggers an action in the designated plugin.
     * @param pluginId The id of the plugin to trigger the action for.
     * @param actionKey The key of the action to trigger.
     * @param text Optional text to be used for the action like for example text that the translator would look up.
     */
    emitSidebarAction: (pluginId: string, actionKey: string, text?: string) => {
      this.event.emit("global.sidebar.triggerAction", { plugin_id: pluginId, action_key: actionKey, text });
    }
  }

  public navigation = {
    toDashboard: () => {
      this.event.emit("global.navigation.triggerToDashboard");
    }
  }

  public static async getInstance(pluginController: PluginController): Promise<RimoriClient> {
    if (!RimoriClient.instance) {
      const client = await pluginController.getClient();
      RimoriClient.instance = new RimoriClient(client.supabase, client.info, pluginController);
    }
    return RimoriClient.instance;
  }

  private from<
    TableName extends string & keyof GenericSchema['Tables'],
    Table extends GenericSchema['Tables'][TableName]
  >(relation: TableName): PostgrestQueryBuilder<GenericSchema, Table, TableName>
  private from<
    ViewName extends string & keyof GenericSchema['Views'],
    View extends GenericSchema['Views'][ViewName]
  >(relation: ViewName): PostgrestQueryBuilder<GenericSchema, View, ViewName>
  private from(relation: string): PostgrestQueryBuilder<GenericSchema, any, any> {
    return this.superbase.from(this.getTableName(relation));
  }

  private getTableName(type: string) {
    if (type.startsWith("global_")) {
      return type.replace("global_", "");
    }
    return this.db.tablePrefix + "_" + type;
  }

  public ai = {
    getText: async (messages: Message[], tools?: Tool[]): Promise<string> => {
      const token = await this.pluginController.getToken();
      return generateText(this.pluginController.getBackendUrl(), messages, tools || [], token).then(({ messages }) => messages[0].content[0].text);
    },
    getSteamedText: async (messages: Message[], onMessage: OnLLMResponse, tools?: Tool[]) => {
      const token = await this.pluginController.getToken();
      streamChatGPT(this.pluginController.getBackendUrl(), messages, tools || [], onMessage, token);
    },
    getVoice: async (text: string, voice = "alloy", speed = 1, language?: string): Promise<Blob> => {
      const token = await this.pluginController.getToken();
      return getTTSResponse(this.supabaseUrl, { input: text, voice, speed, language }, token);
    },
    getTextFromVoice: (file: Blob): Promise<string> => {
      return getSTTResponse(this.superbase, file);
    },
    getObject: async (request: ObjectRequest): Promise<any> => {
      const token = await this.pluginController.getToken();
      return generateObject(this.pluginController.getBackendUrl(), request, token);
    },
    // getSteamedObject: this.generateObjectStream,
  }

  public community = {
    /**
     * Shared content is a way to share completable content with other users using this plugin.
     * Typical examples are assignments, exercises, stories, etc.
     * Users generate new shared content items and others can complete the content too.
     */
    sharedContent: {
      /**
       * Get one dedicated shared content item by id. It does not matter if it is completed or not.
       * @param contentType The type of shared content to get. E.g. assignments, exercises, etc.
       * @param id The id of the shared content item.
       * @returns The shared content item.
       */
      get: async <T = any>(contentType: string, id: string): Promise<SharedContent<T>> => {
        return await this.sharedContentController.getSharedContent(contentType, id);
      },
      /**
       * Get a list of shared content items.
       * @param contentType The type of shared content to get. E.g. assignments, exercises, etc.
       * @param filter The optional additional filter for checking new shared content based on a column and value. This is useful if the aditional information stored on the shared content is used to further narrow down the kind of shared content wanted to be received. E.g. only adjective grammar exercises.
       * @param limit The optional limit for the number of results.
       * @returns The list of shared content items.
       */
      getList: async <T = any>(contentType: string, filter?: SharedContentFilter, limit?: number): Promise<SharedContent<T>[]> => {
        return await this.sharedContentController.getSharedContentList(contentType, filter, limit);
      },
      /**
       * Get new shared content.
       * @param contentType The type of shared content to fetch. E.g. assignments, exercises, etc.
       * @param generatorInstructions The instructions for the creation of new shared content. The object will automatically be extended with a tool property with a topic and keywords property to let a new unique topic be generated.
       * @param filter The optional additional filter for checking new shared content based on a column and value. This is useful if the aditional information stored on the shared content is used to further narrow down the kind of shared content wanted to be received. E.g. only adjective grammar exercises.
       * @param privateTopic An optional flag to indicate if the topic should be private and only be visible to the user. This is useful if the topic is not meant to be shared with other users. Like for personal topics or if the content is based on the personal study goal.
       * @returns The new shared content.
       */
      getNew: async <T = any>(
        contentType: string,
        generatorInstructions: SharedContentObjectRequest,
        filter?: SharedContentFilter,
        privateTopic?: boolean,
      ): Promise<SharedContent<T>> => {
        return await this.sharedContentController.getNewSharedContent(contentType, generatorInstructions, filter, privateTopic);
      },
      /**
       * Create a new shared content item.
       * @param content The content to create.
       * @returns The new shared content item.
       */
      create: async <T = any>(content: Omit<SharedContent<T>, 'id'>): Promise<SharedContent<T>> => {
        return await this.sharedContentController.createSharedContent(content);
      },
      /**
       * Update a shared content item.
       * @param id The id of the shared content item to update.
       * @param content The content to update.
       * @returns The updated shared content item.
       */
      update: async <T = any>(id: string, content: Partial<SharedContent<T>>): Promise<SharedContent<T>> => {
        return await this.sharedContentController.updateSharedContent(id, content);
      },
      /**
        * Complete a shared content item.
        * @param contentType The type of shared content to complete. E.g. assignments, exercises, etc.
        * @param assignmentId The id of the shared content item to complete.
        */
      complete: async (contentType: string, assignmentId: string) => {
        return await this.sharedContentController.completeSharedContent(contentType, assignmentId);
      },
      /**
       * Remove a shared content item.
       * @param id The id of the shared content item to remove.
       * @returns The removed shared content item.
       */
      remove: async (id: string): Promise<SharedContent<any>> => {
        return await this.sharedContentController.removeSharedContent(id);
      }
    }
  }
}
