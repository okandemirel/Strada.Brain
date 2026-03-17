/**
 * Slack slash command handlers for Strada Brain.
 * Provides /strada-* commands for quick access to common operations.
 */

import type { App, AckFn, RespondFn } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getLogger } from "../../utils/logger.js";
import { createHelpBlocks, createProcessingBlock } from "./blocks.js";
import type { IncomingMessage } from "../channel.interface.js";
import { limitIncomingText } from "../channel-messages.interface.js";

const logger = getLogger();

interface SlashCommandAuthConfig {
  allowedWorkspaces?: string[];
  allowedUserIds?: string[];
}

interface CommandContext {
  ack: AckFn<string | Record<string, unknown>>;
  respond: RespondFn;
  client: WebClient;
  userId: string;
  channelId: string;
  teamId: string;
  triggerId?: string;
  text: string;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

type RouteMessageFn = (msg: IncomingMessage) => Promise<void>;

/**
 * Register all slash commands with the Slack app.
 */
export function registerSlashCommands(
  app: App,
  authConfig?: SlashCommandAuthConfig,
  routeMessage?: RouteMessageFn
): void {
  // /strada-help - Show help information
  app.command("/strada-help", async ({ ack, respond, client, body }) => {
    await handleCommand({
      ack,
      respond,
      client,
      userId: body.user_id,
      channelId: body.channel_id,
      teamId: body.team_id,
      triggerId: body.trigger_id,
      text: body.text,
    }, handleHelpCommand, authConfig);
  });

  // /strada-ask - Ask a question to the AI
  app.command("/strada-ask", async ({ ack, respond, client, body }) => {
    await handleCommand({
      ack,
      respond,
      client,
      userId: body.user_id,
      channelId: body.channel_id,
      teamId: body.team_id,
      triggerId: body.trigger_id,
      text: body.text,
    }, handleAskCommand, authConfig);
  });

  // /strada-analyze - Analyze code or project
  app.command("/strada-analyze", async ({ ack, respond, client, body }) => {
    await handleCommand({
      ack,
      respond,
      client,
      userId: body.user_id,
      channelId: body.channel_id,
      teamId: body.team_id,
      triggerId: body.trigger_id,
      text: body.text,
    }, handleAnalyzeCommand, authConfig);
  });

  // /strada-generate - Generate code (component, system, etc.)
  app.command("/strada-generate", async ({ ack, respond, client, body }) => {
    await handleCommand({
      ack,
      respond,
      client,
      userId: body.user_id,
      channelId: body.channel_id,
      teamId: body.team_id,
      triggerId: body.trigger_id,
      text: body.text,
    }, handleGenerateCommand, authConfig);
  });

  // /strada-autonomous - Toggle autonomous mode
  app.command("/strada-autonomous", async ({ ack, respond, client, body }) => {
    await handleCommand({
      ack,
      respond,
      client,
      userId: body.user_id,
      channelId: body.channel_id,
      teamId: body.team_id,
      triggerId: body.trigger_id,
      text: body.text,
    }, (ctx) => handleAutonomousCommand(ctx, routeMessage), authConfig);
  });

  // /strada-model - Switch AI model provider
  app.command("/strada-model", async ({ ack, respond, client, body }) => {
    await handleCommand({
      ack,
      respond,
      client,
      userId: body.user_id,
      channelId: body.channel_id,
      teamId: body.team_id,
      triggerId: body.trigger_id,
      text: body.text,
    }, (ctx) => handleModelCommand(ctx, routeMessage), authConfig);
  });

  logger.info("Slash commands registered");
}

/**
 * Wrapper for command handling with auth checks and common error handling.
 */
async function handleCommand(
  ctx: CommandContext,
  handler: CommandHandler,
  authConfig?: SlashCommandAuthConfig
): Promise<void> {
  try {
    // Auth check: verify workspace
    if (!isValidWorkspace(ctx.teamId, authConfig?.allowedWorkspaces ?? [])) {
      logger.warn("Slash command from unauthorized workspace", {
        teamId: ctx.teamId,
        userId: ctx.userId,
        command: handler.name,
      });
      await ctx.ack({
        text: "This workspace is not authorized to use Strada Brain.",
        response_type: "ephemeral",
      });
      return;
    }

    // Auth check: verify user
    if (!isValidUser(ctx.userId, authConfig?.allowedUserIds ?? [])) {
      logger.warn("Slash command from unauthorized user", {
        userId: ctx.userId,
        teamId: ctx.teamId,
        command: handler.name,
      });
      await ctx.ack({
        text: "You are not authorized to use Strada Brain.",
        response_type: "ephemeral",
      });
      return;
    }

    await handler(ctx);
  } catch (error) {
    logger.error("Slash command error", { 
      error: error instanceof Error ? error.message : String(error),
      command: handler.name,
      userId: ctx.userId 
    });

    try {
      await ctx.respond({
        text: "❌ An error occurred while processing your command. Please try again.",
        response_type: "ephemeral",
      });
    } catch {
      // Ignore respond errors
    }
  }
}

/**
 * Handle /strada-help command.
 */
async function handleHelpCommand(ctx: CommandContext): Promise<void> {
  await ctx.ack();

  const helpText = `
*🧠 Strada Brain - Available Commands*

*/strada-help* - Show this help message
*/strada-ask <question>* - Ask the AI a question
*/strada-analyze <file|project>* - Analyze code or project structure
*/strada-generate <type> <name>* - Generate Strada.Core code
*/strada-autonomous <action>* - Toggle autonomous mode
*/strada-model <action>* - Switch AI model provider

*Generation Types:*
• \`component <Name>\` - Create a Component class
• \`mediator <Name>\` - Create a Mediator class
• \`system <Name>\` - Create a System class
• \`module <Name>\` - Create a Module structure

*Autonomous Mode:*
• \`/strada-autonomous on [hours]\` - Enable autonomous mode
• \`/strada-autonomous off\` - Disable autonomous mode
• \`/strada-autonomous status\` - Check current status

*Model Selection:*
• \`/strada-model list\` - List available model providers
• \`/strada-model <provider>\` - Switch to a specific provider
• \`/strada-model reset\` - Reset to default model

*Examples:*
\`/strada-ask How do I create a new enemy system?\`
\`/strada-analyze Assets/Scripts/PlayerController.cs\`
\`/strada-generate component PlayerHealth\`
\`/strada-autonomous on 24\`
\`/strada-model openai\`
`;

  await ctx.respond({
    blocks: createHelpBlocks(),
    text: helpText, // Fallback text
    response_type: "ephemeral",
  });
}

/**
 * Handle /strada-ask command.
 */
async function handleAskCommand(ctx: CommandContext): Promise<void> {
  const question = ctx.text.trim();

  if (!question) {
    await ctx.ack({
      text: "Please provide a question. Example: `/strada-ask How do I create a new component?`",
      response_type: "ephemeral",
    });
    return;
  }

  await ctx.ack();

  // Send processing indicator
  await ctx.respond({
    blocks: createProcessingBlock(`Processing your question: "${escapeText(question.substring(0, 100))}"...`),
    response_type: "in_channel",
  });

  // The actual processing will be handled by the message handler
  // This just confirms the command was received
  // The response will come through the normal message flow
}

/**
 * Handle /strada-analyze command.
 */
async function handleAnalyzeCommand(ctx: CommandContext): Promise<void> {
  const target = ctx.text.trim();

  if (!target) {
    await ctx.ack({
      text: "Please specify what to analyze. Examples:\n• `/strada-analyze project` - Analyze entire project\n• `/strada-analyze Assets/Scripts/Player.cs` - Analyze specific file",
      response_type: "ephemeral",
    });
    return;
  }

  await ctx.ack();

  const isProject = target.toLowerCase() === "project";
  const action = isProject ? "Analyzing project structure..." : `Analyzing \`${escapeText(target)}\`...`;

  await ctx.respond({
    blocks: createProcessingBlock(action),
    response_type: "in_channel",
  });
}

/**
 * Handle /strada-generate command.
 */
async function handleGenerateCommand(ctx: CommandContext): Promise<void> {
  const args = ctx.text.trim().split(/\s+/);

  if (args.length < 2) {
    await ctx.ack({
      text: `Usage: \`/strada-generate <type> <name>\`

Available types:
• \`component <Name>\` - Create a Component
• \`mediator <Name>\` - Create a Mediator  
• \`system <Name>\` - Create a System
• \`module <Name>\` - Create a Module

Example: \`/strada-generate component PlayerHealth\``,
      response_type: "ephemeral",
    });
    return;
  }

  const type = args[0];
  const nameParts = args.slice(1);
  const name = nameParts.join(" ");

  if (!type) {
    await ctx.ack({
      text: "Type is required",
      response_type: "ephemeral",
    });
    return;
  }

  const validTypes = ["component", "mediator", "system", "module"];
  
  if (!validTypes.includes(type.toLowerCase())) {
    await ctx.ack({
      text: `Invalid type "${escapeText(type)}". Valid types: ${validTypes.join(", ")}`,
      response_type: "ephemeral",
    });
    return;
  }

  await ctx.ack();

  await ctx.respond({
    blocks: createProcessingBlock(`Generating ${escapeText(type)} \`${escapeText(name)}\`...`),
    response_type: "in_channel",
  });
}

/**
 * Handle /strada-autonomous command.
 * Converts to /autonomous <args> and routes to message handler.
 */
async function handleAutonomousCommand(ctx: CommandContext, routeMessage?: RouteMessageFn): Promise<void> {
  const args = ctx.text.trim();

  await ctx.ack();

  const commandText = `/autonomous${args ? ` ${args}` : ""}`;

  if (routeMessage) {
    const msg: IncomingMessage = {
      channelType: "slack",
      chatId: ctx.channelId,
      userId: ctx.userId,
      text: limitIncomingText(commandText),
      timestamp: new Date(),
    };

    await routeMessage(msg);
  } else {
    await ctx.respond({
      blocks: createProcessingBlock(`Processing autonomous command: "${escapeText(args || "status")}"`),
      response_type: "ephemeral",
    });
  }
}

/**
 * Handle /strada-model command.
 * Converts to /model <args> and routes to message handler.
 */
async function handleModelCommand(ctx: CommandContext, routeMessage?: RouteMessageFn): Promise<void> {
  const args = ctx.text.trim();

  await ctx.ack();

  const commandText = `/model${args ? ` ${args}` : ""}`;

  if (routeMessage) {
    const msg: IncomingMessage = {
      channelType: "slack",
      chatId: ctx.channelId,
      userId: ctx.userId,
      text: limitIncomingText(commandText),
      timestamp: new Date(),
    };

    await routeMessage(msg);
  } else {
    await ctx.respond({
      blocks: createProcessingBlock(`Processing model command: "${escapeText(args || "list")}"`),
      response_type: "ephemeral",
    });
  }
}

/**
 * Create a modal for complex workflows.
 */
export async function openGenerateModal(
  client: WebClient,
  triggerId: string,
  callbackId: string
): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: callbackId,
      title: {
        type: "plain_text",
        text: "Generate Code",
      },
      submit: {
        type: "plain_text",
        text: "Generate",
      },
      close: {
        type: "plain_text",
        text: "Cancel",
      },
      blocks: [
        {
          type: "input",
          block_id: "type_input",
          element: {
            type: "static_select",
            action_id: "type_select",
            placeholder: {
              type: "plain_text",
              text: "Select type...",
            },
            options: [
              { text: { type: "plain_text", text: "Component" }, value: "component" },
              { text: { type: "plain_text", text: "Mediator" }, value: "mediator" },
              { text: { type: "plain_text", text: "System" }, value: "system" },
              { text: { type: "plain_text", text: "Module" }, value: "module" },
            ],
          },
          label: {
            type: "plain_text",
            text: "Type",
          },
        },
        {
          type: "input",
          block_id: "name_input",
          element: {
            type: "plain_text_input",
            action_id: "name_text",
            placeholder: {
              type: "plain_text",
              text: "e.g., PlayerHealth",
            },
          },
          label: {
            type: "plain_text",
            text: "Name",
          },
        },
        {
          type: "input",
          block_id: "namespace_input",
          element: {
            type: "plain_text_input",
            action_id: "namespace_text",
            placeholder: {
              type: "plain_text",
              text: "e.g., MyGame.Player",
            },
            initial_value: "MyProject",
          },
          label: {
            type: "plain_text",
            text: "Namespace (optional)",
          },
          optional: true,
        },
        {
          type: "input",
          block_id: "description_input",
          element: {
            type: "plain_text_input",
            action_id: "description_text",
            placeholder: {
              type: "plain_text",
              text: "Brief description of what this should do...",
            },
            multiline: true,
          },
          label: {
            type: "plain_text",
            text: "Description (optional)",
          },
          optional: true,
        },
      ],
    },
  });
}

/**
 * Parse a command string into type and arguments.
 */
export function parseCommand(text: string): { type: string; args: string[] } | null {
  const parts = text.trim().split(/\s+/);
  
  if (parts.length === 0) {
    return null;
  }

  // Remove the command prefix if present
  const command = parts[0]!.replace(/^\//, "");
  const args = parts.slice(1);

  return { type: command, args };
}

/**
 * Escape special characters for Slack text.
 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Validate workspace membership.
 * Empty allowlists mean "no restriction" to match the Slack message handler path.
 */
export function isValidWorkspace(teamId: string, allowedWorkspaces: string[]): boolean {
  if (allowedWorkspaces.length === 0) {
    return true;
  }
  return allowedWorkspaces.includes(teamId);
}

/**
 * Validate user access.
 * Empty allowlists mean "no restriction" to match the Slack message handler path.
 */
export function isValidUser(userId: string, allowedUsers: string[]): boolean {
  if (allowedUsers.length === 0) {
    return true;
  }
  return allowedUsers.includes(userId);
}
