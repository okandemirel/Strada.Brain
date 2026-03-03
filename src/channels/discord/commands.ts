/**
 * Discord Slash Command Definitions
 * 
 * This module defines all slash commands for the Strata Brain Discord bot
 * and provides a registration helper.
 */

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";

/**
 * Represents a slash command with its handler.
 */
export interface SlashCommand {
  /** The command definition - can be SlashCommandBuilder or JSON data */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  /** Handler function for the command */
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

/**
 * /ask command - Ask Strata Brain a question
 */
export const askCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Strata Brain a question about your Unity project")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("What would you like to ask?")
        .setRequired(true)
        .setMaxLength(2000)
    )
    .addBooleanOption((option) =>
      option
        .setName("stream")
        .setDescription("Stream the response (shows typing effect)")
        .setRequired(false)
    ),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("ask command should be handled by DiscordChannel");
  },
};

/**
 * /analyze command - Analyze project structure
 */
export const analyzeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("analyze")
    .setDescription("Analyze your Unity/Strata.Core project structure")
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription("What to analyze")
        .setRequired(false)
        .addChoices(
          { name: "Full Project", value: "full" },
          { name: "Modules Only", value: "modules" },
          { name: "Systems Only", value: "systems" },
          { name: "Components Only", value: "components" },
          { name: "Dependencies", value: "dependencies" }
        )
    ),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("analyze command should be handled by DiscordChannel");
  },
};

/**
 * /generate command - Generate Strata code
 */
export const generateCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("generate")
    .setDescription("Generate a module, system, component, or mediator")
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("What to generate")
        .setRequired(true)
        .addChoices(
          { name: "Module", value: "module" },
          { name: "System", value: "system" },
          { name: "Component", value: "component" },
          { name: "Mediator", value: "mediator" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Name for the generated item")
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("Description or additional details")
        .setRequired(false)
        .setMaxLength(500)
    )
    .addStringOption((option) =>
      option
        .setName("namespace")
        .setDescription("C# namespace (optional)")
        .setRequired(false)
        .setMaxLength(200)
    ),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("generate command should be handled by DiscordChannel");
  },
};

/**
 * /status command - Show system status
 */
export const statusCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show Strata Brain system status and health"),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("status command should be handled by DiscordChannel");
  },
};

/**
 * /help command - Show help information
 */
export const helpCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help information about Strata Brain"),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("help command should be handled by DiscordChannel");
  },
};

/**
 * /search command - Search code or documentation
 */
export const searchCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search your project code or documentation")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("What to search for")
        .setRequired(true)
        .setMaxLength(500)
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Search type")
        .setRequired(false)
        .addChoices(
          { name: "Code", value: "code" },
          { name: "Documentation", value: "docs" },
          { name: "Files", value: "files" },
          { name: "All", value: "all" }
        )
    ),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("search command should be handled by DiscordChannel");
  },
};

/**
 * /thread command - Create a discussion thread
 */
export const threadCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("thread")
    .setDescription("Create a thread for detailed discussion")
    .addStringOption((option) =>
      option
        .setName("topic")
        .setDescription("Topic for the thread")
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption((option) =>
      option
        .setName("initial_message")
        .setDescription("Initial message to start the discussion")
        .setRequired(false)
        .setMaxLength(500)
    ),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("thread command should be handled by DiscordChannel");
  },
};

/**
 * Admin command: /reload - Reload bot configuration
 * Requires Administrator permission
 */
export const reloadCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("reload")
    .setDescription("Reload Strata Brain configuration (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async (_interaction) => {
    // Handled in DiscordChannel
    throw new Error("reload command should be handled by DiscordChannel");
  },
};

/**
 * Get all default slash commands.
 */
export function getDefaultSlashCommands(): SlashCommand[] {
  return [
    askCommand,
    analyzeCommand,
    generateCommand,
    statusCommand,
    helpCommand,
    searchCommand,
    threadCommand,
  ];
}

/**
 * Get all slash commands including admin commands.
 */
export function getAllSlashCommands(): SlashCommand[] {
  return [...getDefaultSlashCommands(), reloadCommand];
}

/**
 * Find a command by name.
 */
export function findCommand(
  commands: SlashCommand[],
  name: string
): SlashCommand | undefined {
  return commands.find((cmd) => cmd.data.name === name);
}

/**
 * Register slash commands with Discord.
 * This should be called after the bot is logged in.
 * 
 * @param token - Bot token
 * @param clientId - Application client ID
 * @param commands - Commands to register
 * @param guildId - Optional guild ID for guild-specific commands (faster for development)
 */
export async function registerSlashCommands(
  token: string,
  clientId: string,
  commands: SlashCommand[],
  guildId?: string
): Promise<void> {
  const { REST, Routes } = await import("discord.js");
  const rest = new REST({ version: "10" }).setToken(token);

  const commandsData = commands.map((cmd) => cmd.data.toJSON());

  try {
    if (guildId) {
      // Register guild-specific commands
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commandsData }
      );
    } else {
      // Register global commands
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commandsData }
      );
    }
  } catch (error) {
    throw new Error(
      `Failed to register slash commands: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Unregister all slash commands.
 * Useful for cleaning up during development.
 */
export async function unregisterSlashCommands(
  token: string,
  clientId: string,
  guildId?: string
): Promise<void> {
  const { REST, Routes } = await import("discord.js");
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: [] }
      );
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: [] }
      );
    }
  } catch (error) {
    throw new Error(
      `Failed to unregister slash commands: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
